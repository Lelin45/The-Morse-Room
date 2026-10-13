import { validateMessage, validateMorseMessage, encodeMorse, validateUsername } from '../../chat-codec.js';
import { ApiError, one, all, run, batch, randomToken, requireSite, requireOrigin, readJSON, pair, pairKey } from './db.js';
import { authProviders, startOAuth, finishOAuth, identityUser, createSession, sessionUser,
  endSession, clearOAuthCookie } from './auth.js';
import { rateLimit } from './db.js';
import { blockBetween, listBlocks, blockUser, removeBlock, reportMessage, deleteAccount } from './account-safety.js';
import { finishMobileSignIn, makeMobileRedirect, mobileErrorRedirect } from './mobile-auth.js';
import { reviewerSignIn, isReviewUser } from './review-auth.js';

const LIMIT = 100;
const MESSAGE_SELECT = `SELECT m.id, m.sender_id AS senderId, u.username, m.text, m.morse, m.kind, m.created_at AS createdAt
  FROM chat_messages m JOIN chat_users u ON u.id = m.sender_id`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extraHeaders,
  } });
}

function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new ApiError(400, 'invalid_id', `Choose a valid ${label}.`);
  }
  return value;
}

function cursor(value) {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d{0,14})$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(400, 'invalid_cursor', 'Choose a valid message position.');
  }
  return Number(value);
}

async function userRequired(request, env, profile = true) {
  const user = await sessionUser(request, env);
  if (!user) throw new ApiError(401, 'sign_in_required', 'Sign in to use the Chat Room.');
  if (profile && !user.username) throw new ApiError(409, 'username_required', 'Choose your username before using the Chat Room.');
  return user;
}

async function conversationRequired(id, user, env) {
  const conversation = await one(env, `SELECT c.id, c.type, c.name, c.code, c.dm_pair AS dmPair
    FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id
    WHERE c.id = ? AND m.user_id = ?
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = c.owner_id) = ?
      AND NOT EXISTS (SELECT 1 FROM chat_members p WHERE p.conversation_id = c.id
        AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = p.user_id) <> ?)`,
    id, user.id, user.isReviewer === true ? 1 : 0, user.isReviewer === true ? 1 : 0);
  if (!conversation) throw new ApiError(404, 'conversation_not_found', 'This conversation is not available to you.');
  if (conversation.type === 'direct') {
    const members = await all(env, 'SELECT user_id AS id FROM chat_members WHERE conversation_id = ?', id);
    const other = members.find((member) => member.id !== user.id);
    if (!other || members.length !== 2) throw new ApiError(404, 'conversation_not_found', 'This conversation is not available to you.');
    if (await blockBetween(env, user.id, other.id)) {
      throw new ApiError(404, 'conversation_not_found', 'This conversation is not available to you.');
    }
    const [low, high] = pair(user.id, other.id);
    if (!await one(env, 'SELECT 1 AS accepted FROM chat_friends WHERE user_low = ? AND user_high = ?', low, high)) {
      throw new ApiError(403, 'friendship_required', 'Accept a friend request before sending direct messages.');
    }
    const peer = await one(env, 'SELECT id, username FROM chat_users WHERE id = ?', other.id);
    conversation.name = peer.username;
    conversation.peer = peer;
  }
  return conversation;
}

