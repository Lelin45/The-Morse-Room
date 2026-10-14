import { all, run, one, base64url, hashToken } from '../../server/chat/db.js';
import { notificationRecipient, dispatchPending } from '../../server/chat/notifications.js';

const MAX_JOBS = 20;
const MAX_ATTEMPTS = 32;
const LEASE_MS = 120000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const tokenCache = new Map();

class DeliveryError extends Error {
  constructor(transient = true, unregistered = false) {
    super('Push delivery could not complete.');
    this.transient = transient;
    this.unregistered = unregistered;
  }
}

function serviceAccount(env) {
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (account.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(account.project_id || '')
      || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/.test(account.client_email || '')
      || typeof account.private_key !== 'string' || account.private_key.length > 16384
      || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')) throw new DeliveryError();
  return account;
}

async function responseJSON(response) {
  const text = await response.text();
  if (text.length > 65536) throw new DeliveryError();
  try { return JSON.parse(text); } catch { throw new DeliveryError(); }
}

async function firebaseAccessToken(env, fetcher, now) {
  const account = serviceAccount(env);
  const fingerprint = await hashToken(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const cached = tokenCache.get(fingerprint);
  if (cached && cached.until > now) return { account, token: cached.token, fingerprint };
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(pem)) throw new DeliveryError();
  const bytes = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', bytes, algorithm, false, ['sign']);
  const encoded = (object) => base64url(new TextEncoder().encode(JSON.stringify(object)));
  const seconds = Math.floor(now / 1000);
  const header = encoded({ alg: 'RS256', typ: 'JWT' });
  const payload = encoded({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: seconds, exp: seconds + 3600 });
  const signingInput = `${header}.${payload}`;
  const signature = base64url(await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signingInput)));
  const response = await fetcher(TOKEN_URL, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${signature}` }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await responseJSON(response);
  if (!response.ok || typeof result.access_token !== 'string' || !result.access_token
      || !Number.isFinite(result.expires_in) || result.expires_in < 60) throw new DeliveryError();
  // Cache for at most nine minutes and leave a margin before provider expiry.
  if (tokenCache.size >= 4) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(fingerprint, { token: result.access_token, until: now + Math.min(540000, (result.expires_in - 30) * 1000) });
  return { account, token: result.access_token, fingerprint };
}

async function deliver(job, auth, fetcher) {
  const response = await fetcher(`https://fcm.googleapis.com/v1/projects/${auth.account.project_id}/messages:send`, {
    method: 'POST', redirect: 'error', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}`,
    }, body: JSON.stringify({ message: {
      token: job.fcmToken,
      data: { messageId: String(job.messageId), conversationId: job.conversationId },
      android: { priority: 'HIGH', ttl: '86400s', restricted_package_name: 'com.morsenepal' },
    } }), signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const details = await responseJSON(response);
  const unregistered = details?.error?.details?.some((item) => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
    && item.errorCode === 'UNREGISTERED') === true;
  if (response.status === 401) tokenCache.delete(auth.fingerprint);
  // Permission/configuration problems may be repaired during the retry window.
  throw new DeliveryError(!unregistered && (response.status === 401 || response.status === 403
    || response.status === 429 || response.status >= 500), unregistered);
}

async function retry(env, job, lease, error, now) {
  const dead = error.transient === false || job.attempts >= MAX_ATTEMPTS;
  const delay = Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7));
  await run(env, `UPDATE chat_notification_outbox SET status = ?, next_attempt_at = ?, lease_until = 0, lease_id = NULL
    WHERE id = ? AND lease_id = ?`, dead ? 'dead' : 'pending', now + delay, job.id, lease);
}

export async function drainNotifications(env, { fetcher = fetch, now = Date.now } = {}) {
  const start = now();
  const lease = crypto.randomUUID();
  // UPDATE RETURNING leases a batch atomically, including jobs from interrupted
  // workers whose two-minute lease has expired. A second worker cannot claim it.
  const jobs = await all(env, `UPDATE chat_notification_outbox SET status = 'sending',
    lease_id = ?, lease_until = ?, attempts = attempts + 1 WHERE id IN (
      SELECT id FROM chat_notification_outbox WHERE expires_at > ? AND attempts < ?
      AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?))
      ORDER BY id LIMIT ?) RETURNING id, device_id AS deviceId, message_id AS messageId, attempts`,
    lease, start + LEASE_MS, start, MAX_ATTEMPTS, start, start, MAX_JOBS);
  if (!jobs.length) return { claimed: 0, delivered: 0 };
  let auth;
  try { auth = await firebaseAccessToken(env, fetcher, start); }
  catch (error) {
    await Promise.all(jobs.map((job) => retry(env, job, lease, error, now())));
    return { claimed: jobs.length, delivered: 0 };
  }
  let index = 0;
  let delivered = 0;
  // Five outstanding requests stay within Workers' six-connection limit. Twenty
  // FCM calls plus token exchange and one continuation fit the free-tier limit.
  await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      let recipient;
      try {
        recipient = await notificationRecipient(env, job.deviceId, job.messageId, now());
        if (!recipient) {
          await run(env, "UPDATE chat_notification_outbox SET status = 'dead', lease_until = 0, lease_id = NULL WHERE id = ? AND lease_id = ?", job.id, lease);
          continue;
        }
        await deliver(recipient, auth, fetcher);
        await run(env, "UPDATE chat_notification_outbox SET status = 'done', lease_until = 0, lease_id = NULL WHERE id = ? AND lease_id = ?", job.id, lease);
        delivered += 1;
      } catch (error) {
        if (error.unregistered && recipient) {
          // Do not delete a newly refreshed registration token after an old send.
          await run(env, 'DELETE FROM chat_notification_devices WHERE id = ? AND fcm_token = ?', job.deviceId, recipient.fcmToken);
        } else await retry(env, job, lease, error, now());
      }
    }
  }));
  const remaining = await one(env, `SELECT 1 AS pending FROM chat_notification_outbox
    WHERE status = 'pending' AND next_attempt_at <= ? AND expires_at > ? AND attempts < ? LIMIT 1`, now(), now(), MAX_ATTEMPTS);
  if (remaining) await dispatchPending(env, fetcher).catch(() => {});
  return { claimed: jobs.length, delivered };
}

async function authorized(request, env) {
  const expected = env.PUSH_DISPATCH_KEY;
  const provided = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!/^[A-Za-z0-9_-]{43}$/.test(expected || '') || !provided) return false;
  return await hashToken(provided) === await hashToken(expected);
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname !== '/dispatch' || request.method !== 'POST') return new Response(null, { status: 404 });
    if (!await authorized(request, env)) return new Response(null, { status: 401 });
    // Return quickly to Pages, then fan out independently of the chat response.
    context.waitUntil(drainNotifications(env).catch(() => {}));
    return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  },
  async scheduled(_event, env, context) {
    const now = Date.now();
    await run(env, `DELETE FROM chat_notification_outbox WHERE id IN (
      SELECT id FROM chat_notification_outbox WHERE expires_at <= ? OR
        (status IN ('done', 'dead') AND created_at <= ?) LIMIT 500)`, now, now - 7 * 86400000);
    context.waitUntil(drainNotifications(env).catch(() => {}));
  },
};
