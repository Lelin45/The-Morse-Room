export const SITE_URL = 'https://learnmorse.lelinadhikari.com.np/';
export const AUTH_RETURN_URL = 'morsenepal://auth';
export const PENDING_AUTH_KEY = 'morse-nepal-pending-auth';
export const AUTH_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** @param {Uint8Array} bytes */
export function base64URL(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
    result += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    if (index + 1 < bytes.length) result += alphabet[(value >>> 6) & 63];
    if (index + 2 < bytes.length) result += alphabet[value & 63];
  }
  return result;
}

/** @typedef {{state: string, verifier: string, createdAt: number, code?: string}} PendingAuth */

/** @param {string | null} value @param {number} [now] @returns {PendingAuth | null} */
export function readPendingAuth(value, now = Date.now()) {
  try {
    const pending = JSON.parse(value || 'null');
    if (!pending || !TOKEN.test(pending.state) || !TOKEN.test(pending.verifier)
        || !Number.isSafeInteger(pending.createdAt) || pending.createdAt > now
        || now - pending.createdAt >= AUTH_LIFETIME_MS
        || (pending.code !== undefined && !TOKEN.test(pending.code))) return null;
    return { state: pending.state, verifier: pending.verifier, createdAt: pending.createdAt,
      ...(pending.code ? { code: pending.code } : {}) };
  } catch { return null; }
}

/** @param {string} url @param {string} expectedState */
export function parseAuthCallback(url, expectedState) {
  const target = new URL(url);
  if (target.protocol !== 'morsenepal:' || target.hostname !== 'auth' || target.port
      || target.username || target.password || target.hash || !['', '/'].includes(target.pathname)) {
    throw new Error('This sign-in link is not for Morse Room: Learn & Chat.');
  }
  const states = target.searchParams.getAll('state');
  const codes = target.searchParams.getAll('code');
  const errors = target.searchParams.getAll('error');
  if (states.length !== 1 || !TOKEN.test(states[0]) || states[0] !== expectedState
      || codes.length > 1 || errors.length > 1 || (codes.length && errors.length)) {
    throw new Error('Sign-in expired. Please sign in again.');
  }
  if (errors.length) throw new Error('Google sign-in was not completed. Please try again.');
  if (codes.length !== 1 || !TOKEN.test(codes[0])) throw new Error('Sign-in could not be verified.');
  return { code: codes[0], state: states[0] };
}

/** @param {string} value */
export function navigationAction(value) {
  if (value === 'about:blank') return 'allow';
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'block';
    if (url.protocol === 'morsenepal:') return url.hostname === 'auth' ? 'auth-return' : 'block';
    if (url.origin === new URL(SITE_URL).origin) {
      if (url.pathname === '/api/auth/google' && !url.search && !url.hash) return 'sign-in';
      if (url.pathname === '/' && !url.search && !url.hash) return 'home';
      return 'browser';
    }
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? 'browser' : 'block';
  } catch { return 'block'; }
}

/** Exchange inside the HTTPS-origin WebView so its HttpOnly cookie stays there.
 * @param {string} code @param {string} verifier
 */
export function finishAuthScript(code, verifier) {
  if (!TOKEN.test(code) || !TOKEN.test(verifier)) throw new Error('Invalid sign-in proof');
  return `(() => {
    if (location.origin !== ${JSON.stringify(new URL(SITE_URL).origin)}) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    (async () => {
      let ok = false;
      try {
        const response = await fetch('/api/auth/mobile/finish', {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(${JSON.stringify({ code, verifier })})
        });
        const result = await response.json();
        ok = response.ok && result.ok === true;
        if (ok) window.dispatchEvent(new CustomEvent('morse-native-auth-complete'));
      } catch { /* The shell offers another sign-in attempt. */ }
      finally {
        clearTimeout(timeout);
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'auth-finish', ok }));
      }
    })();
  })(); true;`;
}
