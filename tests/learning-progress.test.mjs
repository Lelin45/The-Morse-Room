import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, person, api } from './helpers/chat-db.mjs';
import { CURRICULUM } from '../server/chat/learning-progress.js';
import { handleChatRequest } from '../server/chat/api.js';
import { LearningProgressSync, mergeProgress } from '../learning-progress.js';

const body = (completed, best = {}) => ({ curriculum: CURRICULUM, completed, best });

test('account progress requires sign-in and same-origin writes, including before a chat username', async () => {
  const env = testEnv();
  try {
    const cookie = await person(env, 'learner', null);
    assert.equal((await api(env, '/api/learning-progress')).response.status, 401);
    assert.equal((await api(env, '/api/learning-progress', { cookie })).response.status, 200);
    assert.equal((await api(env, '/api/learning-progress', { method: 'POST', cookie, origin: 'https://other.test', body: body([1]) })).response.status, 403);
    const result = await api(env, '/api/learning-progress', { method: 'POST', cookie, body: body([1, 2], { 1: 90, 2: 80 }) });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.completed, [1, 2]);
  } finally { env.DB.close(); }
});

test('separate device writes merge completed lessons and retain the best score', async () => {
  const env = testEnv();
  try {
    const cookie = await person(env, 'learner');
    await api(env, '/api/learning-progress', { method: 'POST', cookie, body: body([1, 2], { 1: 95, 2: 70 }) });
    const stale = await api(env, '/api/learning-progress', { method: 'POST', cookie, body: body([1, 3], { 1: 50, 3: 88 }) });
    assert.deepEqual(stale.data.completed, [1, 2, 3]);
    assert.deepEqual(stale.data.best, { 1: 95, 2: 70, 3: 88 });
    assert.equal((await api(env, '/api/learning-progress', { method: 'POST', cookie, body: body([]) })).data.completed.length, 3);
  } finally { env.DB.close(); }
});

test('progress rejects malformed input and never reads or writes another account during a cookie switch', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob');
    for (const input of [body([19]), body(['1']), body([1], { 1: 101 }), body([1], { 1: 5.5 }), body([1], []), { ...body([1]), curriculum: 'different' }]) {
      assert.equal((await api(env, '/api/learning-progress', { method: 'POST', cookie: alice, body: input })).response.status, 400);
    }
    await api(env, '/api/learning-progress', { method: 'POST', cookie: alice, body: body([1, 2]) });
    assert.deepEqual((await api(env, '/api/learning-progress', { cookie: bob })).data.completed, []);
    for (const method of ['GET', 'POST']) {
      const request = new Request(`${env.SITE_URL}/api/learning-progress`, { method,
        headers: { Cookie: bob, 'X-Morse-Account': 'alice', ...(method === 'POST' ? { Origin: env.SITE_URL, 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body([3])) } : {}) });
      assert.equal((await handleChatRequest(request, env)).status, 409);
    }
    assert.deepEqual((await api(env, '/api/learning-progress', { cookie: bob })).data.completed, []);
  } finally { env.DB.close(); }
});

test('account deletion removes synced progress and rate limits without changing another learner', async () => {
  const env = testEnv();
  try {
    const alice = await person(env, 'alice'), bob = await person(env, 'bob');
    for (const cookie of [alice, bob]) await api(env, '/api/learning-progress', { method: 'POST', cookie, body: body([1]) });
    await api(env, '/api/account/delete', { method: 'POST', cookie: alice, body: { confirmation: 'DELETE' } });
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_lesson_progress WHERE user_id = ?').get('alice').n, 0);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_rate_limits WHERE actor = ?').get('progress:alice').n, 0);
    assert.deepEqual((await api(env, '/api/learning-progress', { cookie: bob })).data.completed, [1]);
  } finally { env.DB.close(); }
});

const storage = () => {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
};
function cloud() {
  const saved = new Map();
  const fetcher = async (_, options) => {
    const userId = options.headers['X-Morse-Account'];
    if (options.method === 'POST') saved.set(userId, mergeProgress(saved.get(userId), JSON.parse(options.body)));
    return Response.json({ userId, curriculum: CURRICULUM, ...mergeProgress(saved.get(userId)) });
  };
  return { fetcher, saved };
}
const client = (store, fetcher) => new LearningProgressSync({ curriculum: CURRICULUM, storage: store, fetcher });

test('reinstall and a separate browser restore account lessons from the cloud', async () => {
  const { fetcher } = cloud();
  const phone = client(storage(), fetcher);
  await phone.setAccount('alice');
  Object.assign(phone.progress, { completed: [1, 2], best: { 1: 95, 2: 90 } });
  await phone.save();
  const reinstalled = client(storage(), fetcher);
  await reinstalled.setAccount('alice');
  assert.deepEqual(reinstalled.progress, phone.progress);
  const browser = client(storage(), fetcher);
  await browser.setAccount('alice');
  assert.equal(Math.max(...browser.progress.completed) + 1, 3);
});

test('guest lessons can sync once while different signed-in accounts stay separate', async () => {
  const { fetcher } = cloud();
  const store = storage();
  const sync = client(store, fetcher);
  Object.assign(sync.progress, { completed: [1], best: { 1: 100 } });
  await sync.save();
  await sync.setAccount('alice');
  assert.deepEqual(sync.progress.completed, [1]);
  await sync.setAccount(null);
  assert.deepEqual(sync.progress.completed, []);
  await sync.setAccount('bob');
  assert.deepEqual(sync.progress.completed, []);
  await sync.setAccount('alice');
  assert.deepEqual(sync.progress.completed, [1]);
});

test('offline account completion survives restart and merges on reconnection', async () => {
  const remote = cloud();
  let online = false;
  const fetcher = (...args) => online ? remote.fetcher(...args) : Promise.reject(new Error('offline'));
  const store = storage();
  const first = client(store, fetcher);
  await first.setAccount('alice');
  Object.assign(first.progress, { completed: [1, 2], best: { 1: 90, 2: 80 } });
  await first.save();
  assert.equal(first.status, 'offline');
  const restarted = client(store, fetcher);
  assert.deepEqual(restarted.progress.completed, [1, 2]);
  online = true;
  await restarted.setAccount('alice');
  assert.deepEqual(remote.saved.get('alice').completed, [1, 2]);
  assert.equal(restarted.status, 'saved');
});

test('a late response for an old account cannot replace the newly selected account', async () => {
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  const sync = client(storage(), async (_, options) => options.headers['X-Morse-Account'] === 'alice' ? delayed : Response.json({ userId: 'bob', ...body([2]) }));
  const old = sync.setAccount('alice');
  await sync.setAccount('bob');
  resolve(Response.json({ userId: 'alice', ...body([1, 3]) }));
  await old;
  assert.deepEqual(sync.progress.completed, [2]);
  assert.equal(sync.userId, 'bob');
});
