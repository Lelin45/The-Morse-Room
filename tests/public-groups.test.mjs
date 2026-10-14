import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, person, api } from './helpers/chat-db.mjs';
import { readFileSync } from 'node:fs';

const post = (cookie, body) => ({ method: 'POST', cookie, body });
async function group(env, owner, visibility = 'public', name = 'Listening group') {
  const result = await api(env, '/api/groups', post(owner, { name, visibility }));
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function request(env, cookie, groupId) {
  const result = await api(env, '/api/groups/request', post(cookie, { groupId }));
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data.requestId;
}

test('public directory supports literal name search, counts, membership and no private codes or messages', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob');
    const publicGroup = await group(env, alice, 'public', 'Evening 100%_signals');
    const privateGroup = await group(env, alice, 'private', 'Secret listeners');
    assert.equal((await api(env, '/api/groups/public')).response.status, 401);
    const directory = await api(env, '/api/groups/public', { cookie: bob });
    assert.equal(directory.response.status, 200);
    assert.deepEqual(directory.data.groups.map((item) => item.id), [publicGroup.conversation.id]);
    assert.deepEqual([directory.data.groups[0].memberCount, directory.data.groups[0].memberLimit, directory.data.groups[0].joined], [1, 100, false]);
    assert.equal(Object.hasOwn(directory.data.groups[0], 'code'), false);
    assert.equal(Object.hasOwn(directory.data.groups[0], 'messages'), false);
    assert.equal(JSON.stringify(directory.data).includes(privateGroup.code), false);
    assert.equal((await api(env, '/api/groups/public?q=%25_', { cookie: bob })).data.groups.length, 1);
    assert.equal((await api(env, '/api/groups/public?q=missing', { cookie: bob })).data.groups.length, 0);
    assert.equal((await api(env, '/api/groups/request', post(bob, { groupId: privateGroup.conversation.id }))).response.status, 404);
    assert.equal((await api(env, `/api/conversations/${publicGroup.conversation.id}`, { cookie: bob })).response.status, 404);
  } finally { env.DB.close(); }
});

test('public invites request permission, duplicate requests are idempotent, only creator moderates', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob'), carol = await person(env, 'carol');
    const created = await group(env, alice);
    const groupId = created.conversation.id;
    const requested = await api(env, '/api/groups/join', post(bob, { code: created.code }));
    assert.equal(requested.data.requested, true);
    const requestId = requested.data.requestId;
    assert.equal(await request(env, bob, groupId), requestId);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_group_requests').get().n, 1);
    assert.equal((await api(env, '/api/groups/public', { cookie: bob })).data.groups[0].requested, true);
    const inbox = (await api(env, '/api/inbox', { cookie: alice })).data;
    assert.deepEqual([inbox.groupRequests[0].id, inbox.groupRequests[0].username, inbox.groupRequests[0].groupName], [requestId, 'bob', 'Listening group']);
    assert.equal((await api(env, '/api/inbox', { cookie: carol })).data.groupRequests.length, 0);
    assert.equal((await api(env, '/api/groups/respond', post(carol, { id: requestId, accept: true }))).response.status, 403);
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: requestId, accept: true }))).response.status, 200);
    const detail = (await api(env, `/api/conversations/${groupId}`, { cookie: bob })).data;
    assert.deepEqual([detail.conversation.ownerId, detail.conversation.visibility, detail.conversation.memberCount], ['alice', 'public', 2]);
    assert.equal(Object.hasOwn(detail.conversation, 'code'), false);
    assert.equal((await api(env, '/api/groups/public', { cookie: bob })).data.groups[0].joined, true);
    assert.equal((await api(env, '/api/inbox', { cookie: alice })).data.groupRequests.length, 0);
    const declined = await request(env, carol, groupId);
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: declined, accept: false }))).response.status, 200);
    assert.equal((await api(env, `/api/conversations/${groupId}`, { cookie: carol })).response.status, 404);
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: declined, accept: true }))).response.status, 404);
  } finally { env.DB.close(); }
});

test('only creator can remove members, revoking reads, sends, read receipts and old invite access', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob'), carol = await person(env, 'carol');
    const created = await group(env, alice, 'private');
    const groupId = created.conversation.id;
    await api(env, '/api/groups/join', post(bob, { code: created.code }));
    await api(env, '/api/groups/join', post(carol, { code: created.code }));
    assert.equal((await api(env, '/api/groups/kick', post(carol, { groupId, userId: 'bob' }))).response.status, 403);
    assert.equal((await api(env, '/api/groups/kick', post(alice, { groupId, userId: 'alice' }))).response.status, 400);
    assert.equal((await api(env, '/api/groups/kick', post(alice, { groupId, userId: 'bob' }))).response.status, 200);
    for (const [path, options] of [
      [`/api/conversations/${groupId}`, { cookie: bob }],
      [`/api/conversations/${groupId}/messages`, post(bob, { text: 'HI', clientId: 'removed' })],
      [`/api/conversations/${groupId}/read`, post(bob, {})],
    ]) assert.equal((await api(env, path, options)).response.status, 404);
    assert.equal((await api(env, '/api/groups/join', post(bob, { code: created.code }))).response.status, 403);
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.conversations.length, 0);
    assert.equal((await api(env, `/api/conversations/${groupId}`, { cookie: carol })).data.members.length, 2);
  } finally { env.DB.close(); }
});

