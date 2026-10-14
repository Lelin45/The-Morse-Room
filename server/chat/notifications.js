import { ApiError, one, run, batch, randomToken, hashToken, readCookie, cookieName,
  readJSON, rateLimit } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{43}$/;

function dispatchURL(env) {
  try {
    const url = new URL(env.PUSH_DISPATCH_URL);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/dispatch' ? url : null;
  } catch { return null; }
}

function dispatchBinding(env) {
  return typeof env.PUSH_DISPATCHER?.fetch === 'function' ? env.PUSH_DISPATCHER : null;
}

export function notificationConfigured(env) {
  if (!env.DB || (!dispatchBinding(env) && !dispatchURL(env)) || !opaque.test(env.PUSH_DISPATCH_KEY || '')) return false;
  try {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
    return account.type === 'service_account' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(account.project_id || '')
      && /^[A-Za-z0-9_.-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/.test(account.client_email || '')
      && typeof account.private_key === 'string' && account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
      && account.private_key.length <= 16384;
  } catch { return false; }
}

export async function notificationAvailable(env) {
  if (!notificationConfigured(env)) return false;
  try {
    // An empty database must still probe every required table and column.
    await one(env, `SELECT d.id, d.installation_id, d.session_hash, d.auth_hash, d.fcm_token,
      o.id AS jobId, o.lease_until, o.expires_at FROM chat_notification_devices d
      LEFT JOIN chat_notification_outbox o ON o.device_id = d.id LIMIT 1`);
    return true;
  } catch { return false; }
}

function fcmToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.-]{20,4096}$/.test(value)) {
    throw new ApiError(400, 'invalid_device_token', 'This device could not register for notifications.');
  }
  return value;
}

function deviceId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400, 'invalid_device', 'Choose a valid device.');
  return value.toLowerCase();
}

function messageId(value) {
  const number = typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new ApiError(400, 'invalid_message', 'Choose a valid message.');
  return number;
}

export async function registerDevice(request, user, body, env) {
  if (!await notificationAvailable(env)) throw new ApiError(503, 'notifications_unavailable', 'Message notifications are not available yet.');
  const installation = deviceId(body.installationId);
  const token = fcmToken(body.fcmToken);
  await rateLimit(env, `notifications:${user.id}`, 30, 3600);
  const session = readCookie(request, cookieName(env, 'session'));
  if (!opaque.test(session || '')) throw new ApiError(401, 'sign_in_required', 'Sign in to enable notifications.');
  const sessionHash = await hashToken(session);
  const existing = await one(env, 'SELECT id, user_id AS userId, fcm_token AS fcmToken, auth_hash AS authHash FROM chat_notification_devices WHERE installation_id = ?', installation);
  if (existing && existing.userId !== user.id && existing.fcmToken !== token
      && (!opaque.test(body.previousAuthToken || '') || await hashToken(body.previousAuthToken) !== existing.authHash)) {
    throw new ApiError(403, 'device_conflict', 'This installation belongs to another signed-in account.');
  }
  const conflict = await one(env, 'SELECT id FROM chat_notification_devices WHERE fcm_token = ? AND installation_id <> ?', token, installation);
  if (conflict) throw new ApiError(409, 'device_conflict', 'This device token is already registered.');
  if (!existing || existing.userId !== user.id) {
    const count = await one(env, 'SELECT COUNT(*) AS count FROM chat_notification_devices WHERE user_id = ?', user.id);
    if (count.count >= 8) throw new ApiError(409, 'device_limit', 'Notifications are enabled on eight devices. Remove a device before adding another.');
  }
  const id = existing?.id || crypto.randomUUID();
  const authToken = randomToken();
  const now = Date.now();
  // Rebinding an installation drops its previous owner's queued jobs. Reopening
  // the same account preserves pending messages while rotating the capability.
  // The capability is deliberately returned only once, never stored as plaintext.
  const authHash = await hashToken(authToken);
  const previousHash = opaque.test(body.previousAuthToken || '') ? await hashToken(body.previousAuthToken) : '';
  try {
    await batch(env, [
      [`DELETE FROM chat_notification_outbox WHERE device_id IN
        (SELECT id FROM chat_notification_devices WHERE installation_id = ? AND user_id <> ? AND (fcm_token = ? OR auth_hash = ?))
        AND EXISTS (SELECT 1 FROM chat_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)`,
        installation, user.id, token, previousHash, sessionHash, user.id, now],
      [`INSERT INTO chat_notification_devices(id, installation_id, user_id, session_hash, auth_hash, fcm_token, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM chat_notification_devices WHERE installation_id = ? AND user_id <> ? AND fcm_token <> ? AND auth_hash <> ?)
        ON CONFLICT(installation_id) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash,
          auth_hash = excluded.auth_hash, fcm_token = excluded.fcm_token, updated_at = excluded.updated_at`,
        id, installation, user.id, sessionHash, authHash, token, now, now, sessionHash, user.id, now, installation, user.id, token, previousHash],
    ]);
  } catch (error) {
    if (error.message?.includes('notification_device_limit')) throw new ApiError(409, 'device_limit', 'Notifications are enabled on eight devices. Remove a device before adding another.');
    if (error.message?.includes('chat_notification_devices.fcm_token')) throw new ApiError(409, 'device_conflict', 'This device token is already registered.');
    throw error;
  }
  const saved = await one(env, 'SELECT id FROM chat_notification_devices WHERE installation_id = ? AND auth_hash = ?', installation, authHash);
  if (!saved) throw new ApiError(409, 'device_changed', 'Sign in again to enable notifications on this device.');
  return { deviceId: saved.id, authToken, userId: user.id };
}

