import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { testEnv, person, api, friends } from './helpers/chat-db.mjs';
import { handleChatRequest } from '../server/chat/api.js';
import { hashToken } from '../server/chat/db.js';
import { dispatchPending } from '../server/chat/notifications.js';
import { drainNotifications } from '../worker/push/index.js';
import pushWorker from '../worker/push/index.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
let accountNumber = 0;
function pushEnv() {
  return Object.assign(testEnv(), {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'morse-push-test',
      client_email: `push-${accountNumber++}@morse-push-test.iam.gserviceaccount.com`, private_key: key }),
    PUSH_DISPATCH_URL: 'https://push.morse.test/dispatch', PUSH_DISPATCH_KEY: 'x'.repeat(43),
  });
}
const fcm = () => `fcm:${crypto.randomUUID().replaceAll('-', '')}`;
async function register(env, cookie, options = {}) {
  return api(env, '/api/notifications/devices', { method: 'POST', cookie,
    body: { installationId: crypto.randomUUID(), fcmToken: fcm(), ...options } });
}
async function capability(env, path, token, body) {
  const response = await handleChatRequest(new Request(new URL(path, env.SITE_URL), {
    method: body === undefined ? 'GET' : 'POST', headers: {
      Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { response, data: await response.json() };
}
async function send(env, cookie, conversationId, body = { text: 'HI', clientId: 'message-one' }) {
  return api(env, `/api/conversations/${conversationId}/messages`, { method: 'POST', cookie, body });
}
function googleFetch(deliveries, { status = 200, code, beforeDelivery } = {}) {
  return async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const values = new URLSearchParams(options.body);
      assert.equal(values.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims] = values.get('assertion').split('.').slice(0, 2).map((value) => JSON.parse(Buffer.from(value, 'base64url')));
      assert.equal(header.alg, 'RS256');
      assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return Response.json({ access_token: 'fcm-test-access', expires_in: 3600 });
    }
    if (String(url).startsWith('https://fcm.googleapis.com/v1/projects/morse-push-test/messages:send')) {
      const payload = JSON.parse(options.body);
      deliveries.push(payload);
      await beforeDelivery?.();
      return Response.json(status === 200 ? { name: 'projects/morse-push-test/messages/test' } : {
        error: { details: code ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] : [] },
      }, { status });
    }
    assert.equal(String(url), 'https://push.morse.test/dispatch');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(43)}`);
    return new Response(null, { status: 202 });
  };
}

test('notification availability fails closed for missing bindings, dispatch URL and schema', async () => {
  const env = pushEnv();
  try {
    assert.equal((await api(env, '/api/config')).data.notifications.available, true);
    for (const name of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'PUSH_DISPATCH_KEY', 'PUSH_DISPATCH_URL']) {
      const original = env[name]; env[name] = '';
      assert.equal((await api(env, '/api/config')).data.notifications.available, false);
      env[name] = original;
    }
    const original = env.PUSH_DISPATCH_URL; env.PUSH_DISPATCH_URL = 'https://evil.test/dispatch?secret=1';
    assert.equal((await api(env, '/api/config')).data.notifications.available, false);
    env.PUSH_DISPATCH_URL = original;
    env.DB.sqlite.exec('DROP TABLE chat_notification_outbox');
    assert.equal((await api(env, '/api/config')).data.notifications.available, false);
  } finally { env.DB.close(); }
});

test('private dispatch binding enables notifications without a public URL and keeps secret gating', async () => {
  const env = pushEnv();
  try {
    env.PUSH_DISPATCH_URL = '';
    assert.equal((await api(env, '/api/config')).data.notifications.available, false);
    const requests = [];
    env.PUSH_DISPATCHER = { async fetch(request) {
      requests.push(request);
      assert.equal(request.url, 'https://morse-room-push.internal/dispatch');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('Authorization'), `Bearer ${'x'.repeat(43)}`);
      assert.equal(await request.text(), '{}');
      return new Response(null, { status: 202 });
    } };
    assert.equal((await api(env, '/api/config')).data.notifications.available, true);
    assert.equal(await dispatchPending(env, () => { throw new Error('Private binding must not fetch a public URL.'); }), true);
    assert.equal(requests.length, 1);
    const originalKey = env.PUSH_DISPATCH_KEY; env.PUSH_DISPATCH_KEY = '';
    assert.equal((await api(env, '/api/config')).data.notifications.available, false);
    assert.equal(await dispatchPending(env), false); assert.equal(requests.length, 1);
    env.PUSH_DISPATCH_KEY = originalKey;
    env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
    assert.equal((await api(env, '/api/config')).data.notifications.available, false);
  } finally { env.DB.close(); }
});

test('a committed chat send queues and dispatches through a private service binding', async () => {
  const env = pushEnv();
  try {
    let dispatched = 0;
    env.PUSH_DISPATCH_URL = '';
    env.PUSH_DISPATCHER = { async fetch(request) {
      assert.equal(request.url, 'https://morse-room-push.internal/dispatch');
      assert.equal(request.headers.get('Authorization'), `Bearer ${env.PUSH_DISPATCH_KEY}`);
      dispatched += 1;
      return new Response(null, { status: 202 });
    } };
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    assert.equal((await register(env, bob)).response.status, 200);
    const pending = [];
    const response = await handleChatRequest(new Request(`https://morse.test/api/conversations/${direct}/messages`, {
      method: 'POST', headers: { Cookie: alice, Origin: env.SITE_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'PRIVATE DISPATCH', clientId: 'private-dispatch' }),
    }), env, { waitUntil: (promise) => pending.push(promise) });
    assert.equal(response.status, 201);
    await Promise.all(pending);
    assert.equal(dispatched, 1);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 1);
  } finally { env.DB.close(); }
});