async function inbox(user, env) {
  const [friends, requests, conversations] = await Promise.all([
    all(env, `SELECT u.id, u.username, c.id AS conversationId FROM chat_friends f
      JOIN chat_users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
      JOIN chat_conversations c ON c.dm_pair = f.user_low || ':' || f.user_high
      WHERE (f.user_low = ? OR f.user_high = ?) AND NOT EXISTS (SELECT 1 FROM chat_blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocked_id = ? AND b.blocker_id = u.id))
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) = ?
      ORDER BY u.username`, user.id, user.id, user.id, user.id, user.id, user.isReviewer === true ? 1 : 0),
    all(env, `SELECT r.id, u.username, r.created_at AS createdAt FROM chat_friend_requests r
      JOIN chat_users u ON u.id = r.sender_id WHERE r.recipient_id = ? AND NOT EXISTS (SELECT 1 FROM chat_blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = r.sender_id) OR (b.blocked_id = ? AND b.blocker_id = r.sender_id))
      AND EXISTS (SELECT 1 FROM chat_review_users x WHERE x.user_id = r.sender_id) = ?
      ORDER BY r.created_at DESC`, user.id, user.id, user.id, user.isReviewer === true ? 1 : 0),
    all(env, `SELECT c.id, c.type,
      CASE WHEN c.type = 'direct' THEN (
        SELECT u.username FROM chat_members p JOIN chat_users u ON u.id = p.user_id
        WHERE p.conversation_id = c.id AND p.user_id <> ? LIMIT 1) ELSE c.name END AS name,
      (SELECT COUNT(*) FROM chat_messages q WHERE q.conversation_id = c.id
        AND q.id > m.last_read_message_id AND q.sender_id <> ? AND NOT EXISTS (SELECT 1 FROM chat_blocks b
          WHERE (b.blocker_id = ? AND b.blocked_id = q.sender_id) OR (b.blocked_id = ? AND b.blocker_id = q.sender_id))) AS unread,
      (SELECT q.created_at FROM chat_messages q WHERE q.conversation_id = c.id AND NOT EXISTS (SELECT 1 FROM chat_blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = q.sender_id) OR (b.blocked_id = ? AND b.blocker_id = q.sender_id))
        ORDER BY q.id DESC LIMIT 1) AS lastMessageAt
      FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id WHERE m.user_id = ?
      AND (c.type = 'group' OR NOT EXISTS (SELECT 1 FROM chat_members p JOIN chat_blocks b
        ON (b.blocker_id = ? AND b.blocked_id = p.user_id) OR (b.blocked_id = ? AND b.blocker_id = p.user_id)
        WHERE p.conversation_id = c.id AND p.user_id <> ?))
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = c.owner_id) = ?
      AND NOT EXISTS (SELECT 1 FROM chat_members p WHERE p.conversation_id = c.id
        AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = p.user_id) <> ?)
      ORDER BY COALESCE(lastMessageAt, c.created_at) DESC`, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id,
      user.isReviewer === true ? 1 : 0, user.isReviewer === true ? 1 : 0),
  ]);
  return { friends, requests, conversations, unread: conversations.reduce((total, conversation) => total + conversation.unread, 0) };
}

async function friendRequest(user, body, env) {
  const target = typeof body.target === 'string' ? body.target.trim().toLowerCase() : '';
  if (!target || target.length > 254) throw new ApiError(400, 'invalid_target', 'Enter a username or email address.');
  await rateLimit(env, `friends:${user.id}`, 30, 3600);
  const candidates = target.indexOf('@') > 0
    ? await all(env, `SELECT u.id, u.username FROM chat_users u WHERE u.email = ? AND u.username IS NOT NULL
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) = ? LIMIT 2`, target, user.isReviewer === true ? 1 : 0)
    : await all(env, `SELECT u.id, u.username FROM chat_users u WHERE u.username = ?
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) = ? LIMIT 2`, target.replace(/^@/, ''), user.isReviewer === true ? 1 : 0);
  if (!candidates.length) throw new ApiError(404, 'person_not_found', 'No person with that username or email was found.');
  if (candidates.length > 1) throw new ApiError(409, 'ambiguous_email', 'More than one account uses that email. Please enter the username.');
  const recipient = candidates[0];
  if (recipient.id === user.id) throw new ApiError(400, 'self_request', 'Choose another person to add as a friend.');
  if (await blockBetween(env, user.id, recipient.id)) throw new ApiError(404, 'person_not_found', 'No person with that username or email was found.');
  const [low, high] = pair(user.id, recipient.id);
  if (await one(env, 'SELECT 1 AS accepted FROM chat_friends WHERE user_low = ? AND user_high = ?', low, high)) {
    return { ok: true, alreadyFriends: true };
  }
  const key = pairKey(user.id, recipient.id);
  const existing = await one(env, 'SELECT id, sender_id AS senderId FROM chat_friend_requests WHERE pair_key = ?', key);
  if (existing) {
    if (existing.senderId !== user.id) throw new ApiError(409, 'incoming_request', 'That person has already sent a request. Accept it in your inbox.');
    return { ok: true, alreadyRequested: true };
  }
  await run(env, `INSERT INTO chat_friend_requests(id, sender_id, recipient_id, pair_key, created_at)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chat_blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?))
    ON CONFLICT(pair_key) DO NOTHING`, crypto.randomUUID(), user.id, recipient.id, key, Date.now(), user.id, recipient.id, recipient.id, user.id);
  return { ok: true };
}

