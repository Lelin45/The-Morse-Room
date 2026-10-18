import { ApiError, one, batch, readJSON, requireOrigin, requireSite, hashToken,
  randomToken, rateLimit } from './db.js';
import { createSession } from './auth.js';
import { encodeMorse } from '../../chat-codec.js';

const REVIEWER = 'play-reviewer';
const BOT = 'play-review-bot';
const HELPER = 'play-review-friend';

export async function isReviewUser(env, userId) {
  return Boolean(await one(env, 'SELECT 1 AS review FROM chat_review_users WHERE user_id = ?', userId));
}

function sameHash(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    diff |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return diff === 0;
}

async function seedReview(env) {
  const now = Date.now();
  const people = [];
  for (const [id, preferred] of [[REVIEWER, 'play_reviewer'], [BOT, 'review_bot'], [HELPER, 'review_friend']]) {
    const existing = await one(env, 'SELECT username FROM chat_users WHERE id = ?', id);
    const taken = await one(env, 'SELECT id FROM chat_users WHERE username = ? AND id <> ?', preferred, id);
    people.push([id, existing?.username || (taken ? `${preferred}_${randomToken(3).replace(/[^A-Za-z0-9]/g, 'X')}` : preferred)]);
  }
  const welcome = 'Welcome to Morse Room: Learn & Chat. Try Show text, Listen, sending a message, Block, or Report. This is a test conversation.';
  const groupText = 'This private test group is ready for the app review.';
  await batch(env, [
    ...people.flatMap(([id, username]) => [
      ['INSERT INTO chat_users(id,username,email,created_at) VALUES (?,?,NULL,?) ON CONFLICT(id) DO NOTHING', id, username, now],
      ['INSERT INTO chat_review_users(user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING', id],
    ]),
    ['INSERT INTO chat_friends(user_low,user_high,created_at) VALUES (?,?,?) ON CONFLICT(user_low,user_high) DO NOTHING', BOT, REVIEWER, now],
    ["INSERT INTO chat_conversations(id,type,name,dm_pair,code,owner_id,created_at) VALUES (?,'direct',NULL,?,NULL,?,?) ON CONFLICT(id) DO NOTHING",
      'review-direct', `${BOT}:${REVIEWER}`, REVIEWER, now],
    ["INSERT INTO chat_conversations(id,type,name,dm_pair,code,owner_id,created_at) VALUES (?,'group',?,NULL,?,?,?) ON CONFLICT(id) DO NOTHING",
      'review-group', 'Morse review group', 'MORSEREVIEW000001', REVIEWER, now],
    ...['review-direct', 'review-group'].flatMap((id) => [BOT, REVIEWER].map((userId) => [
      'INSERT INTO chat_members(conversation_id,user_id,joined_at) VALUES (?,?,?) ON CONFLICT(conversation_id,user_id) DO NOTHING', id, userId, now,
    ])),
    ['INSERT INTO chat_messages(conversation_id,sender_id,text,morse,kind,client_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id,sender_id,client_id) DO NOTHING',
      'review-direct', BOT, welcome, encodeMorse(welcome), 'text', 'review-welcome', now],
    ['INSERT INTO chat_messages(conversation_id,sender_id,text,morse,kind,client_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id,sender_id,client_id) DO NOTHING',
      'review-group', BOT, groupText, encodeMorse(groupText), 'text', 'review-group-welcome', now],
    ['INSERT INTO chat_friend_requests(id,sender_id,recipient_id,pair_key,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM chat_friends WHERE user_low=? AND user_high=?) ON CONFLICT(pair_key) DO NOTHING',
      'review-friend-request', HELPER, REVIEWER, `${HELPER}:${REVIEWER}`, now, HELPER, REVIEWER],
  ]);
  return { id: REVIEWER, username: people[0][1], isReviewer: true };
}

/** A configured review code opens test data only, never a normal person's account. */
export async function reviewerSignIn(request, env) {
  requireSite(env);
  requireOrigin(request, env);
  if (!env.PLAY_REVIEW_EMAIL || !/^[A-Za-z0-9_-]{43}$/.test(env.PLAY_REVIEW_PASSWORD_HASH || '')) {
    throw new ApiError(503, 'review_unavailable', 'Review access has not been configured. Use Google for your own chat account.');
  }
  const body = await readJSON(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(env, `review-login:${await hashToken(ip)}`, 5, 900);
  if (!email || email.length > 254 || password.length < 1 || password.length > 200
      || !sameHash(await hashToken(email), await hashToken(env.PLAY_REVIEW_EMAIL.trim().toLowerCase()))
      || !sameHash(await hashToken(password), env.PLAY_REVIEW_PASSWORD_HASH)) {
    throw new ApiError(401, 'review_login_failed', 'The review sign-in details are not correct.');
  }
  const user = await seedReview(env);
  return new Response(JSON.stringify({ ok: true, user }), { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Set-Cookie': await createSession(user.id, env),
  } });
}