test('device registration needs cookie authentication and Origin; capabilities rotate and remain hashed', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice');
    const install = crypto.randomUUID(); const token = fcm();
    const first = await register(env, alice, { installationId: install, fcmToken: token });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.userId, 'alice');
    assert.match(first.data.authToken, /^[A-Za-z0-9_-]{43}$/);
    const saved = env.DB.sqlite.prepare('SELECT * FROM chat_notification_devices').get();
    assert.equal(saved.auth_hash, await hashToken(first.data.authToken));
    assert.notEqual(saved.auth_hash, first.data.authToken);
    assert.equal(saved.session_hash, await hashToken(alice.split('=')[1]));
    const second = await register(env, alice, { installationId: install, fcmToken: token });
    assert.equal(second.data.deviceId, first.data.deviceId);
    assert.notEqual(second.data.authToken, first.data.authToken);
    assert.equal((await capability(env, '/api/notifications/message?id=1', first.data.authToken)).response.status, 401);
    assert.equal((await capability(env, '/api/inbox', second.data.authToken)).response.status, 401);
    for (const origin of [null, 'https://evil.test']) {
      assert.equal((await api(env, '/api/notifications/devices', { method: 'POST', cookie: alice, origin,
        body: { installationId: install, fcmToken: token } })).response.status, 403);
    }
    assert.equal((await register(env, undefined)).response.status, 401);
    assert.equal((await api(env, '/api/notifications/devices', { cookie: alice })).response.status, 404);
    for (const options of [{ installationId: 'bad' }, { fcmToken: '\nnot-a-token' }]) {
      assert.equal((await register(env, alice, options)).response.status, 400);
    }
  } finally { env.DB.close(); }
});

test('installation owner rebinding requires the existing opaque token or capability and clears previous pending jobs', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const install = crypto.randomUUID(); const token = fcm();
    const registered = (await register(env, bob, { installationId: install, fcmToken: token })).data;
    const received = (await send(env, alice, id)).data.message;
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 1);
    assert.equal((await register(env, alice, { installationId: install, fcmToken: fcm() })).response.status, 403);
    const rebound = await register(env, alice, { installationId: install, fcmToken: fcm(), previousAuthToken: registered.authToken });
    assert.equal(rebound.response.status, 200);
    assert.equal(rebound.data.userId, 'alice');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 0);
    assert.equal((await capability(env, `/api/notifications/message?id=${received.id}`, registered.authToken)).response.status, 401);
  } finally { env.DB.close(); }
});