async function respondFriend(user, body, env) {
  const id = identifier(body.id, 'friend request');
  if (typeof body.accept !== 'boolean') throw new ApiError(400, 'invalid_response', 'Choose whether to accept the request.');
  const request = await one(env, `SELECT sender_id AS senderId, recipient_id AS recipientId
    FROM chat_friend_requests WHERE id = ? AND recipient_id = ?`, id, user.id);
  if (!request) throw new ApiError(404, 'request_not_found', 'This friend request is not available.');
  if (await isReviewUser(env, request.senderId) !== (user.isReviewer === true)) {
    throw new ApiError(404, 'request_not_found', 'This friend request is not available.');
  }
  if (await blockBetween(env, user.id, request.senderId)) throw new ApiError(404, 'request_not_found', 'This friend request is not available.');
  if (!body.accept) {
    await run(env, 'DELETE FROM chat_friend_requests WHERE id = ? AND recipient_id = ?', id, user.id);
    return { ok: true };
  }
  const [low, high] = pair(user.id, request.senderId);
  const key = pairKey(low, high);
  const now = Date.now();
  await batch(env, [
    [`INSERT INTO chat_friends(user_low, user_high, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM chat_friend_requests WHERE id = ? AND recipient_id = ?)
        AND NOT EXISTS (SELECT 1 FROM chat_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?))
      ON CONFLICT(user_low, user_high) DO NOTHING`, low, high, now, id, user.id, low, high, high, low],
    [`INSERT INTO chat_conversations(id, type, name, dm_pair, code, owner_id, created_at)
      SELECT ?, 'direct', NULL, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM chat_friends WHERE user_low = ? AND user_high = ?)
        AND NOT EXISTS (SELECT 1 FROM chat_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?))
      ON CONFLICT(dm_pair) DO NOTHING`, crypto.randomUUID(), key, user.id, now, low, high, low, high, high, low],
    [`INSERT INTO chat_members(conversation_id, user_id, joined_at)
      SELECT id, ?, ? FROM chat_conversations WHERE dm_pair = ? ON CONFLICT(conversation_id, user_id) DO NOTHING`, low, now, key],
    [`INSERT INTO chat_members(conversation_id, user_id, joined_at)
      SELECT id, ?, ? FROM chat_conversations WHERE dm_pair = ? ON CONFLICT(conversation_id, user_id) DO NOTHING`, high, now, key],
    ['DELETE FROM chat_friend_requests WHERE id = ? AND recipient_id = ?', id, user.id],
  ]);
  const conversation = await one(env, 'SELECT id, type FROM chat_conversations WHERE dm_pair = ?', key);
  if (!conversation) throw new ApiError(404, 'request_not_found', 'This friend request is no longer available.');
  if (await blockBetween(env, user.id, request.senderId)) throw new ApiError(404, 'request_not_found', 'This friend request is no longer available.');
  return { ok: true, conversation: { ...conversation, name: (await one(env, 'SELECT username FROM chat_users WHERE id = ?', request.senderId)).username } };
}

