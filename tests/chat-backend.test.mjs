import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, person, api, friends } from './helpers/chat-db.mjs';
import { handleChatRequest } from '../server/chat/api.js';
import { hashToken, readJSON } from '../server/chat/db.js';
import { encodeMorse } from '../chat-codec.js';

test('configuration is unavailable without DB or its migrated schema', async () => {
  const absent = await handleChatRequest(new Request('https://morse.test/api/config'), {});
  assert.deepEqual(await absent.json(), { available: false, providers: { google: false } });
  const env = testEnv(false);
  try {
    assert.equal((await api(env, '/api/config')).data.available, false);
    assert.deepEqual((await api(env, '/api/me')).data, { user: null });
  } finally { env.DB.close(); }
});

test('sessions are opaque, hashed, expiring, and profile setup requires a same-origin write', async () => {
  const env = testEnv();
  try {
    const cookie = await person(env, 'alice', null);
    const token = cookie.split('=')[1];
    const stored = env.DB.sqlite.prepare('SELECT token_hash, expires_at FROM chat_sessions').get();
    assert.equal(stored.token_hash, await hashToken(token));
    assert.notEqual(stored.token_hash, token);
    assert.ok(stored.expires_at > Date.now());
    assert.deepEqual((await api(env, '/api/me', { cookie })).data.user, { id: 'alice', username: null });
    assert.equal((await api(env, '/api/inbox', { cookie })).response.status, 409);
    for (const origin of [null, 'https://attacker.test']) {
      assert.equal((await api(env, '/api/profile', { method: 'POST', cookie, origin, body: { username: 'Alice' } })).response.status, 403);
    }
    const profile = await api(env, '/api/profile', { method: 'POST', cookie, body: { username: 'Alice' } });
    assert.deepEqual(profile.data.user, { id: 'alice', username: 'alice' });
    env.DB.sqlite.prepare('UPDATE chat_sessions SET expires_at = 1').run();
    assert.equal((await api(env, '/api/inbox', { cookie })).response.status, 401);
  } finally { env.DB.close(); }
});

test('usernames are unique regardless of case and only the session account changes', async () => {
  const env = testEnv();
  try {
    await person(env, 'alice');
    const bob = await person(env, 'bob');
    const duplicate = await api(env, '/api/profile', { method: 'POST', cookie: bob, body: { username: 'ALICE', id: 'alice' } });
    assert.equal(duplicate.response.status, 409);
    assert.equal(env.DB.sqlite.prepare("SELECT username FROM chat_users WHERE id = 'bob'").get().username, 'bob');
  } finally { env.DB.close(); }
});

test('only the recipient can accept a request and acceptance creates one atomic direct conversation', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    assert.equal((await api(env, '/api/friends/request', { method: 'POST', cookie: alice, body: { target: '@BOB' } })).response.status, 200);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_conversations').get().n, 0);
    const request = (await api(env, '/api/inbox', { cookie: bob })).data.requests[0];
    assert.equal(request.username, 'alice');
    assert.equal((await api(env, '/api/friends/respond', { method: 'POST', cookie: carol, body: { id: request.id, accept: true } })).response.status, 404);
    const accepted = await api(env, '/api/friends/respond', { method: 'POST', cookie: bob, body: { id: request.id, accept: true } });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.data.conversation.name, 'alice');
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_members').get().n, 2);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_friends').get().n, 1);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_friend_requests').get().n, 0);
    assert.equal((await api(env, '/api/friends/request', { method: 'POST', cookie: bob, body: { target: 'alice' } })).data.alreadyFriends, true);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_conversations').get().n, 1);
    assert.equal((await api(env, `/api/conversations/${accepted.data.conversation.id}`, { cookie: carol })).response.status, 404);
  } finally { env.DB.close(); }
});

test('direct reads and writes require accepted friendship even if a membership row exists', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    await person(env, 'bob');
    env.DB.sqlite.exec(`INSERT INTO chat_conversations VALUES ('fake-dm','direct',NULL,'alice:bob',NULL,'alice',1);
      INSERT INTO chat_members VALUES ('fake-dm','alice',1,0); INSERT INTO chat_members VALUES ('fake-dm','bob',1,0);`);
    assert.equal((await api(env, '/api/conversations/fake-dm', { cookie: alice })).response.status, 403);
    assert.equal((await api(env, '/api/conversations/fake-dm/messages', { method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'one' } })).response.status, 403);
  } finally { env.DB.close(); }
});

test('group code grants membership and nonmembers cannot read, send, or mark it read', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const created = await api(env, '/api/groups', { method: 'POST', cookie: alice, body: { name: 'Night listeners' } });
    assert.equal(created.response.status, 201);
    const { conversation, code, link } = created.data;
    assert.match(code, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(new URL(link).searchParams.get('join'), code);
    for (const [path, method, body] of [[`/api/conversations/${conversation.id}`, 'GET'],
      [`/api/conversations/${conversation.id}/messages`, 'POST', { text: 'HI', clientId: 'bad' }],
      [`/api/conversations/${conversation.id}/read`, 'POST', {}]]) {
      assert.equal((await api(env, path, { method, cookie: bob, body })).response.status, 404);
    }
    const joined = await api(env, '/api/groups/join', { method: 'POST', cookie: bob, body: { code } });
    assert.equal(joined.response.status, 200);
    const detail = await api(env, `/api/conversations/${conversation.id}`, { cookie: bob });
    assert.equal(detail.data.conversation.code, code);
    assert.deepEqual(detail.data.members.map((member) => member.id).sort(), ['alice', 'bob']);
    assert.equal((await api(env, '/api/groups/join', { method: 'POST', cookie: bob, body: { code } })).response.status, 200);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_members').get().n, 2);
  } finally { env.DB.close(); }
});

