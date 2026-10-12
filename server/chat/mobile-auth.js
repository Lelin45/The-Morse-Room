import { ApiError, cookie, hashToken, randomToken, one, batch, readJSON,
  requireOrigin, requireSite, rateLimit } from './db.js';
import { clearOAuthCookie, createSession } from './auth.js';

const RETURN_URL = 'morsenepal://auth';
const CODE_LIFETIME = 120_000;

/** The external browser returns a one-use code, never a session or Google token. */
export async function makeMobileRedirect(user, mobile, env) {
  requireSite(env);
  if (!/^[A-Za-z0-9_-]{43}$/.test(mobile?.challenge || '')
      || !/^[A-Za-z0-9_-]{32,128}$/.test(mobile?.state || '')) {
    throw new ApiError(400, 'invalid_mobile_request', 'Start sign-in again from the app.');
  }
  const code = randomToken();
  const now = Date.now();
  await batch(env, [
    ['DELETE FROM chat_mobile_codes WHERE expires_at <= ?', now],
    ['INSERT INTO chat_mobile_codes(token_hash, user_id, challenge, expires_at) VALUES (?, ?, ?, ?)',
      await hashToken(code), user.id, mobile.challenge, now + CODE_LIFETIME],
  ]);
  const url = new URL(RETURN_URL);
  url.searchParams.set('code', code);
  url.searchParams.set('state', mobile.state);
  return new Response(null, { status: 303, headers: {
    Location: url.href, 'Set-Cookie': clearOAuthCookie('google', env),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

export function mobileErrorRedirect(mobile, env) {
  const url = new URL(RETURN_URL);
  url.searchParams.set('error', 'sign_in_not_completed');
  url.searchParams.set('state', mobile.state);
  return new Response(null, { status: 303, headers: {
    Location: url.href, 'Set-Cookie': clearOAuthCookie('google', env),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

/** Same-origin WebView POST installs the normal secure HttpOnly session cookie. */
export async function finishMobileSignIn(request, env) {
  requireSite(env);
  requireOrigin(request, env);
  const body = await readJSON(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(body.code || '')
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier || '')) {
    throw new ApiError(400, 'invalid_mobile_code', 'Sign-in expired. Start again from the app.');
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(env, `mobile-auth:${await hashToken(ip)}`, 30, 900);
  // Failed verifiers cannot consume the real app's pending code.
  const pending = await one(env, `DELETE FROM chat_mobile_codes
    WHERE token_hash = ? AND challenge = ? AND expires_at > ? RETURNING user_id AS userId`,
    await hashToken(body.code), await hashToken(body.verifier), Date.now());
  if (!pending) throw new ApiError(400, 'invalid_mobile_code', 'Sign-in expired or has already been used. Start again.');
  const user = await one(env, 'SELECT id, username FROM chat_users WHERE id = ?', pending.userId);
  if (!user) throw new ApiError(400, 'invalid_mobile_code', 'This account is no longer available.');
  return new Response(JSON.stringify({ ok: true, user }), { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Set-Cookie': await createSession(user.id, env),
  } });
}