async function createGroup(user, body, env) {
  const name = typeof body.name === 'string' ? body.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiError(400, 'invalid_group_name', 'Use 2 to 60 characters for the group name.');
  }
  await rateLimit(env, `groups:${user.id}`, 5, 3600);
  const id = crypto.randomUUID();
  const code = randomToken(12);
  const now = Date.now();
  await batch(env, [
    [`INSERT INTO chat_conversations(id, type, name, dm_pair, code, owner_id, created_at) VALUES (?, 'group', ?, NULL, ?, ?, ?)`, id, name, code, user.id, now],
    ['INSERT INTO chat_members(conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, now],
  ]);
  const link = new URL('/', requireSite(env));
  link.searchParams.set('chat', '1');
  link.searchParams.set('join', code);
  return { conversation: { id, name, type: 'group' }, code, link: link.href };
}

async function joinGroup(user, body, env) {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw new ApiError(400, 'invalid_group_code', 'Enter a valid group invite code.');
  await rateLimit(env, `joins:${user.id}`, 20, 3600);
  const conversation = await one(env, `SELECT id, name, type, owner_id AS ownerId FROM chat_conversations WHERE type = 'group' AND code = ?`, code);
  if (!conversation) throw new ApiError(404, 'group_not_found', 'This group invite was not found.');
  if (await isReviewUser(env, conversation.ownerId) !== (user.isReviewer === true)) {
    throw new ApiError(404, 'group_not_found', 'This group invite was not found.');
  }
  const result = await run(env, `INSERT INTO chat_members(conversation_id, user_id, joined_at)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM chat_members WHERE conversation_id = ?) < 100
    ON CONFLICT(conversation_id, user_id) DO NOTHING`, conversation.id, user.id, Date.now(), conversation.id);
  if (!result.meta.changes && !await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', conversation.id, user.id)) {
    throw new ApiError(409, 'group_full', 'This group already has 100 members.');
  }
  return { conversation: { id: conversation.id, name: conversation.name, type: conversation.type } };
}

async function conversationDetail(id, user, url, env) {
  const authorized = await conversationRequired(id, user, env);
  const after = cursor(url.searchParams.get('after'));
  const before = cursor(url.searchParams.get('before'));
  if (after !== null && before !== null) throw new ApiError(400, 'invalid_cursor', 'Use one message position at a time.');
  let rows;
  const visibleMessages = `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND NOT EXISTS (SELECT 1 FROM chat_blocks b
    WHERE (b.blocker_id = ? AND b.blocked_id = m.sender_id) OR (b.blocked_id = ? AND b.blocker_id = m.sender_id))`;
  if (after !== null) rows = await all(env, `${visibleMessages} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, id, user.id, user.id, after, LIMIT + 1);
  else if (before !== null) rows = await all(env, `${visibleMessages} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, id, user.id, user.id, before, LIMIT + 1);
  else rows = await all(env, `${visibleMessages} ORDER BY m.id DESC LIMIT ?`, id, user.id, user.id, LIMIT + 1);
  const hasMore = rows.length > LIMIT;
  const messages = rows.slice(0, LIMIT);
  if (after === null) messages.reverse();
  const members = await all(env, `SELECT u.id, u.username FROM chat_members m JOIN chat_users u ON u.id = m.user_id
    WHERE m.conversation_id = ? ORDER BY m.joined_at, u.username`, id);
  return {
    conversation: { id: authorized.id, name: authorized.name, type: authorized.type,
      ...(authorized.type === 'group' ? { code: authorized.code } : { peer: authorized.peer }) },
    members, messages, hasMore,
    nextCursor: hasMore ? (after === null ? messages[0].id : messages.at(-1).id) : null,
  };
}

