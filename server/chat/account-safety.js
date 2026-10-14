import { ApiError, one, all, run, batch, rateLimit, cookie } from './db.js';

export const REPORT_REASONS = Object.freeze(['spam', 'harassment', 'hate', 'sexual_content', 'threats', 'other']);

// A block prevents contact in either direction. Never reveal which person set it.
export const blockBetween = (env, first, second) => one(env, `SELECT 1 AS blocked FROM chat_blocks
  WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`, first, second, second, first);

function userId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new ApiError(400, 'invalid_id', 'Choose a valid person.');
  }
  return value;
}

export async function listBlocks(user, env) {
  return { blocks: await all(env, `SELECT u.id, u.username, b.created_at AS createdAt FROM chat_blocks b
    JOIN chat_users u ON u.id = b.blocked_id WHERE b.blocker_id = ?
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) = ?
    ORDER BY b.created_at DESC, u.id`, user.id, user.isReviewer === true ? 1 : 0) };
}

export async function blockUser(user, body, env) {
  const target = userId(body.userId);
  if (target === user.id) throw new ApiError(400, 'self_block', 'Choose another person to block.');
  if (!await one(env, `SELECT u.id FROM chat_users u WHERE u.id = ? AND u.username IS NOT NULL
    AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) = ?`, target, user.isReviewer === true ? 1 : 0)) {
    throw new ApiError(404, 'person_not_found', 'This person is not available.');
  }
  if (await one(env, 'SELECT 1 AS present FROM chat_blocks WHERE blocker_id = ? AND blocked_id = ?', user.id, target)) return { ok: true };
  await rateLimit(env, `blocks:${user.id}`, 30, 3600);
  await batch(env, [
    ['INSERT INTO chat_blocks(blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT(blocker_id, blocked_id) DO NOTHING', user.id, target, Date.now()],
    ['DELETE FROM chat_friend_requests WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)', user.id, target, target, user.id],
    [`DELETE FROM chat_group_requests WHERE (user_id = ? AND conversation_id IN (SELECT id FROM chat_conversations WHERE owner_id = ?))
      OR (user_id = ? AND conversation_id IN (SELECT id FROM chat_conversations WHERE owner_id = ?))`, user.id, target, target, user.id],
  ]);
  return { ok: true };
}

export async function removeBlock(user, body, env) {
  const target = userId(body.userId);
  await run(env, 'DELETE FROM chat_blocks WHERE blocker_id = ? AND blocked_id = ?', user.id, target);
  return { ok: true };
}

export async function reportMessage(user, body, env, authorizeConversation) {
  if (!Number.isSafeInteger(body.messageId) || body.messageId < 1) {
    throw new ApiError(400, 'invalid_id', 'Choose a valid message.');
  }
  if (!REPORT_REASONS.includes(body.reason)) throw new ApiError(400, 'invalid_report_reason', 'Choose a reason for your report.');
  const details = body.details === undefined ? '' : body.details;
  if (typeof details !== 'string' || details.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(details)) {
    throw new ApiError(400, 'invalid_report_details', 'Use up to 1,000 characters to describe the problem.');
  }
  const message = await one(env, `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId
    FROM chat_messages m JOIN chat_members p ON p.conversation_id = m.conversation_id
    WHERE m.id = ? AND p.user_id = ? AND NOT EXISTS (SELECT 1 FROM chat_blocks b
      WHERE (b.blocker_id = ? AND b.blocked_id = m.sender_id) OR (b.blocked_id = ? AND b.blocker_id = m.sender_id))`, body.messageId, user.id, user.id, user.id);
  if (!message) throw new ApiError(404, 'message_not_found', 'This message is not available to you.');
  await authorizeConversation(message.conversationId, user, env);
  if (message.senderId === user.id) throw new ApiError(400, 'self_report', 'You can report messages from another person.');
  const existing = await one(env, 'SELECT id FROM chat_reports WHERE reporter_id = ? AND message_id = ?', user.id, message.id);
  if (existing) return { ok: true, reportId: existing.id };
  await rateLimit(env, `reports:${user.id}`, 10, 3600);
  await run(env, `INSERT INTO chat_reports(id, reporter_id, subject_id, message_id, conversation_id,
      reason, details, evidence_text, evidence_morse, message_kind, created_at)
    SELECT ?, ?, m.sender_id, m.id, m.conversation_id, ?, ?, m.text, m.morse, m.kind, ?
      FROM chat_messages m JOIN chat_members p ON p.conversation_id = m.conversation_id
      WHERE m.id = ? AND p.user_id = ? AND NOT EXISTS (SELECT 1 FROM chat_blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = m.sender_id) OR (b.blocked_id = ? AND b.blocker_id = m.sender_id))
    ON CONFLICT(reporter_id, message_id) DO NOTHING`, crypto.randomUUID(), user.id, body.reason, details.trim(), Date.now(), message.id, user.id, user.id, user.id);
  const saved = await one(env, 'SELECT id FROM chat_reports WHERE reporter_id = ? AND message_id = ?', user.id, message.id);
  if (!saved) throw new ApiError(404, 'message_not_found', 'This message is not available to you.');
  return { ok: true, reportId: saved.id };
}

export async function deleteAccount(user, body, env) {
  if (body.confirmation !== 'DELETE') {
    throw new ApiError(400, 'confirmation_required', 'Type DELETE to confirm account deletion.');
  }
  // D1 batches are transactions. Ownership transfer, deletion and session revocation
  // succeed together, or the complete account and its conversations remain intact.
  await batch(env, [
    [`UPDATE chat_conversations SET owner_id = (
        SELECT p.user_id FROM chat_members p WHERE p.conversation_id = chat_conversations.id
          AND p.user_id <> ? ORDER BY p.joined_at, p.user_id LIMIT 1)
      WHERE type = 'group' AND owner_id = ? AND EXISTS (
        SELECT 1 FROM chat_members p WHERE p.conversation_id = chat_conversations.id AND p.user_id <> ?)`, user.id, user.id, user.id],
    [`DELETE FROM chat_conversations WHERE type = 'direct' AND (owner_id = ? OR id IN (
        SELECT conversation_id FROM chat_members WHERE user_id = ?))`, user.id, user.id],
    ["DELETE FROM chat_conversations WHERE type = 'group' AND owner_id = ?", user.id],
    ['DELETE FROM chat_messages WHERE sender_id = ?', user.id],
    ['DELETE FROM chat_users WHERE id = ?', user.id],
    [`DELETE FROM chat_rate_limits WHERE actor IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...['friends', 'messages', 'groups', 'joins', 'profile', 'reports', 'blocks', 'account', 'notifications', 'notification-token', 'progress'].map((prefix) => `${prefix}:${user.id}`)],
  ]);
  return { data: { ok: true, deleted: true }, sessionCookie: cookie(env, 'session', '', 0) };
}