test('messages use server identity and Morse encoding, and duplicate client IDs are idempotent', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const body = { text: '  Hello, Bob!\n :)  12.  ', clientId: 'client-one', senderId: 'bob', morse: 'forged' };
    const first = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body });
    assert.equal(first.response.status, 201);
    assert.equal(first.data.message.senderId, 'alice');
    assert.equal(first.data.message.kind, 'text');
    assert.equal(first.data.message.text, body.text);
    assert.equal(first.data.message.morse, encodeMorse(body.text));
    assert.equal(first.data.message.morse, '.... . .-.. .-.. --- / -... --- -... / .---- ..---');
    const received = await api(env, `/api/conversations/${id}`, { cookie: bob });
    assert.equal(received.data.messages[0].text, body.text);
    const duplicate = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body });
    assert.equal(duplicate.data.message.id, first.data.message.id);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_messages').get().n, 1);
    assert.equal(env.DB.sqlite.prepare("SELECT count FROM chat_rate_limits WHERE actor = 'messages:alice'").get().count, 1);
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { ...body, text: 'Different' } })).response.status, 409);
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { text: '🙂', clientId: 'emoji' } })).response.status, 400);
  } finally { env.DB.close(); }
});

test('raw Morse sends are decoded by the server and stay idempotent across formatting changes', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const body = { kind: 'morse', morse: '.... / .. // -- / -.-- // .---- / ..---',
      text: 'forged readable text', clientId: 'raw-one' };
    const first = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body });
    assert.equal(first.response.status, 201);
    assert.deepEqual([first.data.message.kind, first.data.message.text, first.data.message.morse],
      ['morse', 'HI MY 12', '.... .. / -- -.-- / .---- ..---']);
    const received = (await api(env, `/api/conversations/${id}`, { cookie: bob })).data.messages[0];
    assert.equal(received.kind, 'morse');
    assert.equal(received.text, 'HI MY 12');
    const repeat = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { ...body, morse: '.... / ..//--/-.--//.----/..---/' } });
    assert.equal(repeat.data.message.id, first.data.message.id);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_messages').get().n, 1);
    assert.equal(env.DB.sqlite.prepare("SELECT count FROM chat_rate_limits WHERE actor = 'messages:alice'").get().count, 1);
    for (const changed of [
      { kind: 'text', text: 'HI MY 12', clientId: body.clientId },
      { ...body, morse: '....//..//--/-.--//.----/..---' },
      { ...body, morse: '.... / .. // -- / -.-- // .---- / ...--' },
    ]) {
      const conflict = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body: changed });
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.data.error.code, 'message_conflict');
    }
  } finally { env.DB.close(); }
});

test('raw Morse enforces membership, valid groups, and the selected message kind', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const id = await friends(env, alice, bob);
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: carol,
      body: { kind: 'morse', morse: '.... / ..', clientId: 'outsider' } })).response.status, 404);
    for (const body of [
      { kind: 'morse', morse: '..--..', clientId: 'punctuation' },
      { kind: 'morse', morse: '.... / ..!', clientId: 'symbol' },
      { kind: 'morse', morse: '.-///-...', clientId: 'separator' },
      { kind: 'morse', text: 'HI', clientId: 'missing' },
      { kind: 'unknown', text: 'HI', clientId: 'kind' },
      { kind: null, text: 'HI', clientId: 'null-kind' },
    ]) {
      assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body })).response.status, 400);
    }
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_messages').get().n, 0);
  } finally { env.DB.close(); }
});

