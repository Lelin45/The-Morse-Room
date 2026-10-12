import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, person, api, friends } from './helpers/chat-db.mjs';
import { createSession } from '../server/chat/auth.js';

const post = (cookie, body) => ({ method: 'POST', cookie, body });
const count = (env, table) => env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function group(env, ownerCookie, members = []) {
  const created = await api(env, '/api/groups', post(ownerCookie, { name: 'Listening group' }));
  assert.equal(created.response.status, 201);
  for (const cookie of members) assert.equal((await api(env, '/api/groups/join', post(cookie, { code: created.data.code }))).response.status, 200);
  return created.data.conversation.id;
}

async function send(env, id, cookie, text = 'HI', clientId = crypto.randomUUID()) {
  const sent = await api(env, `/api/conversations/${id}/messages`, post(cookie, { text, clientId }));
  assert.equal(sent.response.status, 201);
  return sent.data.message;
}

async function reviewer(env, id) {
  const cookie = await person(env, id);
  env.DB.sqlite.prepare('INSERT INTO chat_review_users(user_id) VALUES (?)').run(id);
  return cookie;
}

function snapshots(env) {
  const tables = env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, env.DB.sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
}

test('account deletion requires its own signed-in session, same origin and exact confirmation, including an unfinished profile', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice', null);
    const bob = await person(env, 'bob');
    assert.equal((await api(env, '/api/account/delete', post(undefined, { confirmation: 'DELETE' }))).response.status, 401);
    for (const origin of [null, 'https://attacker.test']) {
      assert.equal((await api(env, '/api/account/delete', { ...post(alice, { confirmation: 'DELETE' }), origin })).response.status, 403);
    }
    for (const confirmation of [undefined, true, 'delete', 'DELETE ', '']) {
      assert.equal((await api(env, '/api/account/delete', post(alice, { confirmation }))).response.status, 400);
    }
    assert.equal(count(env, 'chat_users'), 2);
    const deleted = await api(env, '/api/account/delete', post(alice, { confirmation: 'DELETE', userId: 'bob', id: 'bob' }));
    assert.deepEqual(deleted.data, { ok: true, deleted: true });
    assert.equal(deleted.response.status, 200);
    assert.match(deleted.response.headers.get('Set-Cookie'), /Max-Age=0; Secure/);
    assert.equal((await api(env, '/api/me', { cookie: alice })).data.user, null);
    assert.equal((await api(env, '/api/me', { cookie: bob })).data.user.id, 'bob');
    assert.deepEqual(env.DB.sqlite.prepare('SELECT id FROM chat_users').all().map((row) => row.id), ['bob']);
  } finally { env.DB.close(); }
});