test('native capability retrieves and replies only to an incoming message in a current authorized conversation', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const carol = await person(env, 'carol');
    const direct = await friends(env, alice, bob);
    const other = await friends(env, alice, carol, 'carol');
    const device = (await register(env, bob)).data;
    const sent = (await send(env, alice, direct)).data.message;
    const foreign = (await send(env, alice, other)).data.message;
    const read = await capability(env, `/api/notifications/message?id=${sent.id}`, device.authToken);
    assert.equal(read.response.status, 200);
    assert.equal(read.data.message.text, 'HI');
    assert.equal(read.data.message.morse, '.... ..');
    assert.equal(read.data.message.senderUsername, 'alice');
    assert.equal(read.data.message.conversationName, 'alice');
    assert.equal((await capability(env, `/api/notifications/message?id=${foreign.id}`, device.authToken)).response.status, 404);
    const body = { messageId: sent.id, conversationId: direct, kind: 'text', text: 'Hello!', clientId: 'native-one' };
    const reply = await capability(env, '/api/notifications/reply', device.authToken, body);
    assert.equal(reply.response.status, 201);
    assert.equal(reply.data.message.text, 'Hello!');
    assert.equal(reply.data.message.senderId, 'bob');
    assert.equal((await capability(env, '/api/notifications/reply', device.authToken, body)).data.message.id, reply.data.message.id);
    assert.equal((await capability(env, '/api/notifications/reply', device.authToken, { ...body, text: 'bye' })).response.status, 409);
    assert.equal((await capability(env, '/api/notifications/reply', device.authToken, { ...body, conversationId: other })).response.status, 400);
    assert.equal((await capability(env, '/api/notifications/reply', device.authToken, { ...body, clientId: 'symbols', text: '!!!' })).response.status, 400);
    const morse = await capability(env, '/api/notifications/reply', device.authToken, { ...body, kind: 'morse', morse: '--- / -.-', clientId: 'native-morse' });
    assert.equal(morse.response.status, 201); assert.equal(morse.data.message.text, 'OK');
    await api(env, '/api/blocks', { method: 'POST', cookie: alice, body: { userId: 'bob' } });
    assert.equal((await capability(env, `/api/notifications/message?id=${sent.id}`, device.authToken)).response.status, 404);
    assert.equal((await capability(env, '/api/notifications/reply', device.authToken, body)).response.status, 404);
  } finally { env.DB.close(); }
});

test('logout, expiry, account deletion and membership removal revoke notification access', async () => {
  for (const operation of ['logout', 'expiry', 'delete', 'membership']) {
    const env = pushEnv();
    try {
      const alice = await person(env, 'alice'); const bob = await person(env, 'bob');
      const direct = await friends(env, alice, bob); const device = (await register(env, bob)).data;
      const received = (await send(env, alice, direct)).data.message;
      if (operation === 'logout') await api(env, '/api/logout', { method: 'POST', cookie: bob });
      else if (operation === 'expiry') env.DB.sqlite.prepare("UPDATE chat_sessions SET expires_at = 1 WHERE user_id = 'bob'").run();
      else if (operation === 'delete') await api(env, '/api/account/delete', { method: 'POST', cookie: bob, body: { confirmation: 'DELETE' } });
      else env.DB.sqlite.prepare("DELETE FROM chat_members WHERE user_id = 'bob'").run();
      assert.equal((await capability(env, `/api/notifications/message?id=${received.id}`, device.authToken)).response.status, operation === 'membership' ? 404 : 401);
      const deliveries = []; await drainNotifications(env, { fetcher: googleFetch(deliveries) });
      assert.equal(deliveries.length, 0);
    } finally { env.DB.close(); }
  }
});

test('device token refresh and removal cannot alter another device or account', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob');
    const a = (await register(env, alice)).data; const b = (await register(env, bob)).data;
    assert.equal((await capability(env, '/api/notifications/device-token', a.authToken, { deviceId: b.deviceId, fcmToken: fcm() })).response.status, 403);
    const updated = fcm();
    assert.equal((await capability(env, '/api/notifications/device-token', a.authToken, { deviceId: a.deviceId, fcmToken: updated })).response.status, 200);
    assert.equal(env.DB.sqlite.prepare('SELECT fcm_token FROM chat_notification_devices WHERE id = ?').get(a.deviceId).fcm_token, updated);
    await api(env, '/api/notifications/devices/remove', { method: 'POST', cookie: alice, body: { deviceId: b.deviceId } });
    assert.ok(env.DB.sqlite.prepare('SELECT id FROM chat_notification_devices WHERE id = ?').get(b.deviceId));
    await api(env, '/api/notifications/devices/remove', { method: 'POST', cookie: alice, body: { deviceId: a.deviceId } });
    assert.equal((await capability(env, '/api/notifications/device-token', a.authToken, { deviceId: a.deviceId, fcmToken: fcm() })).response.status, 401);
  } finally { env.DB.close(); }
});

