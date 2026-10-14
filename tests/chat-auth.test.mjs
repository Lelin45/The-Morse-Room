import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnv } from './helpers/chat-db.mjs';
import { startOAuth, finishOAuth, verifyIDToken, identityUser,
  sessionUser, authProviders } from '../server/chat/auth.js';
import { base64url, hashToken, randomToken } from '../server/chat/db.js';
import { handleChatRequest } from '../server/chat/api.js';

async function signer() {
  const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const kid = crypto.randomUUID();
  const publicKey = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid, alg: 'RS256', use: 'sig' };
  return {
    publicKey,
    async token(claims, header = {}) {
      const encode = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
      const payload = `${encode({ alg: 'RS256', kid, ...header })}.${encode(claims)}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(payload));
      return `${payload}.${base64url(signature)}`;
    },
  };
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: 'test-google-client', sub: 'signed-provider-subject',
    exp: now + 3600, iat: now - 5, nonce: 'expected-nonce', email: 'signed@example.com', email_verified: true, ...overrides };
}

function callback(env, start, binding = start.headers.get('Set-Cookie').split(';')[0]) {
  const authorization = new URL(start.headers.get('Location'));
  const fields = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'test-authorization-code' });
  return new Request(new URL(`/api/auth/google/callback?${fields}`, env.SITE_URL),
    { headers: { Cookie: binding } });
}

test('ID tokens need a valid provider signature, issuer, audience, expiry, and nonce', async () => {
  const identity = await signer();
  const fetcher = async () => Response.json({ keys: [identity.publicKey] });
  const valid = await identity.token(claims());
  assert.equal((await verifyIDToken(valid, 'google', 'test-google-client', 'expected-nonce', fetcher)).sub, 'signed-provider-subject');
  for (const invalid of [
    claims({ iss: 'https://attacker.test' }), claims({ aud: 'another-client' }), claims({ exp: 1 }),
    claims({ nonce: 'other-browser' }), claims({ iat: Math.floor(Date.now() / 1000) + 600 }),
    claims({ aud: ['test-google-client', 'second-client'] }),
  ]) {
    await assert.rejects(verifyIDToken(await identity.token(invalid), 'google', 'test-google-client', 'expected-nonce', fetcher),
      (error) => error.code === 'invalid_id_token');
  }
  const parts = valid.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await assert.rejects(verifyIDToken(parts.join('.'), 'google', 'test-google-client', 'expected-nonce', fetcher));
  await assert.rejects(verifyIDToken(await identity.token(claims(), { alg: 'none' }), 'google', 'test-google-client', 'expected-nonce', fetcher));
  await assert.rejects(verifyIDToken(await identity.token(claims(), { alg: 'ES256' }), 'google', 'test-google-client', 'expected-nonce', fetcher));
  await assert.rejects(verifyIDToken(valid, 'another-provider', 'test-google-client', 'expected-nonce', fetcher));
});

test('Google auth start stores hashed browser-bound state and sends a PKCE challenge', async () => {
  const env = testEnv();
  try {
    const start = await startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env);
    const location = new URL(start.headers.get('Location'));
    assert.equal(location.origin, 'https://accounts.google.com');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), `${env.SITE_URL}/api/auth/google/callback`);
    assert.equal(location.searchParams.has('client_secret'), false);
    const pending = env.DB.sqlite.prepare('SELECT * FROM chat_oauth_states').get();
    assert.equal(pending.state_hash, await hashToken(location.searchParams.get('state')));
    assert.equal(location.searchParams.get('code_challenge'), await hashToken(pending.verifier));
    assert.match(start.headers.get('Set-Cookie'), /^__Host-morse_oauth_google=/);
    assert.match(start.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    await assert.rejects(finishOAuth('google', callback(env, start, ''), env), (error) => error.code === 'invalid_oauth_state');
    await assert.rejects(finishOAuth('google', callback(env, start, `__Host-morse_oauth_google=${randomToken()}`), env),
      (error) => error.code === 'invalid_oauth_state');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_oauth_states').get().n, 1);
  } finally { env.DB.close(); }
});

test('Google callback checks nonce and PKCE, consumes state once, and creates a secure opaque session', async () => {
  const env = testEnv();
  const originalFetch = globalThis.fetch;
  try {
    const identity = await signer();
    const start = await startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env);
    const authorization = new URL(start.headers.get('Location'));
    const pending = env.DB.sqlite.prepare('SELECT verifier FROM chat_oauth_states').get();
    const token = await identity.token(claims({ nonce: authorization.searchParams.get('nonce') }));
    globalThis.fetch = async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        assert.equal(new URLSearchParams(options.body).get('code_verifier'), pending.verifier);
        return Response.json({ id_token: token });
      }
      assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
      return Response.json({ keys: [identity.publicKey] });
    };
    const response = await handleChatRequest(callback(env, start), env);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/?chat=1');
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((value) => value.startsWith('__Host-morse_session='));
    assert.match(session, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    const user = await sessionUser(new Request(`${env.SITE_URL}/api/me`, { headers: { Cookie: session.split(';')[0] } }), env);
    assert.equal(user.username, null);
    assert.equal(env.DB.sqlite.prepare('SELECT email FROM chat_users').get().email, 'signed@example.com');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_oauth_states').get().n, 0);
    const repeated = await handleChatRequest(callback(env, start), env);
    assert.match(repeated.headers.get('Location'), /chat_error=invalid_oauth_state/);
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('a signed token with the wrong callback nonce never creates a user or session', async () => {
  const env = testEnv();
  const originalFetch = globalThis.fetch;
  try {
    const identity = await signer();
    const start = await startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env);
    globalThis.fetch = async (url) => url === 'https://oauth2.googleapis.com/token'
      ? Response.json({ id_token: await identity.token(claims({ nonce: 'not-this-browser' })) })
      : Response.json({ keys: [identity.publicKey] });
    const response = await handleChatRequest(callback(env, start), env);
    assert.match(response.headers.get('Location'), /chat_error=invalid_id_token/);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_users').get().n, 0);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_sessions').get().n, 0);
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('Google identities never auto-link by email and repeat sign-in uses its original subject', async () => {
  const env = testEnv();
  try {
    const google = await identityUser({ provider: 'google', subject: 'google-user', email: 'shared@example.com' }, env);
    const another = await identityUser({ provider: 'google', subject: 'another-google-user', email: 'shared@example.com' }, env);
    assert.notEqual(google.id, another.id);
    assert.equal(google.username, null);
    const repeated = await identityUser({ provider: 'google', subject: 'google-user', email: 'changed@example.com' }, env);
    assert.equal(repeated.id, google.id);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_users').get().n, 2);
  } finally { env.DB.close(); }
});

test('local HTTP supports Google cookies and reports only Google readiness', async () => {
  const env = testEnv();
  try {
    env.SITE_URL = 'http://localhost:8788';
    assert.deepEqual(authProviders(env).providers, { google: true });
    const start = await startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env);
    assert.match(start.headers.get('Set-Cookie'), /^morse_oauth_google=/);
    assert.equal(start.headers.get('Set-Cookie').includes('Secure'), false);
    env.GOOGLE_CLIENT_SECRET = '';
    assert.deepEqual(authProviders(env).providers, { google: false });
    await assert.rejects(startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env),
      (error) => error.code === 'provider_unavailable');
  } finally { env.DB.close(); }
});

test('sign-in and account creation reject other providers', async () => {
  const env = testEnv();
  try {
    await assert.rejects(startOAuth('another-provider', new Request(`${env.SITE_URL}/api/auth/another-provider`), env),
      (error) => error.code === 'provider_unavailable');
    await assert.rejects(identityUser({ provider: 'another-provider', subject: 'unknown', email: 'person@example.com' }, env),
      (error) => error.code === 'invalid_provider');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_users').get().n, 0);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_oauth_states').get().n, 0);
  } finally { env.DB.close(); }
});

test('expired session, OAuth, and rate-limit rows are removed on a new sign-in start', async () => {
  const env = testEnv();
  try {
    env.DB.sqlite.exec(`INSERT INTO chat_users VALUES ('old',NULL,NULL,1);
      INSERT INTO chat_sessions VALUES ('expired','old',1,1);
      INSERT INTO chat_oauth_states(state_hash,binding_hash,provider,nonce,verifier,expires_at) VALUES ('expired','expired','google','old','old',1);
      INSERT INTO chat_rate_limits VALUES ('expired',1,1,1);`);
    await startOAuth('google', new Request(`${env.SITE_URL}/api/auth/google`), env);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_sessions WHERE token_hash = 'expired'").get().n, 0);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_oauth_states WHERE state_hash = 'expired'").get().n, 0);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_rate_limits WHERE actor = 'expired'").get().n, 0);
  } finally { env.DB.close(); }
});

test('transactional batches roll back conversation inserts when membership fails', async () => {
  const env = testEnv();
  try {
    env.DB.sqlite.prepare('INSERT INTO chat_users VALUES (?,NULL,NULL,1)').run('owner');
    await assert.rejects(env.DB.batch([
      env.DB.prepare("INSERT INTO chat_conversations(id,type,name,dm_pair,code,owner_id,created_at) VALUES ('rollback','group','Group',NULL,'test-code','owner',1)"),
      env.DB.prepare("INSERT INTO chat_members VALUES ('rollback','missing-user',1,0)"),
    ]));
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_conversations').get().n, 0);
  } finally { env.DB.close(); }
});
