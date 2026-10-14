import { ApiError, one, all, run, batch, randomToken, requireSite, rateLimit } from './db.js';
import { blockBetween } from './account-safety.js';

const reviewer = (user) => user.isReviewer === true ? 1 : 0;
const groupSelect = `SELECT c.id, c.name, c.type, c.visibility, c.owner_id AS ownerId,
  (SELECT COUNT(*) FROM chat_members m WHERE m.conversation_id = c.id) AS memberCount
  FROM chat_conversations c`;
const scope = `EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = c.owner_id) = ?
  AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = c.id
    AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = m.user_id) <> ?)`;
const noBlock = `NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE
  (b.blocker_id = ? AND b.blocked_id = c.owner_id) OR (b.blocked_id = ? AND b.blocker_id = c.owner_id))`;

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new ApiError(400, 'invalid_id', 'Choose a valid group or person.');
  return value;
}

function summary(group) {
  return { id: group.id, name: group.name, type: 'group', visibility: group.visibility,
    ownerId: group.ownerId, memberCount: group.memberCount, memberLimit: 100 };
}

async function available(groupId, user, env) {
  const group = await one(env, `${groupSelect} WHERE c.id = ? AND c.type = 'group' AND ${scope} AND ${noBlock}`,
    id(groupId), reviewer(user), reviewer(user), user.id, user.id);
  if (!group) throw new ApiError(404, 'group_not_found', 'This group is not available.');
  return group;
}

async function ownerRequired(groupId, user, env) {
  const group = await available(groupId, user, env);
  if (group.ownerId !== user.id || !await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', group.id, user.id)) {
    throw new ApiError(403, 'group_owner_required', 'Only the group creator can manage members.');
  }
  return group;
}

export async function createGroup(user, body, env) {
  const name = typeof body.name === 'string' ? body.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(400, 'invalid_group_name', 'Use 2 to 60 characters for the group name.');
  const visibility = body.visibility === undefined ? 'private' : body.visibility;
  if (!['private', 'public'].includes(visibility)) throw new ApiError(400, 'invalid_visibility', 'Choose a public or private group.');
  await rateLimit(env, `groups:${user.id}`, 5, 3600);
  const groupId = crypto.randomUUID();
  const code = randomToken(12);
  const now = Date.now();
  await batch(env, [
    [`INSERT INTO chat_conversations(id, type, name, dm_pair, code, owner_id, created_at, visibility)
      VALUES (?, 'group', ?, NULL, ?, ?, ?, ?)`, groupId, name, code, user.id, now, visibility],
    ['INSERT INTO chat_members(conversation_id, user_id, joined_at) VALUES (?, ?, ?)', groupId, user.id, now],
  ]);
  const link = new URL('/', requireSite(env));
  link.searchParams.set('chat', '1'); link.searchParams.set('join', code);
  return { conversation: summary({ id: groupId, name, ownerId: user.id, visibility, memberCount: 1 }), code, link: link.href };
}

export async function listPublicGroups(user, query, env) {
  const search = (query || '').normalize('NFKC').trim();
  if (search.length > 60) throw new ApiError(400, 'invalid_search', 'Search with up to 60 characters.');
  const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const groups = await all(env, `SELECT c.id, c.name, c.type, c.visibility, c.owner_id AS ownerId,
    (SELECT COUNT(*) FROM chat_members m WHERE m.conversation_id = c.id) AS memberCount,
    EXISTS (SELECT 1 FROM chat_members p WHERE p.conversation_id = c.id AND p.user_id = ?) AS joined,
    EXISTS (SELECT 1 FROM chat_group_requests r WHERE r.conversation_id = c.id AND r.user_id = ?) AS requested
    FROM chat_conversations c WHERE c.type = 'group' AND c.visibility = 'public' AND ${scope} AND ${noBlock}
      AND NOT EXISTS (SELECT 1 FROM chat_group_removals x WHERE x.conversation_id = c.id AND x.user_id = ?)
      AND c.name LIKE ? ESCAPE '\\'
    ORDER BY c.created_at DESC, c.id LIMIT 50`, user.id, user.id, reviewer(user), reviewer(user), user.id, user.id, user.id, term);
  return { groups: groups.map((group) => ({ ...summary(group), joined: Boolean(group.joined), requested: Boolean(group.requested) })) };
}