test('device limit is enforced at registration and by atomic database triggers', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice');
    for (let index = 0; index < 8; index += 1) assert.equal((await register(env, alice)).response.status, 200);
    assert.equal((await register(env, alice)).response.status, 409);
    const session = env.DB.sqlite.prepare("SELECT token_hash FROM chat_sessions WHERE user_id = 'alice'").get().token_hash;
    assert.throws(() => env.DB.sqlite.prepare(`INSERT INTO chat_notification_devices
      (id,installation_id,user_id,session_hash,auth_hash,fcm_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), crypto.randomUUID(), 'alice', session, 'unique-auth-hash', fcm(), Date.now(), Date.now()), /notification_device_limit/);
  } finally { env.DB.close(); }
});

test('outbox and dispatch failures preserve committed messages, and an idempotent retry repairs a missing job', async () => {
  const env = pushEnv();
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const originalFetch = globalThis.fetch;
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    await register(env, bob);
    env.DB.prepare = (sql) => {
      if (sql.startsWith('INSERT INTO chat_notification_outbox')) throw new Error('Outbox is temporarily unavailable.');
      return originalPrepare(sql);
    };
    const committed = await send(env, alice, direct);
    assert.equal(committed.response.status, 201);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 1);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 0);
    env.DB.prepare = originalPrepare;
    const pending = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://push.morse.test/dispatch');
      assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(43)}`);
      return new Response(null, { status: 503 });
    };
    const response = await handleChatRequest(new Request(`https://morse.test/api/conversations/${direct}/messages`, {
      method: 'POST', headers: { Cookie: alice, Origin: env.SITE_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'HI', clientId: 'message-one' }),
    }), env, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    assert.equal(response.status, 201); assert.equal(pending.length, 1);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 1);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM chat_notification_outbox WHERE status='pending'").get().n, 1);
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('queue insertion is idempotent, preserves jobs on same-account registration and FCM payload contains only IDs', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    const install = crypto.randomUUID(); const token = fcm();
    await register(env, bob, { installationId: install, fcmToken: token });
    await register(env, alice);
    const first = await send(env, alice, direct); await send(env, alice, direct);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 1);
    await register(env, bob, { installationId: install, fcmToken: token });
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 1);
    const deliveries = [];
    assert.deepEqual(await drainNotifications(env, { fetcher: googleFetch(deliveries) }), { claimed: 1, delivered: 1 });
    const message = deliveries[0].message;
    assert.deepEqual(message.data, { messageId: String(first.data.message.id), conversationId: direct });
    assert.equal(message.notification, undefined);
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.android.ttl, '86400s');
    assert.equal(message.android.restricted_package_name, 'com.morsenepal');
    await send(env, alice, direct); await drainNotifications(env, { fetcher: googleFetch(deliveries) });
    assert.equal(deliveries.length, 1);
  } finally { env.DB.close(); }
});

test('concurrent workers cannot lease one job twice and retry recovers transient failures', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    await register(env, bob); await send(env, alice, direct);
    const deliveries = []; let release; const held = new Promise((resolve) => { release = resolve; });
    let entered; const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const first = drainNotifications(env, { fetcher: googleFetch(deliveries, { beforeDelivery: async () => { entered(); await held; } }) });
    await enteredPromise;
    assert.deepEqual(await drainNotifications(env, { fetcher: googleFetch(deliveries) }), { claimed: 0, delivered: 0 });
    release(); await first; assert.equal(deliveries.length, 1);
    await send(env, alice, direct, { text: 'RETRY', clientId: 'retry' });
    await drainNotifications(env, { fetcher: googleFetch(deliveries, { status: 503 }) });
    const pending = env.DB.sqlite.prepare("SELECT * FROM chat_notification_outbox WHERE status = 'pending'").get();
    assert.equal(pending.attempts, 1); assert.ok(pending.next_attempt_at > Date.now());
    await drainNotifications(env, { fetcher: googleFetch(deliveries), now: () => pending.next_attempt_at + 1 });
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM chat_notification_outbox WHERE status = 'done'").get().n, 2);
  } finally { env.DB.close(); }
});

