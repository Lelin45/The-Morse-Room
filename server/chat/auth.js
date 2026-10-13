import { ApiError, decode64, randomToken, hashToken, siteURL, requireSite,
  cookie, cookieName, readCookie, one, run, batch, rateLimit } from './db.js';

const STATE_SECONDS = 600;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PROVIDERS = {
  google: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  },
};
const keysCache = new Map();

export function authProviders(env) {
  const available = Boolean(env.DB && siteURL(env));
  return {
    available,
    providers: {
      google: available && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
  };
}

function requireProvider(provider, env) {
  if (!Object.hasOwn(PROVIDERS, provider) || !authProviders(env).providers[provider]) {
    throw new ApiError(503, 'provider_unavailable', 'This sign-in option has not been configured yet.');
  }
}

function equal(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  let difference = first.length ^ second.length;
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function externalJSON(url, options = {}, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error('Provider rejected the request');
    const text = await response.text();
    if (text.length > 131072) throw new Error('Provider response too large');
    return JSON.parse(text);
  } catch { throw new ApiError(400, 'oauth_failed', 'Sign-in could not be completed. Please try again.'); }
  finally { clearTimeout(timeout); }
}

/** Verify only keys from the selected provider's fixed JWKS URL. */
export async function verifyIDToken(token, provider, audience, nonce, fetcher = fetch) {
  try {
    if (typeof token !== 'string' || token.length > 16384) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || !PROVIDERS[provider]) throw new Error();
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(decode64(parts[0])));
    const claims = JSON.parse(decoder.decode(decode64(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error();
    const source = PROVIDERS[provider];
    let cached = keysCache.get(source.jwks);
    if (!cached || cached.until <= Date.now() || !cached.keys.some((key) => key.kid === header.kid)) {
      const result = await externalJSON(source.jwks, {}, fetcher);
      if (!Array.isArray(result.keys) || result.keys.length > 20) throw new Error();
      cached = { keys: result.keys, until: Date.now() + 60 * 60 * 1000 };
      keysCache.set(source.jwks, cached);
    }
    const jwk = cached.keys.find((key) => key.kid === header.kid && (!key.use || key.use === 'sig')
      && (!key.alg || key.alg === header.alg) && key.kty === 'RSA');
    if (!jwk) throw new Error();
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
    const verified = await crypto.subtle.verify(algorithm, key, decode64(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!verified || !source.issuers.includes(claims.iss) || !audiences.includes(audience)
        || (audiences.length > 1 && claims.azp !== audience)
        || (claims.azp !== undefined && claims.azp !== audience)
        || !Number.isFinite(claims.exp) || claims.exp <= now
        || !Number.isFinite(claims.iat) || claims.iat > now + 120
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
        || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
        || !equal(claims.nonce, nonce)) throw new Error();
    return claims;
  } catch {
    throw new ApiError(400, 'invalid_id_token', 'The sign-in response could not be verified. Please try again.');
  }
}

export async function startOAuth(provider, request, env) {
  requireSite(env);
  requireProvider(provider, env);
  const params = new URL(request.url).searchParams;
  const mobileChallenge = params.get('mobile_challenge');
  const mobileState = params.get('mobile_state');
  const mobile = mobileChallenge !== null || mobileState !== null;
  if (mobile && (!/^[A-Za-z0-9_-]{43}$/.test(mobileChallenge || '')
      || !/^[A-Za-z0-9_-]{32,128}$/.test(mobileState || ''))) {
    throw new ApiError(400, 'invalid_mobile_request', 'Start sign-in again from the app.');
  }
  // Return paths are a fixed allowlist, never an arbitrary redirect URL.
  const returnPath = params.get('return') === 'delete-account' ? '/delete-account.html' : null;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(env, `oauth:${await hashToken(ip)}`, 30, 900);
  const state = randomToken();
  const binding = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await batch(env, [
    ['DELETE FROM chat_oauth_states WHERE expires_at <= ?', now],
    ['DELETE FROM chat_sessions WHERE expires_at <= ?', now],
    ['DELETE FROM chat_rate_limits WHERE expires_at <= ?', now],
    ['DELETE FROM chat_mobile_codes WHERE expires_at <= ?', now],
    ['INSERT INTO chat_oauth_states(state_hash, binding_hash, provider, nonce, verifier, expires_at, mobile_challenge, mobile_state, return_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      await hashToken(state), await hashToken(binding), provider, nonce, verifier, now + STATE_SECONDS * 1000,
      mobile ? mobileChallenge : null, mobile ? mobileState : null, returnPath],
  ]);
  const url = new URL(PROVIDERS[provider].authorization);
  const callback = new URL(`/api/auth/${provider}/callback`, requireSite(env)).href;
  const fields = {
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callback, response_type: 'code', state, nonce,
    scope: 'openid email profile',
    code_challenge: await hashToken(verifier), code_challenge_method: 'S256',
  };
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return new Response(null, { status: 302, headers: {
    Location: url.href,
    'Set-Cookie': cookie(env, `oauth_${provider}`, binding, STATE_SECONDS),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

export function clearOAuthCookie(provider, env) {
  return cookie(env, `oauth_${provider}`, '', 0);
}

export async function finishOAuth(provider, request, env) {
  requireSite(env);
  requireProvider(provider, env);
  if (request.method !== 'GET') throw new ApiError(400, 'invalid_oauth_response', 'Google sign-in did not return a valid response.');
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  const binding = readCookie(request, cookieName(env, `oauth_${provider}`));
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(binding || '')) {
    throw new ApiError(400, 'invalid_oauth_state', 'Sign-in expired or was started in another browser. Please try again.');
  }
  const pending = await one(env, `DELETE FROM chat_oauth_states
    WHERE state_hash = ? AND binding_hash = ? AND provider = ? AND expires_at > ? RETURNING nonce, verifier, mobile_challenge, mobile_state, return_path`,
    await hashToken(state), await hashToken(binding), provider, Date.now());
  if (!pending) throw new ApiError(400, 'invalid_oauth_state', 'Sign-in expired or has already been used. Please try again.');
  const mobile = pending.mobile_challenge ? { challenge: pending.mobile_challenge, state: pending.mobile_state } : undefined;
  try {
    const code = params.get('code');
    if (params.has('error') || !code || code.length > 4096) throw new ApiError(400, 'oauth_cancelled', 'Sign-in was not completed.');
    const clientId = env.GOOGLE_CLIENT_ID;
    const exchange = new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: new URL(`/api/auth/${provider}/callback`, requireSite(env)).href,
      client_secret: env.GOOGLE_CLIENT_SECRET, code_verifier: pending.verifier,
    });
    const tokens = await externalJSON(PROVIDERS[provider].token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: exchange,
    });
    const claims = await verifyIDToken(tokens.id_token, provider, clientId, pending.nonce);
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    const email = emailVerified && typeof claims.email === 'string' && claims.email.length <= 254
      && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claims.email) ? claims.email.trim().toLowerCase() : null;
    return { provider, subject: claims.sub, email, ...(mobile ? { mobile } : {}),
      ...(pending.return_path === '/delete-account.html' ? { returnTo: pending.return_path } : {}) };
  } catch (error) {
    if (mobile && error instanceof ApiError) error.mobile = mobile;
    throw error;
  }
}

/** Provider subject, never email, determines which account signs in. */
export async function identityUser(profile, env) {
  if (profile.provider !== 'google') throw new ApiError(400, 'invalid_provider', 'Use Google to sign in.');
  let existing = await one(env, `SELECT u.id, u.username FROM chat_identities i
    JOIN chat_users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?`, profile.provider, profile.subject);
  if (!existing) {
    const id = crypto.randomUUID();
    try {
      await batch(env, [
        ['INSERT INTO chat_users(id, username, email, created_at) VALUES (?, NULL, ?, ?)', id, profile.email, Date.now()],
        ['INSERT INTO chat_identities(provider, subject, user_id) VALUES (?, ?, ?)', profile.provider, profile.subject, id],
      ]);
      existing = { id, username: null };
    } catch (error) {
      existing = await one(env, `SELECT u.id, u.username FROM chat_identities i
        JOIN chat_users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?`, profile.provider, profile.subject);
      if (!existing) throw error;
    }
  } else if (profile.email) {
    await run(env, 'UPDATE chat_users SET email = ? WHERE id = ?', profile.email, existing.id);
  }
  return existing;
}

export async function createSession(userId, env) {
  const token = randomToken();
  const now = Date.now();
  await run(env, 'INSERT INTO chat_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await hashToken(token), userId, now, now + SESSION_SECONDS * 1000);
  return cookie(env, 'session', token, SESSION_SECONDS);
}

export async function sessionUser(request, env) {
  if (!env.DB || !siteURL(env)) return null;
  const token = readCookie(request, cookieName(env, 'session'));
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const user = await one(env, `SELECT u.id, u.username,
    EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) AS reviewFlag FROM chat_sessions s
    JOIN chat_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, await hashToken(token), Date.now());
  if (user) {
    if (user.reviewFlag) user.isReviewer = true;
    delete user.reviewFlag;
  }
  return user;
}

export async function endSession(request, env) {
  const token = readCookie(request, cookieName(env, 'session'));
  if (token) await run(env, 'DELETE FROM chat_sessions WHERE token_hash = ?', await hashToken(token));
  return cookie(env, 'session', '', 0);
}