test('public removals cannot request again and block scope hides groups and pending requests', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob'), carol = await person(env, 'carol');
    const created = await group(env, alice);
    const groupId = created.conversation.id;
    const requestId = await request(env, bob, groupId);
    await api(env, '/api/groups/respond', post(alice, { id: requestId, accept: true }));
    await api(env, '/api/groups/kick', post(alice, { groupId, userId: 'bob' }));
    assert.equal((await api(env, '/api/groups/request', post(bob, { groupId }))).response.status, 403);
    assert.equal((await api(env, '/api/groups/public', { cookie: bob })).data.groups.length, 0);
    await request(env, carol, groupId);
    assert.equal((await api(env, '/api/blocks', post(alice, { userId: 'carol' }))).response.status, 200);
    assert.equal((await api(env, '/api/inbox', { cookie: alice })).data.groupRequests.length, 0);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_group_requests').get().n, 0);
    assert.equal((await api(env, '/api/groups/public', { cookie: carol })).data.groups.length, 0);
    assert.equal((await api(env, '/api/groups/request', post(carol, { groupId }))).response.status, 404);
  } finally { env.DB.close(); }
});

test('group admission never passes 100 and an unaccepted request remains after the last seat fills', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob'), carol = await person(env, 'carol');
    const created = await group(env, alice);
    const groupId = created.conversation.id;
    const bobRequest = await request(env, bob, groupId), carolRequest = await request(env, carol, groupId);
    const insertUser = env.DB.sqlite.prepare('INSERT INTO chat_users(id,username,created_at) VALUES (?,?,1)');
    const insertMember = env.DB.sqlite.prepare('INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?,?,1)');
    for (let index = 0; index < 98; index += 1) { insertUser.run(`extra${index}`, `extra${index}`); insertMember.run(groupId, `extra${index}`); }
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: bobRequest, accept: true }))).response.status, 200);
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: carolRequest, accept: true }))).response.status, 409);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_members WHERE conversation_id = ?').get(groupId).n, 100);
    assert.equal(env.DB.sqlite.prepare('SELECT id FROM chat_group_requests WHERE id = ?').get(carolRequest).id, carolRequest);
    assert.throws(() => insertMember.run(groupId, 'carol'), /group_member_limit/);
    assert.equal((await api(env, '/api/groups/respond', post(alice, { id: carolRequest, accept: false }))).response.status, 200);
    assert.equal((await api(env, '/api/groups/request', post(carol, { groupId }))).response.status, 409);
  } finally { env.DB.close(); }
});

test('reviewer groups remain isolated and account deletion transfers creation authority and pending requests', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob'), carol = await person(env, 'carol');
    const reviewer = await person(env, 'reviewer');
    env.DB.sqlite.prepare('INSERT INTO chat_review_users(user_id) VALUES (?)').run('reviewer');
    const reviewGroup = await group(env, reviewer), realGroup = await group(env, alice);
    const realId = realGroup.conversation.id;
    assert.deepEqual((await api(env, '/api/groups/public', { cookie: reviewer })).data.groups.map((item) => item.id), [reviewGroup.conversation.id]);
    assert.equal((await api(env, '/api/groups/request', post(bob, { groupId: reviewGroup.conversation.id }))).response.status, 404);
    const accepted = await request(env, bob, realId);
    await api(env, '/api/groups/respond', post(alice, { id: accepted, accept: true }));
    const pending = await request(env, carol, realId);
    await api(env, '/api/account/delete', post(alice, { confirmation: 'DELETE' }));
    assert.equal((await api(env, '/api/inbox', { cookie: bob })).data.groupRequests[0].id, pending);
    assert.equal((await api(env, `/api/conversations/${realId}`, { cookie: bob })).data.conversation.ownerId, 'bob');
    assert.equal((await api(env, '/api/groups/respond', post(bob, { id: pending, accept: true }))).response.status, 200);
  } finally { env.DB.close(); }
});

test('creating a group validates names and visibility while old groups remain private', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice');
    for (const body of [{ name: '' }, { name: 'a' }, { name: 'Valid', visibility: 'hidden' }, { name: 'Valid', visibility: null }]) {
      assert.equal((await api(env, '/api/groups', post(alice, body))).response.status, 400);
    }
    const created = await api(env, '/api/groups', post(alice, { name: '  My   group  ' }));
    assert.equal(created.data.conversation.name, 'My group');
    assert.equal(created.data.conversation.visibility, 'private');
    assert.equal((await api(env, '/api/groups/public', { cookie: alice })).data.groups.length, 0);
  } finally { env.DB.close(); }
});

test('public-group migration preserves existing group names, invites, members and message history', () => {
  const env = testEnv(false);
  try {
    for (const name of ['0001_chat.sql', '0002_friendship_lookup.sql', '0003_morse_messages.sql', '0004_mobile_sign_in.sql', '0005_account_safety.sql', '0006_review_access.sql']) {
      env.DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    env.DB.sqlite.exec(`INSERT INTO chat_users(id,username,created_at) VALUES ('owner','owner',1);
      INSERT INTO chat_conversations(id,type,name,code,owner_id,created_at) VALUES ('old-group','group','Old group','old-invite-code12','owner',1);
      INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES ('old-group','owner',1);
      INSERT INTO chat_messages(conversation_id,sender_id,text,morse,client_id,created_at) VALUES ('old-group','owner','HI','.... ..','old-message',1);`);
    env.DB.sqlite.exec(readFileSync(new URL('../migrations/0007_public_groups.sql', import.meta.url), 'utf8'));
    const saved = env.DB.sqlite.prepare('SELECT name,code,visibility FROM chat_conversations WHERE id = ?').get('old-group');
    assert.deepEqual({ ...saved }, { name: 'Old group', code: 'old-invite-code12', visibility: 'private' });
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_members').get().n, 1);
    assert.equal(env.DB.sqlite.prepare('SELECT text FROM chat_messages').get().text, 'HI');
  } finally { env.DB.close(); }
});