export async function removeDevice(user, body, env) {
  await run(env, 'DELETE FROM chat_notification_devices WHERE id = ? AND user_id = ?', deviceId(body.deviceId), user.id);
  return { ok: true };
}

export async function deviceUser(request, env) {
  const token = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new ApiError(401, 'device_sign_in_required', 'Sign in again to use message notifications.');
  const device = await one(env, `SELECT d.id AS deviceId, u.id, u.username,
    EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = u.id) AS reviewFlag
    FROM chat_notification_devices d JOIN chat_sessions s ON s.token_hash = d.session_hash
      AND s.user_id = d.user_id JOIN chat_users u ON u.id = d.user_id
    WHERE d.auth_hash = ? AND s.expires_at > ?`, await hashToken(token), Date.now());
  if (!device || !device.username) throw new ApiError(401, 'device_sign_in_required', 'Sign in again to use message notifications.');
  if (device.reviewFlag) device.isReviewer = true;
  delete device.reviewFlag;
  return device;
}

async function authorizedMessage(id, user, env, authorize) {
  const message = await one(env, `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId,
    u.username AS senderUsername, m.text, m.morse, m.kind FROM chat_messages m
    JOIN chat_users u ON u.id = m.sender_id WHERE m.id = ? AND m.sender_id <> ?
      AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE
        (b.blocker_id = ? AND b.blocked_id = m.sender_id) OR (b.blocked_id = ? AND b.blocker_id = m.sender_id))`, messageId(id), user.id, user.id, user.id);
  if (!message) throw new ApiError(404, 'message_not_found', 'This message is not available to you.');
  const conversation = await authorize(message.conversationId, user, env);
  return { ...message, conversationName: conversation.name };
}

// These routes use a session-bound device capability, so no browser cookies or
// Origin are needed. They never accept a user ID supplied by the caller.
export async function notificationRoute(path, method, request, url, env, authorize, send) {
  if (!['/api/notifications/message', '/api/notifications/reply', '/api/notifications/device-token'].includes(path)) return null;
  if ((path === '/api/notifications/message' && method !== 'GET') || (path !== '/api/notifications/message' && method !== 'POST')) {
    throw new ApiError(405, 'method_not_allowed', 'This request method is not supported.');
  }
  const user = await deviceUser(request, env);
  if (path === '/api/notifications/message') return { message: await authorizedMessage(url.searchParams.get('id'), user, env, authorize) };
  const body = await readJSON(request);
  if (path === '/api/notifications/device-token') {
    if (deviceId(body.deviceId) !== user.deviceId) throw new ApiError(403, 'invalid_device', 'This device is not available.');
    await rateLimit(env, `notification-token:${user.id}`, 60, 3600);
    const token = fcmToken(body.fcmToken);
    const conflict = await one(env, 'SELECT id FROM chat_notification_devices WHERE fcm_token = ? AND id <> ?', token, user.deviceId);
    if (conflict) throw new ApiError(409, 'device_conflict', 'This device token is already registered.');
    await run(env, 'UPDATE chat_notification_devices SET fcm_token = ?, updated_at = ? WHERE id = ?', token, Date.now(), user.deviceId);
    return { ok: true };
  }
  const source = await authorizedMessage(body.messageId, user, env, authorize);
  if (body.conversationId !== source.conversationId) throw new ApiError(400, 'invalid_conversation', 'Reply in the conversation that received this message.');
  return send(source.conversationId, user, body, env);
}