test('deletion removes every account association and both direct memberships while retaining unrelated people and group messages', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const dave = await person(env, 'dave');
    const eve = await person(env, 'eve');
    await createSession('alice', env);
    env.DB.sqlite.exec("INSERT INTO chat_identities VALUES ('google','alice-google','alice'); INSERT INTO chat_identities VALUES ('google','bob-google','bob');");
    env.DB.sqlite.exec("INSERT INTO chat_mobile_codes VALUES ('alice-ticket','alice','alice-challenge',9999999999999); INSERT INTO chat_mobile_codes VALUES ('bob-ticket','bob','bob-challenge',9999999999999);");
    const aliceBob = await friends(env, alice, bob);
    const carolAlice = await friends(env, carol, alice, 'alice');
    const unrelated = await friends(env, bob, carol, 'carol');
    const shared = await group(env, alice, [carol, bob]);
    env.DB.sqlite.prepare('UPDATE chat_members SET joined_at = ? WHERE conversation_id = ? AND user_id = ?').run(1, shared, 'bob');
    env.DB.sqlite.prepare('UPDATE chat_members SET joined_at = ? WHERE conversation_id = ? AND user_id = ?').run(2, shared, 'carol');
    const alone = await group(env, alice);
    const otherOwned = await group(env, carol, [alice]);
    const daveGroup = await group(env, dave);
    await send(env, aliceBob, alice, 'ALICE DM');
    await send(env, aliceBob, bob, 'BOB DM');
    await send(env, carolAlice, carol, 'CAROL DM');
    const otherDirect = await send(env, unrelated, bob, 'UNRELATED');
    const ownMessage = await send(env, shared, alice, 'ALICE GROUP');
    const bobMessage = await send(env, shared, bob, 'BOB GROUP');
    const otherGroupMessage = await send(env, otherOwned, carol, 'CAROL GROUP');
    assert.equal((await api(env, '/api/reports', post(alice, { messageId: bobMessage.id, reason: 'spam' }))).response.status, 200);
    assert.equal((await api(env, '/api/reports', post(bob, { messageId: ownMessage.id, reason: 'other' }))).response.status, 200);
    await api(env, '/api/friends/request', post(alice, { target: 'dave' }));
    await api(env, '/api/friends/request', post(eve, { target: 'alice' }));
    await api(env, '/api/blocks', post(alice, { userId: 'bob' }));
    await api(env, '/api/blocks', post(bob, { userId: 'alice' }));
    assert.equal((await api(env, '/api/account/delete', post(alice, { confirmation: 'DELETE' }))).response.status, 200);
    for (const [table, column] of [['chat_sessions','user_id'],['chat_identities','user_id'],['chat_mobile_codes','user_id'],['chat_members','user_id'],['chat_messages','sender_id']]) {
      assert.equal(env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 'alice'`).get().n, 0);
    }
    assert.equal(count(env, 'chat_blocks'), 0);
    assert.equal(count(env, 'chat_reports'), 0);
    assert.equal(count(env, 'chat_friend_requests'), 0);
    assert.equal(count(env, 'chat_friends'), 1);
    assert.deepEqual(env.DB.sqlite.prepare('SELECT id FROM chat_users ORDER BY id').all().map((row) => row.id), ['bob','carol','dave','eve']);
    for (const id of [aliceBob, carolAlice, alone]) assert.equal(env.DB.sqlite.prepare('SELECT id FROM chat_conversations WHERE id = ?').get(id), undefined);
    assert.equal(env.DB.sqlite.prepare('SELECT owner_id FROM chat_conversations WHERE id = ?').get(shared).owner_id, 'bob');
    assert.equal(env.DB.sqlite.prepare('SELECT owner_id FROM chat_conversations WHERE id = ?').get(otherOwned).owner_id, 'carol');
    assert.equal(env.DB.sqlite.prepare('SELECT owner_id FROM chat_conversations WHERE id = ?').get(daveGroup).owner_id, 'dave');
    assert.deepEqual(env.DB.sqlite.prepare('SELECT id FROM chat_messages ORDER BY id').all().map((row) => row.id), [otherDirect.id, bobMessage.id, otherGroupMessage.id]);
    assert.equal((await api(env, '/api/me', { cookie: bob })).data.user.id, 'bob');
    assert.equal((await api(env, `/api/conversations/${shared}`, { cookie: bob })).response.status, 200);
    assert.equal((await api(env, `/api/conversations/${unrelated}`, { cookie: carol })).response.status, 200);
    assert.equal(env.DB.sqlite.prepare("SELECT subject FROM chat_identities WHERE user_id = 'bob'").get().subject, 'bob-google');
    assert.equal(env.DB.sqlite.prepare("SELECT token_hash FROM chat_mobile_codes WHERE user_id = 'bob'").get().token_hash, 'bob-ticket');
  } finally { env.DB.close(); }
});

test('a failed deletion rolls back ownership transfers, message deletion, conversations and sessions together', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const dm = await friends(env, alice, bob);
    const shared = await group(env, alice, [bob]);
    await send(env, dm, alice, 'PRIVATE');
    await send(env, shared, alice, 'GROUP');
    env.DB.sqlite.exec("CREATE TRIGGER fail_account_deletion BEFORE DELETE ON chat_users WHEN OLD.id = 'alice' BEGIN SELECT RAISE(ABORT, 'Injected failure'); END;");
    const before = snapshots(env);
    const response = await api(env, '/api/account/delete', post(alice, { confirmation: 'DELETE' }));
    assert.equal(response.response.status, 500);
    assert.equal(response.response.headers.has('Set-Cookie'), false);
    assert.deepEqual(snapshots(env), before);
    assert.equal((await api(env, '/api/me', { cookie: alice })).data.user.id, 'alice');
    assert.equal((await api(env, `/api/conversations/${dm}`, { cookie: bob })).data.messages[0].text, 'PRIVATE');
  } finally { env.DB.close(); }
});

test('blocks stop direct contact in both directions, preserve its history and expose only the caller block list', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const id = await friends(env, alice, bob);
    await send(env, id, alice, 'BEFORE');
    const detail = (await api(env, `/api/conversations/${id}`, { cookie: bob })).data;
    assert.deepEqual(detail.conversation.peer, { id: 'alice', username: 'alice' });
    assert.equal((await api(env, '/api/blocks', post(alice, { userId: 'bob' }))).response.status, 200);
    await api(env, '/api/blocks', post(carol, { userId: 'alice' }));
    assert.deepEqual((await api(env, '/api/blocks', { cookie: bob })).data.blocks, []);
    const own = (await api(env, '/api/blocks', { cookie: alice })).data.blocks;
    assert.deepEqual(own.map(({ id, username }) => ({ id, username })), [{ id: 'bob', username: 'bob' }]);
    assert.deepEqual(Object.keys(own[0]).sort(), ['createdAt','id','username']);
    for (const [cookie, target] of [[alice,'bob'],[bob,'alice']]) {
      assert.equal((await api(env, '/api/inbox', { cookie })).data.conversations.length, 0);
      assert.equal((await api(env, '/api/inbox', { cookie })).data.friends.length, 0);
      assert.equal((await api(env, `/api/conversations/${id}`, { cookie })).response.status, 404);
      assert.equal((await api(env, `/api/conversations/${id}/messages`, post(cookie, { text: 'BLOCKED', clientId: 'blocked' }))).response.status, 404);
      assert.equal((await api(env, `/api/conversations/${id}/read`, post(cookie, {}))).response.status, 404);
      assert.equal((await api(env, '/api/friends/request', post(cookie, { target }))).data.error.code, 'person_not_found');
    }
    assert.equal(count(env, 'chat_messages'), 1);
    await api(env, '/api/blocks/remove', post(bob, { userId: 'bob', blockerId: 'alice' }));
    assert.equal(count(env, 'chat_blocks'), 2);
    await api(env, '/api/blocks/remove', post(alice, { userId: 'bob' }));
    assert.equal((await api(env, `/api/conversations/${id}`, { cookie: bob })).data.messages[0].text, 'BEFORE');
    assert.equal(count(env, 'chat_blocks'), 1);
  } finally { env.DB.close(); }
});

test('blocking removes pending requests, rejects unsafe targets and duplicate blocks are idempotent', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    await api(env, '/api/friends/request', post(bob, { target: 'alice' }));
    const request = (await api(env, '/api/inbox', { cookie: alice })).data.requests[0];
    for (const [body, status] of [[{ userId: 'alice' },400],[{ userId: 'missing' },404],[{ userId: '../bob' },400]]) {
      assert.equal((await api(env, '/api/blocks', post(alice, body))).response.status, status);
    }
    assert.equal((await api(env, '/api/blocks', { ...post(alice, { userId: 'bob' }), origin: 'https://attacker.test' })).response.status, 403);
    await api(env, '/api/blocks', post(alice, { userId: 'bob' }));
    assert.equal(count(env, 'chat_friend_requests'), 0);
    assert.equal((await api(env, '/api/friends/respond', post(alice, { id: request.id, accept: true }))).response.status, 404);
    const before = env.DB.sqlite.prepare("SELECT count FROM chat_rate_limits WHERE actor = 'blocks:alice'").get().count;
    await api(env, '/api/blocks', post(alice, { userId: 'bob' }));
    assert.equal(count(env, 'chat_blocks'), 1);
    assert.equal(env.DB.sqlite.prepare("SELECT count FROM chat_rate_limits WHERE actor = 'blocks:alice'").get().count, before);
  } finally { env.DB.close(); }
});

test('shared group messages, every pagination direction and unread counts omit blocked senders without leaking block ownership', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const id = await group(env, alice, [bob, carol]);
    const first = await send(env, id, carol, 'VISIBLE FIRST');
    await send(env, id, bob, 'HIDDEN FIRST');
    const second = await send(env, id, carol, 'VISIBLE SECOND');
    const last = await send(env, id, bob, 'HIDDEN LAST');
    await api(env, '/api/blocks', post(alice, { userId: 'bob' }));
    for (const suffix of ['', '?after=0', `?before=${last.id + 1}`]) {
      const detail = (await api(env, `/api/conversations/${id}${suffix}`, { cookie: alice })).data;
      assert.deepEqual(detail.messages.map((message) => message.id), [first.id,second.id]);
      assert.equal(detail.members.length, 3);
      assert.equal('blocks' in detail, false);
    }
    const inbox = (await api(env, '/api/inbox', { cookie: alice })).data;
    assert.equal(inbox.unread, 2);
    assert.equal(inbox.conversations[0].lastMessageAt, second.createdAt);
    await api(env, `/api/conversations/${id}/read`, post(alice, {}));
    assert.equal(env.DB.sqlite.prepare('SELECT last_read_message_id FROM chat_members WHERE conversation_id = ? AND user_id = ?').get(id, 'alice').last_read_message_id, second.id);
    assert.equal((await api(env, '/api/inbox', { cookie: alice })).data.unread, 0);
    const aliceMessage = await send(env, id, alice, 'ALICE HIDDEN FROM BOB');
    assert.equal((await api(env, `/api/conversations/${id}`, { cookie: bob })).data.messages.some((message) => message.id === aliceMessage.id), false);
    assert.equal((await api(env, `/api/conversations/${id}`, { cookie: carol })).data.messages.length, 5);
  } finally { env.DB.close(); }
});

test('reports require access to another person visible message and retain server evidence for moderation only', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const id = await friends(env, alice, bob);
    const message = await send(env, id, bob, 'Reported original');
    assert.equal((await api(env, '/api/reports', post(carol, { messageId: message.id, reason: 'spam' }))).response.status, 404);
    assert.equal((await api(env, '/api/reports', post(bob, { messageId: message.id, reason: 'spam' }))).response.status, 400);
    for (const body of [{ messageId: -1, reason: 'spam' }, { messageId: `${message.id}`, reason: 'spam' },
      { messageId: message.id, reason: 'forged' }, { messageId: message.id, reason: 'other', details: 'A'.repeat(1001) }]) {
      assert.equal((await api(env, '/api/reports', post(alice, body))).response.status, 400);
    }
    const sent = await api(env, '/api/reports', post(alice, { messageId: message.id, reason: 'harassment', details: '  Please review  ',
      reporterId: 'carol', subjectId: 'carol', evidence_text: 'forged' }));
    assert.equal(sent.response.status, 200);
    assert.deepEqual(Object.keys(sent.data).sort(), ['ok','reportId']);
    const saved = env.DB.sqlite.prepare('SELECT * FROM chat_reports WHERE id = ?').get(sent.data.reportId);
    assert.equal(saved.reporter_id, 'alice');
    assert.equal(saved.subject_id, 'bob');
    assert.equal(saved.evidence_text, message.text);
    assert.equal(saved.evidence_morse, message.morse);
    assert.equal(saved.details, 'Please review');
    assert.equal(saved.status, 'pending');
    assert.equal((await api(env, '/api/reports', { cookie: alice })).response.status, 404);
    await api(env, '/api/blocks', post(alice, { userId: 'bob' }));
    assert.equal((await api(env, '/api/reports', post(alice, { messageId: message.id, reason: 'spam' }))).response.status, 404);
  } finally { env.DB.close(); }
});

test('report duplicates keep one evidence record and new reports are throttled without blocking successful retries', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const id = await friends(env, alice, bob);
    const first = await send(env, id, bob);
    const second = await send(env, id, bob, 'SECOND');
    const saved = await api(env, '/api/reports', post(alice, { messageId: first.id, reason: 'spam' }));
    env.DB.sqlite.prepare("UPDATE chat_rate_limits SET count = 10 WHERE actor = 'reports:alice'").run();
    const repeated = await api(env, '/api/reports', post(alice, { messageId: first.id, reason: 'other', details: 'Changed' }));
    assert.equal(repeated.data.reportId, saved.data.reportId);
    assert.equal(env.DB.sqlite.prepare('SELECT reason FROM chat_reports').get().reason, 'spam');
    assert.equal((await api(env, '/api/reports', post(alice, { messageId: second.id, reason: 'spam' }))).response.status, 429);
    assert.equal(count(env, 'chat_reports'), 1);
  } finally { env.DB.close(); }
});

test('deleting either the reporter or the reported author removes associated evidence and keeps other group accounts', async () => {
  for (const deleting of ['alice','bob']) {
    const env = testEnv();
    try {
      const alice = await person(env, 'alice');
      const bob = await person(env, 'bob');
      const carol = await person(env, 'carol');
      const id = await group(env, carol, [alice,bob]);
      const message = await send(env, id, bob, 'REPORTED');
      await api(env, '/api/reports', post(alice, { messageId: message.id, reason: 'spam' }));
      assert.equal(count(env, 'chat_reports'), 1);
      await api(env, '/api/account/delete', post(deleting === 'alice' ? alice : bob, { confirmation: 'DELETE' }));
      assert.equal(count(env, 'chat_reports'), 0);
      assert.equal(count(env, 'chat_users'), 2);
      assert.equal((await api(env, `/api/conversations/${id}`, { cookie: carol })).response.status, 200);
    } finally { env.DB.close(); }
  }
});

test('configuration fails closed when account safety tables have not been migrated', async () => {
  const env = testEnv();
  try {
    assert.equal((await api(env, '/api/config')).data.available, true);
    env.DB.sqlite.exec('DROP TABLE chat_reports');
    assert.equal((await api(env, '/api/config')).data.available, false);
  } finally { env.DB.close(); }
});

test('a block arriving between authorization and insertion prevents new direct messages and friend requests', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const carol = await person(env, 'carol');
    const dm = await friends(env, alice, bob);
    const original = env.DB.prepare.bind(env.DB);
    let pending = { pattern: /^INSERT INTO chat_messages/, target: 'bob' };
    env.DB.prepare = (sql) => {
      const statement = original(sql);
      const originalRun = statement.run;
      statement.run = async () => {
        if (pending && pending.pattern.test(sql)) {
          env.DB.sqlite.prepare('INSERT INTO chat_blocks(blocker_id,blocked_id,created_at) VALUES (?, ?, ?)').run(pending.target, 'alice', Date.now());
          pending = null;
        }
        return originalRun.call(statement);
      };
      return statement;
    };
    const blocked = await api(env, `/api/conversations/${dm}/messages`, post(alice, { text: 'RACE', clientId: 'race' }));
    assert.equal(blocked.response.status, 403);
    assert.equal(count(env, 'chat_messages'), 0);
    pending = { pattern: /^INSERT INTO chat_friend_requests/, target: 'carol' };
    await api(env, '/api/friends/request', post(alice, { target: 'carol' }));
    assert.equal(count(env, 'chat_friend_requests'), 0);
    assert.equal((await api(env, '/api/blocks', { cookie: carol })).data.blocks[0].id, 'alice');
  } finally { env.DB.close(); }
});

test('review sessions can contact other sandbox people while real accounts and group invite codes remain isolated', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const reviewOne = await reviewer(env, 'review-one');
    const reviewTwo = await reviewer(env, 'review-two');
    assert.deepEqual((await api(env, '/api/me', { cookie: reviewOne })).data.user, { id: 'review-one', username: 'review-one', isReviewer: true });
    assert.deepEqual((await api(env, '/api/me', { cookie: alice })).data.user, { id: 'alice', username: 'alice' });
    for (const [cookie, target] of [[reviewOne, 'alice'], [reviewOne, 'alice@example.com'], [alice, 'review-one'], [alice, 'review-one@example.com']]) {
      const response = await api(env, '/api/friends/request', post(cookie, { target }));
      assert.equal(response.response.status, 404);
      assert.equal(response.data.error.code, 'person_not_found');
    }
    const sandboxDm = await friends(env, reviewOne, reviewTwo, 'review-two');
    const liveDm = await friends(env, alice, bob);
    assert.equal((await api(env, `/api/conversations/${sandboxDm}`, { cookie: reviewOne })).response.status, 200);
    assert.equal((await api(env, `/api/conversations/${liveDm}`, { cookie: reviewOne })).response.status, 404);
    const sandboxGroup = await api(env, '/api/groups', post(reviewOne, { name: 'Review group' }));
    const liveGroup = await api(env, '/api/groups', post(alice, { name: 'Real group' }));
    assert.equal((await api(env, '/api/groups/join', post(alice, { code: sandboxGroup.data.code }))).response.status, 404);
    assert.equal((await api(env, '/api/groups/join', post(reviewOne, { code: liveGroup.data.code }))).response.status, 404);
    assert.equal((await api(env, '/api/groups/join', post(reviewTwo, { code: sandboxGroup.data.code }))).response.status, 200);
    assert.equal((await api(env, '/api/blocks', post(reviewOne, { userId: 'alice' }))).response.status, 404);
    assert.equal((await api(env, '/api/blocks', post(alice, { userId: 'review-one' }))).response.status, 404);
  } finally { env.DB.close(); }
});

test('even injected cross-sandbox requests and memberships cannot expose messages or be accepted', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const reviewOne = await reviewer(env, 'review-one');
    const reviewTwo = await reviewer(env, 'review-two');
    const realGroup = await group(env, alice, [bob]);
    const realMessage = await send(env, realGroup, bob, 'PRIVATE REAL MESSAGE');
    const sandboxGroup = await group(env, reviewOne, [reviewTwo]);
    const sandboxMessage = await send(env, sandboxGroup, reviewTwo, 'SANDBOX ONLY');
    env.DB.sqlite.prepare('INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?, ?, ?)').run(realGroup, 'review-one', 1);
    env.DB.sqlite.prepare('INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?, ?, ?)').run(sandboxGroup, 'alice', 1);
    env.DB.sqlite.prepare('INSERT INTO chat_friend_requests(id,sender_id,recipient_id,pair_key,created_at) VALUES (?, ?, ?, ?, ?)')
      .run('cross-request', 'alice', 'review-one', 'alice:review-one', Date.now());
    assert.equal((await api(env, '/api/friends/respond', post(reviewOne, { id: 'cross-request', accept: true }))).response.status, 404);
    for (const [cookie, id, messageId] of [[reviewOne,realGroup,realMessage.id],[alice,sandboxGroup,sandboxMessage.id]]) {
      assert.equal((await api(env, `/api/conversations/${id}`, { cookie })).response.status, 404);
      assert.equal((await api(env, `/api/conversations/${id}/messages`, post(cookie, { text: 'FORGED', clientId: 'forged' }))).response.status, 404);
      assert.equal((await api(env, `/api/conversations/${id}/read`, post(cookie, {}))).response.status, 404);
      assert.equal((await api(env, '/api/reports', post(cookie, { messageId, reason: 'spam' }))).response.status, 404);
      const inbox = (await api(env, '/api/inbox', { cookie })).data;
      assert.equal(inbox.conversations.length, 0);
      assert.equal(inbox.requests.length, 0);
    }
    assert.equal(count(env, 'chat_reports'), 0);
    assert.equal(count(env, 'chat_friends'), 0);
    assert.equal(count(env, 'chat_messages'), 2);
  } finally { env.DB.close(); }
});

test('deleting a sandbox account clears its reviewer marker without changing real sessions or conversations', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    const bob = await person(env, 'bob');
    const reviewOne = await reviewer(env, 'review-one');
    const reviewTwo = await reviewer(env, 'review-two');
    const realDm = await friends(env, alice, bob);
    const message = await send(env, realDm, alice, 'REAL');
    const sandboxDm = await friends(env, reviewOne, reviewTwo, 'review-two');
    await send(env, sandboxDm, reviewTwo, 'SANDBOX');
    assert.equal((await api(env, '/api/account/delete', post(reviewOne, { confirmation: 'DELETE', userId: 'alice' }))).response.status, 200);
    assert.equal(count(env, 'chat_review_users'), 1);
    assert.equal((await api(env, '/api/me', { cookie: alice })).data.user.id, 'alice');
    assert.equal((await api(env, `/api/conversations/${realDm}`, { cookie: bob })).data.messages[0].id, message.id);
    assert.equal(env.DB.sqlite.prepare('SELECT id FROM chat_conversations WHERE id = ?').get(sandboxDm), undefined);
  } finally { env.DB.close(); }
});