test('unregistered tokens are removed and a later block is checked again at dispatch', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    await register(env, bob); await send(env, alice, direct);
    const deliveries = []; await drainNotifications(env, { fetcher: googleFetch(deliveries, { status: 404, code: 'UNREGISTERED' }) });
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_devices').get().n, 0);
    await register(env, bob); await send(env, alice, direct, { text: 'BLOCK', clientId: 'blocked' });
    await api(env, '/api/blocks', { method: 'POST', cookie: bob, body: { userId: 'alice' } });
    const after = []; await drainNotifications(env, { fetcher: googleFetch(after) });
    assert.equal(after.length, 0);
  } finally { env.DB.close(); }
});

test('a group kick revokes a queued push and notification actions for the removed member', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob');
    const created = (await api(env, '/api/groups', { method: 'POST', cookie: alice, body: { name: 'Private Group' } })).data;
    await api(env, '/api/groups/join', { method: 'POST', cookie: bob, body: { code: created.code } });
    const device = (await register(env, bob)).data;
    const message = (await send(env, alice, created.conversation.id)).data.message;
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 1);
    const removed = await api(env, '/api/groups/kick', { method: 'POST', cookie: alice, body: { groupId: created.conversation.id, userId: 'bob' } });
    assert.equal(removed.response.status, 200);
    assert.equal((await capability(env, `/api/notifications/message?id=${message.id}`, device.authToken)).response.status, 404);
    const deliveries = []; await drainNotifications(env, { fetcher: googleFetch(deliveries) });
    assert.equal(deliveries.length, 0);
  } finally { env.DB.close(); }
});

test('99 group recipients queue atomically and each worker handles at most 20 sends before continuation', async () => {
  const env = pushEnv();
  try {
    const owner = await person(env, 'owner');
    const group = (await api(env, '/api/groups', { method: 'POST', cookie: owner, body: { name: 'Full Group' } })).data.conversation.id;
    for (let index = 0; index < 99; index += 1) {
      const id = `member-${index}`;
      const cookie = await person(env, id);
      env.DB.sqlite.prepare('INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?,?,?)').run(group, id, Date.now());
      await register(env, cookie);
    }
    const result = await send(env, owner, group);
    assert.equal(result.response.status, 201);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notification_outbox').get().n, 99);
    const deliveries = []; const counts = [];
    for (let index = 0; index < 5; index += 1) counts.push((await drainNotifications(env, { fetcher: googleFetch(deliveries) })).delivered);
    assert.deepEqual(counts, [20, 20, 20, 20, 19]);
    assert.equal(deliveries.length, 99);
  } finally { env.DB.close(); }
});

test('dispatch endpoint is authenticated and expired lease jobs can be recovered', async () => {
  const env = pushEnv();
  try {
    const context = { waitUntil() { throw new Error('Unauthorized requests must not dispatch.'); } };
    assert.equal((await pushWorker.fetch(new Request('https://push.morse.test/dispatch', { method: 'POST' }), env, context)).status, 401);
    assert.equal((await pushWorker.fetch(new Request('https://push.morse.test/other'), env, context)).status, 404);
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob'); const direct = await friends(env, alice, bob);
    await register(env, bob); await send(env, alice, direct);
    env.DB.sqlite.exec("UPDATE chat_notification_outbox SET status='sending',lease_id='old',lease_until=1");
    const deliveries = [];
    assert.equal((await drainNotifications(env, { fetcher: googleFetch(deliveries) })).delivered, 1);
  } finally { env.DB.close(); }
});

test('review sandbox users cannot receive or read ordinary-user pushes even in corrupt mixed groups', async () => {
  const env = pushEnv();
  try {
    const alice = await person(env, 'alice'); const bob = await person(env, 'bob');
    env.DB.sqlite.prepare('INSERT INTO chat_review_users(user_id) VALUES (?)').run('bob');
    const device = (await register(env, bob)).data;
    const group = (await api(env, '/api/groups', { method: 'POST', cookie: alice, body: { name: 'Safe Group' } })).data.conversation.id;
    const received = (await send(env, alice, group)).data.message;
    env.DB.sqlite.prepare('INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?,?,?)').run(group, 'bob', Date.now());
    assert.equal((await capability(env, `/api/notifications/message?id=${received.id}`, device.authToken)).response.status, 404);
    const deliveries = []; await drainNotifications(env, { fetcher: googleFetch(deliveries) });
    assert.equal(deliveries.length, 0);
  } finally { env.DB.close(); }
});