// Recheck every recipient when queuing and again immediately before sending.
// No message text, usernames or Morse content are ever placed in the FCM payload.
export const eligibleNotificationSQL = `FROM chat_notification_devices d
  JOIN chat_sessions s ON s.token_hash = d.session_hash AND s.user_id = d.user_id
  JOIN chat_messages m ON m.id = ? JOIN chat_conversations c ON c.id = m.conversation_id
  JOIN chat_members recipient ON recipient.conversation_id = c.id AND recipient.user_id = d.user_id
  JOIN chat_members sender ON sender.conversation_id = c.id AND sender.user_id = m.sender_id
  WHERE s.expires_at > ? AND m.created_at > ? AND d.user_id <> m.sender_id
    AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE
      (b.blocker_id = d.user_id AND b.blocked_id = m.sender_id) OR (b.blocked_id = d.user_id AND b.blocker_id = m.sender_id))
    AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = d.user_id)
      = EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = m.sender_id)
    AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = c.owner_id)
      = EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = d.user_id)
    AND NOT EXISTS (SELECT 1 FROM chat_members p WHERE p.conversation_id = c.id
      AND EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = p.user_id)
        <> EXISTS (SELECT 1 FROM chat_review_users r WHERE r.user_id = d.user_id))
    AND (c.type = 'group' OR ((SELECT COUNT(*) FROM chat_members p WHERE p.conversation_id = c.id) = 2
      AND EXISTS (SELECT 1 FROM chat_friends f WHERE f.user_low = MIN(d.user_id, m.sender_id)
        AND f.user_high = MAX(d.user_id, m.sender_id))))`;

export async function queueMessageNotifications(message, env, context) {
  if (!notificationConfigured(env)) return;
  try {
    const now = Date.now();
    await run(env, `INSERT INTO chat_notification_outbox(device_id, message_id, next_attempt_at, created_at, expires_at)
      SELECT d.id, m.id, ?, ?, m.created_at + ? ${eligibleNotificationSQL}
      ON CONFLICT(device_id, message_id) DO NOTHING`, now, now, DAY, message.id, now, now - DAY);
    // Dispatch transport failures are repaired by the worker's one-minute cron.
    // Notifications must never undo a message that has already committed.
    if (context?.waitUntil) context.waitUntil(dispatchPending(env).catch(() => {}));
  } catch { /* Chat remains available when push infrastructure is unavailable. */ }
}

export async function dispatchPending(env, fetcher = fetch) {
  const binding = dispatchBinding(env);
  const url = dispatchURL(env);
  if ((!binding && !url) || !opaque.test(env.PUSH_DISPATCH_KEY || '')) return false;
  const options = { method: 'POST', headers: {
    Authorization: `Bearer ${env.PUSH_DISPATCH_KEY}`, 'Content-Type': 'application/json',
  }, body: '{}', signal: AbortSignal.timeout(5000), redirect: 'error' };
  // A private service binding works without exposing a workers.dev endpoint or
  // requiring account-subdomain permissions. The dispatch key still authenticates
  // the request; the fully qualified internal URL is never sent to the network.
  const response = binding
    ? await binding.fetch(new Request('https://morse-room-push.internal/dispatch', options))
    : await fetcher(url.href, options);
  await response.body?.cancel();
  return response.ok;
}

export async function notificationRecipient(env, device, message, now = Date.now()) {
  return one(env, `SELECT d.id AS deviceId, d.fcm_token AS fcmToken, m.id AS messageId,
    m.conversation_id AS conversationId ${eligibleNotificationSQL} AND d.id = ?`, message, now, now - DAY, device);
}