async function sendMessage(id, user, body, env) {
  await conversationRequired(id, user, env);
  const kind = body.kind === undefined ? 'text' : body.kind;
  if (kind !== 'text' && kind !== 'morse') throw new ApiError(400, 'invalid_message_kind', 'Choose text or Morse code for your message.');
  let text;
  let morse;
  try {
    if (kind === 'morse') ({ text, morse } = validateMorseMessage(body.morse));
    else {
      text = validateMessage(body.text);
      morse = encodeMorse(text);
    }
  }
  catch (error) { throw new ApiError(400, 'invalid_message', error.message); }
  const clientId = identifier(body.clientId, 'message reference');
  const matches = (saved) => saved.kind === kind && saved.text === text && saved.morse === morse;
  let message = await one(env, `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.sender_id = ? AND m.client_id = ?`, id, user.id, clientId);
  if (message) {
    if (!matches(message)) throw new ApiError(409, 'message_conflict', 'This message reference was already used for a different message.');
    return { message };
  }
  await rateLimit(env, `messages:${user.id}`, 60, 60);
  await run(env, `INSERT INTO chat_messages(conversation_id, sender_id, text, morse, kind, client_id, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chat_members WHERE conversation_id = ? AND user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM chat_conversations c JOIN chat_members p ON p.conversation_id = c.id
        JOIN chat_blocks b ON (b.blocker_id = ? AND b.blocked_id = p.user_id) OR (b.blocked_id = ? AND b.blocker_id = p.user_id)
        WHERE c.id = ? AND c.type = 'direct' AND p.user_id <> ?)
    ON CONFLICT(conversation_id, sender_id, client_id) DO NOTHING`, id, user.id, text, morse, kind, clientId, Date.now(), id, user.id, user.id, user.id, id, user.id);
  message = await one(env, `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.sender_id = ? AND m.client_id = ?`, id, user.id, clientId);
  if (!message) throw new ApiError(403, 'membership_required', 'Join this conversation before sending messages.');
  if (!matches(message)) throw new ApiError(409, 'message_conflict', 'This message reference was already used for a different message.');
  return { message };
}

async function oauthCallback(provider, request, env) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  headers.append('Set-Cookie', clearOAuthCookie(provider, env));
  let errorCode = null;
  let returnPath = '/?chat=1';
  let trustedMobile = null;
  try {
    const profile = await finishOAuth(provider, request, env);
    trustedMobile = profile.mobile || null;
    if (profile.returnTo === '/delete-account.html') returnPath = profile.returnTo;
    const user = await identityUser(profile, env);
    if (profile.mobile) return await makeMobileRedirect(user, profile.mobile, env);
    headers.append('Set-Cookie', await createSession(user.id, env));
  } catch (error) {
    const mobile = trustedMobile || (error instanceof ApiError ? error.mobile : null);
    if (mobile) return mobileErrorRedirect(mobile, env);
    errorCode = error instanceof ApiError ? error.code : 'oauth_failed';
  }
  headers.set('Location', errorCode ? `/?chat=1&chat_error=${encodeURIComponent(errorCode)}` : returnPath);
  return new Response(null, { status: 303, headers });
}

