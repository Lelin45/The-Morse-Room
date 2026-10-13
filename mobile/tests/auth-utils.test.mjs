import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import vm from 'node:vm';
import { base64URL, readPendingAuth, parseAuthCallback, navigationAction, finishAuthScript, SITE_URL, AUTH_LIFETIME_MS } from '../src/auth-utils.js';

const token = 'a'.repeat(43);
const state = 'b'.repeat(43);
const verifier = 'c'.repeat(43);
const now = 1700000000000;

test('native PKCE entropy encoding matches Node base64url for every byte length', () => {
  for (let length = 0; length < 96; length += 1) {
    const bytes = randomBytes(length);
    assert.equal(base64URL(bytes), bytes.toString('base64url'));
  }
  const knownVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const digest = createHash('sha256').update(knownVerifier).digest();
  assert.equal(base64URL(digest), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('pending sign-in restores only valid, unexpired state and verifier', () => {
  const valid = { state, verifier, createdAt: now - 1, code: token };
  assert.deepEqual(readPendingAuth(JSON.stringify({ ...valid, ignored: 'field' }), now), valid);
  for (const value of [null, '{', '{}', JSON.stringify({ ...valid, createdAt: now + 1 }),
    JSON.stringify({ ...valid, createdAt: now - AUTH_LIFETIME_MS }),
    JSON.stringify({ ...valid, state: token + '/x' }),
    JSON.stringify({ ...valid, verifier: 'short' }), JSON.stringify({ ...valid, code: '<script>' })]) {
    assert.equal(readPendingAuth(value, now), null);
  }
});

test('deep-link callback binds a single code to the original app state', () => {
  assert.deepEqual(parseAuthCallback(`morsenepal://auth?code=${token}&state=${state}`, state), { code: token, state });
  for (const url of [
    `https://auth?code=${token}&state=${state}`, `morsenepal://evil?code=${token}&state=${state}`,
    `morsenepal://auth/path?code=${token}&state=${state}`, `morsenepal://auth?code=${token}&state=${token}`,
    `morsenepal://auth?code=${token}&code=${token}&state=${state}`,
    `morsenepal://auth?code=${token}&state=${state}&state=${state}`,
    `morsenepal://auth?code=${token}&state=${state}&error=denied`,
    `morsenepal://auth?code=${token}&state=${state}#fragment`,
    `morsenepal://user:password@auth?code=${token}&state=${state}`,
    `morsenepal://auth?code=short&state=${state}`,
  ]) assert.throws(() => parseAuthCallback(url, state));
  assert.throws(() => parseAuthCallback(`morsenepal://auth?error=oauth_cancelled&state=${state}`, state), /not completed/);
});

test('navigation never embeds sign-in, external pages or unsafe URL schemes', () => {
  assert.equal(navigationAction('about:blank'), 'allow');
  assert.equal(navigationAction(SITE_URL), 'home');
  assert.equal(navigationAction(new URL('/api/auth/google', SITE_URL).href), 'sign-in');
  assert.equal(navigationAction('morsenepal://auth'), 'auth-return');
  for (const value of ['https://accounts.google.com/', new URL('privacy.html', SITE_URL).href,
    new URL('delete-account.html', SITE_URL).href, 'mailto:user@example.com']) {
    assert.equal(navigationAction(value), 'browser');
  }
  for (const value of ['javascript:alert(1)', 'file:///private.txt', 'data:text/html,test',
    'http://learnmorse.lelinadhikari.com.np/', 'https://user:pass@example.com/', 'morsenepal://other']) {
    assert.equal(navigationAction(value), 'block');
  }
});

async function runFinish(origin, fetcher) {
  const events = [];
  const messages = [];
  const context = {
    location: { origin }, fetch: fetcher, setTimeout, clearTimeout, AbortController,
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: { dispatchEvent(event) { events.push(event.type); }, ReactNativeWebView: { postMessage(message) { messages.push(JSON.parse(message)); } } },
  };
  vm.runInNewContext(finishAuthScript(token, verifier), context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { events, messages };
}

test('session exchange happens inside trusted WebView with credentials and no token in bridge output', async () => {
  let request;
  const result = await runFinish(new URL(SITE_URL).origin, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ok: true, user: { id: 'private-id' } }) };
  });
  assert.equal(request.url, '/api/auth/mobile/finish');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.deepEqual(JSON.parse(request.options.body), { code: token, verifier });
  assert.deepEqual(result.events, ['morse-native-auth-complete']);
  assert.deepEqual(result.messages, [{ type: 'auth-finish', ok: true }]);
  assert(!JSON.stringify(result.messages).includes(token));
  assert(!JSON.stringify(result.messages).includes('private-id'));
});

test('exchange refuses an untrusted page and handles rejected or offline responses', async () => {
  const foreign = await runFinish('https://attacker.example', () => { throw new Error('Must not fetch'); });
  assert.deepEqual(foreign, { events: [], messages: [] });
  for (const fetcher of [async () => { throw new Error('Offline'); }, async () => ({ ok: false, json: async () => ({ ok: true }) })]) {
    const result = await runFinish(new URL(SITE_URL).origin, fetcher);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.messages, [{ type: 'auth-finish', ok: false }]);
  }
  assert.throws(() => finishAuthScript('not-a-code', verifier));
});