export async function groupRequests(user, env) {
  return all(env, `SELECT r.id, r.conversation_id AS conversationId, c.name AS groupName, u.username,
    r.created_at AS createdAt FROM chat_group_requests r JOIN chat_conversations c ON c.id = r.conversation_id
    JOIN chat_users u ON u.id = r.user_id WHERE c.owner_id = ? AND c.visibility = 'public'
      AND EXISTS (SELECT 1 FROM chat_review_users x WHERE x.user_id = r.user_id) = ?
      AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.user_id)
        OR (b.blocked_id = ? AND b.blocker_id = r.user_id))
    ORDER BY r.created_at DESC LIMIT 100`, user.id, reviewer(user), user.id, user.id);
}

export async function requestGroup(user, body, env) {
  const group = await available(body.groupId, user, env);
  if (group.visibility !== 'public') throw new ApiError(404, 'group_not_found', 'This public group is not available.');
  if (await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', group.id, user.id)) return { conversation: summary(group), joined: true };
  if (await one(env, 'SELECT 1 AS removed FROM chat_group_removals WHERE conversation_id = ? AND user_id = ?', group.id, user.id)) throw new ApiError(403, 'group_access_removed', 'The group creator has removed your access.');
  const existing = await one(env, 'SELECT id FROM chat_group_requests WHERE conversation_id = ? AND user_id = ?', group.id, user.id);
  if (existing) return { requested: true, requestId: existing.id, group: summary(group) };
  if (group.memberCount >= 100) throw new ApiError(409, 'group_full', 'This group already has 100 members.');
  await rateLimit(env, `joins:${user.id}`, 20, 3600);
  await run(env, `INSERT INTO chat_group_requests(id, conversation_id, user_id, created_at)
    SELECT ?, c.id, ?, ? FROM chat_conversations c WHERE c.id = ? AND c.visibility = 'public'
      AND ${scope} AND ${noBlock} AND (SELECT COUNT(*) FROM chat_members WHERE conversation_id = c.id) < 100
      AND NOT EXISTS (SELECT 1 FROM chat_group_removals x WHERE x.conversation_id = c.id AND x.user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM chat_members p WHERE p.conversation_id = c.id AND p.user_id = ?)
    ON CONFLICT(conversation_id, user_id) DO NOTHING`, crypto.randomUUID(), user.id, Date.now(), group.id,
    reviewer(user), reviewer(user), user.id, user.id, user.id, user.id);
  const saved = await one(env, 'SELECT id FROM chat_group_requests WHERE conversation_id = ? AND user_id = ?', group.id, user.id);
  if (!saved) throw new ApiError(409, 'group_unavailable', 'The group is no longer available for requests.');
  return { requested: true, requestId: saved.id, group: summary(group) };
}

export async function joinGroup(user, body, env) {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw new ApiError(400, 'invalid_group_code', 'Enter a valid group invite code.');
  const found = await one(env, `SELECT id FROM chat_conversations WHERE type = 'group' AND code = ?`, code);
  if (!found) throw new ApiError(404, 'group_not_found', 'This group invite was not found.');
  const group = await available(found.id, user, env);
  if (group.visibility === 'public') return requestGroup(user, { groupId: group.id }, env);
  if (await one(env, 'SELECT 1 AS removed FROM chat_group_removals WHERE conversation_id = ? AND user_id = ?', group.id, user.id)) throw new ApiError(403, 'group_access_removed', 'The group creator has removed your access.');
  await rateLimit(env, `joins:${user.id}`, 20, 3600);
  await run(env, `INSERT INTO chat_members(conversation_id, user_id, joined_at)
    SELECT c.id, ?, ? FROM chat_conversations c WHERE c.id = ? AND c.visibility = 'private' AND ${scope} AND ${noBlock}
      AND (SELECT COUNT(*) FROM chat_members WHERE conversation_id = c.id) < 100
      AND NOT EXISTS (SELECT 1 FROM chat_group_removals x WHERE x.conversation_id = c.id AND x.user_id = ?)
    ON CONFLICT(conversation_id, user_id) DO NOTHING`, user.id, Date.now(), group.id, reviewer(user), reviewer(user), user.id, user.id, user.id);
  if (!await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', group.id, user.id)) throw new ApiError(409, 'group_full', 'This group is full or no longer available.');
  const current = await available(group.id, user, env);
  return { conversation: summary(current), joined: true };
}

export async function respondGroup(user, body, env) {
  if (typeof body.accept !== 'boolean') throw new ApiError(400, 'invalid_response', 'Choose whether to accept the request.');
  const request = await one(env, 'SELECT conversation_id AS groupId, user_id AS userId FROM chat_group_requests WHERE id = ?', id(body.id));
  if (!request) throw new ApiError(404, 'request_not_found', 'This group request is no longer available.');
  const group = await ownerRequired(request.groupId, user, env);
  if (await blockBetween(env, user.id, request.userId) || !await one(env, `SELECT id FROM chat_users WHERE id = ?
    AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = chat_users.id) = ?`, request.userId, reviewer(user))) throw new ApiError(404, 'request_not_found', 'This group request is not available.');
  if (!body.accept) {
    await run(env, 'DELETE FROM chat_group_requests WHERE id = ? AND conversation_id IN (SELECT id FROM chat_conversations WHERE owner_id = ?)', body.id, user.id);
    return { ok: true };
  }
  const results = await batch(env, [
    [`INSERT INTO chat_members(conversation_id, user_id, joined_at)
      SELECT c.id, r.user_id, ? FROM chat_group_requests r JOIN chat_conversations c ON c.id = r.conversation_id
      WHERE r.id = ? AND c.owner_id = ? AND c.visibility = 'public'
        AND (SELECT COUNT(*) FROM chat_members WHERE conversation_id = c.id) < 100
        AND NOT EXISTS (SELECT 1 FROM chat_group_removals x WHERE x.conversation_id = c.id AND x.user_id = r.user_id)
        AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.user_id)
          OR (b.blocked_id = ? AND b.blocker_id = r.user_id))
      ON CONFLICT(conversation_id, user_id) DO NOTHING`, Date.now(), body.id, user.id, user.id, user.id],
    [`DELETE FROM chat_group_requests WHERE id = ? AND EXISTS (SELECT 1 FROM chat_members m
      WHERE m.conversation_id = chat_group_requests.conversation_id AND m.user_id = chat_group_requests.user_id)`, body.id],
  ]);
  if (!results[0].meta.changes && !await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', group.id, request.userId)) throw new ApiError(409, 'group_full', 'This group is full or the request is no longer available.');
  return { ok: true };
}

export async function kickGroupMember(user, body, env) {
  const group = await ownerRequired(body.groupId, user, env);
  const target = id(body.userId);
  if (target === user.id) throw new ApiError(400, 'group_owner_removal', 'The group creator cannot remove their own account.');
  if (!await one(env, 'SELECT 1 AS present FROM chat_members WHERE conversation_id = ? AND user_id = ?', group.id, target)) throw new ApiError(404, 'member_not_found', 'This person is not a group member.');
  await batch(env, [
    [`INSERT INTO chat_group_removals(conversation_id, user_id, created_at)
      SELECT c.id, ?, ? FROM chat_conversations c WHERE c.id = ? AND c.owner_id = ?
      ON CONFLICT(conversation_id, user_id) DO NOTHING`, target, Date.now(), group.id, user.id],
    ['DELETE FROM chat_group_requests WHERE conversation_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = ? AND c.owner_id = ?)', group.id, target, group.id, user.id],
    ['DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = ? AND c.owner_id = ?)', group.id, target, group.id, user.id],
  ]);
  return { ok: true };
}