export async function handleChatRequest(request, env) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method;
    if (path === '/api/config' && method === 'GET') {
      const configuration = authProviders(env);
      if (configuration.available) {
        try { await one(env, `SELECT 1 AS initialized FROM chat_users u
          LEFT JOIN chat_blocks b ON b.blocker_id = u.id LEFT JOIN chat_reports r ON r.reporter_id = u.id
          LEFT JOIN chat_review_users v ON v.user_id = u.id LIMIT 1`); }
        catch { return json({ available: false, providers: { google: false } }); }
      }
      return json(configuration);
    }
    if (path === '/api/me' && method === 'GET') return json({ user: await sessionUser(request, env) });
    const callback = path.match(/^\/api\/auth\/(google)\/callback$/);
    if (callback) return await oauthCallback(callback[1], request, env);
    requireSite(env);
    const start = path.match(/^\/api\/auth\/(google)$/);
    if (start && method === 'GET') return await startOAuth(start[1], request, env);
    if (!['GET', 'POST'].includes(method)) throw new ApiError(405, 'method_not_allowed', 'This request method is not supported.');
    if (method === 'POST') requireOrigin(request, env);
    if (path === '/api/auth/mobile/finish' && method === 'POST') return await finishMobileSignIn(request, env);
    if (path === '/api/auth/reviewer' && method === 'POST') return await reviewerSignIn(request, env);
    if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': await endSession(request, env) });
    const user = await userRequired(request, env, !['/api/profile', '/api/account/delete'].includes(path));
    if (path === '/api/account/delete' && method === 'POST') {
      const deleted = await deleteAccount(user, await readJSON(request), env);
      return json(deleted.data, 200, { 'Set-Cookie': deleted.sessionCookie });
    }
    if (path === '/api/blocks' && method === 'GET') return json(await listBlocks(user, env));
    if (path === '/api/blocks' && method === 'POST') return json(await blockUser(user, await readJSON(request), env));
    if (path === '/api/blocks/remove' && method === 'POST') return json(await removeBlock(user, await readJSON(request), env));
    if (path === '/api/reports' && method === 'POST') return json(await reportMessage(user, await readJSON(request), env, conversationRequired));
    if (path === '/api/profile' && method === 'POST') {
      if (user.isReviewer) throw new ApiError(403, 'review_profile_fixed', 'The review account keeps its fixed test username.');
      const body = await readJSON(request);
      let username;
      try { username = validateUsername(body.username); }
      catch (error) { throw new ApiError(400, 'invalid_username', error.message); }
      await rateLimit(env, `profile:${user.id}`, 10, 3600);
      const taken = await one(env, 'SELECT id FROM chat_users WHERE username = ? AND id <> ?', username, user.id);
      if (taken) throw new ApiError(409, 'username_taken', 'That username is already in use.');
      try { await run(env, 'UPDATE chat_users SET username = ? WHERE id = ?', username, user.id); }
      catch {
        if (await one(env, 'SELECT id FROM chat_users WHERE username = ? AND id <> ?', username, user.id)) {
          throw new ApiError(409, 'username_taken', 'That username is already in use.');
        }
        throw new Error('Profile update failed');
      }
      return json({ user: { id: user.id, username } });
    }
    if (path === '/api/inbox' && method === 'GET') return json(await inbox(user, env));
    if (path === '/api/friends/request' && method === 'POST') return json(await friendRequest(user, await readJSON(request), env));
    if (path === '/api/friends/respond' && method === 'POST') return json(await respondFriend(user, await readJSON(request), env));
    if (path === '/api/groups' && method === 'POST') return json(await createGroup(user, await readJSON(request), env), 201);
    if (path === '/api/groups/join' && method === 'POST') return json(await joinGroup(user, await readJSON(request), env));
    const conversation = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]{1,80})(?:\/(messages|read))?$/);
    if (conversation) {
      const [, id, action] = conversation;
      if (method === 'GET' && (!action || action === 'messages')) return json(await conversationDetail(id, user, url, env));
      if (method === 'POST' && action === 'messages') return json(await sendMessage(id, user, await readJSON(request), env), 201);
      if (method === 'POST' && action === 'read') {
        await conversationRequired(id, user, env);
        const body = await readJSON(request);
        const maximum = await one(env, `SELECT COALESCE(MAX(m.id), 0) AS id FROM chat_messages m WHERE m.conversation_id = ?
          AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = m.sender_id)
            OR (b.blocked_id = ? AND b.blocker_id = m.sender_id))`, id, user.id, user.id);
        const through = body.through === undefined ? maximum.id : body.through;
        if (!Number.isSafeInteger(through) || through < 0) throw new ApiError(400, 'invalid_cursor', 'Choose a valid read position.');
        const position = Math.min(through, maximum.id);
        await run(env, `UPDATE chat_members SET last_read_message_id = ?
          WHERE conversation_id = ? AND user_id = ? AND last_read_message_id < ?`, position, id, user.id, position);
        return json({ ok: true });
      }
    }
    throw new ApiError(404, 'not_found', 'This Chat Room route was not found.');
  } catch (error) {
    const known = error instanceof ApiError;
    return json({ error: { code: known ? error.code : 'server_error',
      message: known ? error.message : 'Chat could not complete this request. Please try again.' } }, known ? error.status : 500);
  }
}
