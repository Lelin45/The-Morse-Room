export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const one = (env, sql, ...values) => env.DB.prepare(sql).bind(...values).first();
export const all = async (env, sql, ...values) => (await env.DB.prepare(sql).bind(...values).all()).results;
export const run = (env, sql, ...values) => env.DB.prepare(sql).bind(...values).run();
export const batch = (env, statements) => env.DB.batch(statements.map(([sql, ...values]) => env.DB.prepare(sql).bind(...values)));

export function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const hashToken = async (value) => base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

export function siteURL(env) {
  try {
    const url = new URL(env.SITE_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url;
  } catch { return null; }
}

export function requireSite(env) {
  const url = siteURL(env);
  if (!url || !env.DB) throw new ApiError(503, 'chat_unavailable', 'Chat has not been configured on this site yet.');
  return url;
}

export function cookieName(env, suffix) {
  return `${siteURL(env)?.protocol === 'https:' ? '__Host-' : ''}morse_${suffix}`;
}

export function cookie(env, suffix, value, maxAge, sameSite = 'Lax') {
  const secure = siteURL(env)?.protocol === 'https:';
  return `${cookieName(env, suffix)}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function readCookie(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : null;
}

export function requireOrigin(request, env) {
  if (request.headers.get('Origin') !== requireSite(env).origin) {
    throw new ApiError(403, 'invalid_origin', 'This request must come from the Morse Room website.');
  }
}

export async function rateLimit(env, actor, maximum, seconds) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const row = await one(env, `INSERT INTO chat_rate_limits(actor, bucket, count, expires_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(actor, bucket) DO UPDATE SET count = count + 1 RETURNING count`, actor, bucket, Date.now() + (seconds + 60) * 1000);
  if (row.count > maximum) throw new ApiError(429, 'rate_limited', 'Please wait before trying again.');
}

export async function readBody(request, maximum = 8192) {
  if (Number(request.headers.get('Content-Length')) > maximum) throw new ApiError(413, 'body_too_large', 'This request is too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ApiError(413, 'body_too_large', 'This request is too large.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_body', 'This request contains invalid text.');
  } finally { reader.releaseLock(); }
}

export async function readJSON(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'json_required', 'Send this request as JSON.');
  }
  const text = await readBody(request);
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new ApiError(400, 'invalid_json', 'This request contains invalid JSON.'); }
}

export const pair = (first, second) => [first, second].sort();
export const pairKey = (first, second) => pair(first, second).join(':');