test('migrated text messages retain their original content and receive the text kind by default', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const text = '  Original,\nspacing!  ';
    env.DB.sqlite.prepare(`INSERT INTO chat_messages(conversation_id,sender_id,text,morse,client_id,created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, 'alice', text, encodeMorse(text), 'old-client', Date.now());
    const received = (await api(env, `/api/conversations/${id}`, { cookie: bob })).data.messages[0];
    assert.equal(received.kind, 'text');
    assert.equal(received.text, text);
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { text, clientId: 'old-client' } })).data.message.id, received.id);
  } finally { env.DB.close(); }
});

test('unread counts exclude own messages and only the current member can clear them', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'one' } });
    assert.equal((await api(env, '/api/inbox', { cookie: alice })).data.unread, 0);
    const inbox = (await api(env, '/api/inbox', { cookie: bob })).data;
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.conversations[0].name, 'alice');
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: {} });
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.unread, 0);
  } finally { env.DB.close(); }
});

test('empty-room after=0 polling works and read-through never marks unseen messages or moves backwards', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const empty = await api(env, `/api/conversations/${id}?after=0`, { cookie: bob });
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.data.messages, []);
    const first = (await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { text: 'FIRST', clientId: 'first' } })).data.message;
    const second = (await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice,
      body: { text: 'SECOND', clientId: 'second' } })).data.message;
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: { through: first.id } });
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.unread, 1);
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: { through: 0 } });
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.unread, 1);
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: { through: second.id } });
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.unread, 0);
    assert.equal((await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob,
      body: { through: -1 } })).response.status, 400);
  } finally { env.DB.close(); }
});

test('friend lookup attempts are throttled even when no target exists', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const first = await api(env, '/api/friends/request', { method: 'POST', cookie: alice, body: { target: 'missing@example.com' } });
    assert.equal(first.response.status, 404);
    env.DB.sqlite.prepare("UPDATE chat_rate_limits SET count = 30 WHERE actor = 'friends:alice'").run();
    const limited = await api(env, '/api/friends/request', { method: 'POST', cookie: alice, body: { target: 'another@example.com' } });
    assert.equal(limited.response.status, 429);
  } finally { env.DB.close(); }
});

test('logout requires the configured origin and invalidates the current session only', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    assert.equal((await api(env, '/api/logout', { method: 'POST', cookie: alice, origin: 'https://attacker.test' })).response.status, 403);
    const logout = await api(env, '/api/logout', { method: 'POST', cookie: alice });
    assert.equal(logout.response.status, 200);
    assert.match(logout.response.headers.get('Set-Cookie'), /Max-Age=0; Secure/);
    assert.equal((await api(env, '/api/me', { cookie: alice })).data.user, null);
    assert.equal((await api(env, '/api/me', { cookie: bob })).data.user.id, 'bob');
  } finally { env.DB.close(); }
});

test('repeating an acknowledged read position performs no database write', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const sent = await api(env, `/api/conversations/${id}/messages`, {
      method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'read-budget' },
    });
    const through = sent.data.message.id;
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: { through } });
    const changes = env.DB.sqlite.prepare('SELECT total_changes() AS count').get().count;
    await api(env, `/api/conversations/${id}/read`, { method: 'POST', cookie: bob, body: { through } });
    assert.equal(env.DB.sqlite.prepare('SELECT total_changes() AS count').get().count, changes);
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.unread, 0);
  } finally { env.DB.close(); }
});

test('initial, before, and after message pages stay chronological without exposing other conversations', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const insert = env.DB.sqlite.prepare('INSERT INTO chat_messages(conversation_id,sender_id,text,morse,client_id,created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let index = 1; index <= 230; index += 1) insert.run(id, 'alice', 'HI', '.... ..', `client-${index}`, index);
    const newest = (await api(env, `/api/conversations/${id}`, { cookie: bob })).data;
    assert.deepEqual([newest.messages[0].id, newest.messages.at(-1).id, newest.hasMore, newest.nextCursor], [131, 230, true, 131]);
    const earlier = (await api(env, `/api/conversations/${id}?before=131`, { cookie: bob })).data;
    assert.deepEqual([earlier.messages[0].id, earlier.messages.at(-1).id, earlier.nextCursor], [31, 130, 31]);
    const oldest = (await api(env, `/api/conversations/${id}?before=31`, { cookie: bob })).data;
    assert.deepEqual([oldest.messages[0].id, oldest.messages.at(-1).id, oldest.hasMore], [1, 30, false]);
    const polled = (await api(env, `/api/conversations/${id}?after=225`, { cookie: bob })).data;
    assert.deepEqual(polled.messages.map((message) => message.id), [226, 227, 228, 229, 230]);
    assert.equal((await api(env, `/api/conversations/${id}?after=-1`, { cookie: bob })).response.status, 400);
  } finally { env.DB.close(); }
});

test('verified-email discovery never silently chooses among multiple provider accounts', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    await person(env, 'bob', 'bob', 'shared@example.com');
    await person(env, 'carol', 'carol', 'shared@example.com');
    const ambiguous = await api(env, '/api/friends/request', { method: 'POST', cookie: alice, body: { target: 'shared@example.com' } });
    assert.equal(ambiguous.response.status, 409);
    assert.equal(ambiguous.data.error.code, 'ambiguous_email');
  } finally { env.DB.close(); }
});

test('message rate limiting rejects a new send while allowing an existing retry', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const sent = await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'existing' } });
    env.DB.sqlite.prepare("UPDATE chat_rate_limits SET count = 60 WHERE actor = 'messages:alice'").run();
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'new' } })).response.status, 429);
    assert.equal((await api(env, `/api/conversations/${id}/messages`, { method: 'POST', cookie: alice, body: { text: 'HI', clientId: 'existing' } })).data.message.id, sent.data.message.id);
  } finally { env.DB.close(); }
});

test('oversized chunked JSON is cancelled before the entire body is buffered', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(9000)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://morse.test/api/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half',
  });
  await assert.rejects(readJSON(request), (error) => error.status === 413);
  assert.equal(cancelled, true);
});
