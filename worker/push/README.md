# Android message notifications

The website still uses Cloudflare Pages and D1. A small separate Cloudflare Worker sends Android notifications through Firebase Cloud Messaging. Firebase handles push delivery only; account, membership and message data stay in the existing D1 database.

## Bindings

Apply `migrations/0008_notifications.sql` to the existing D1 database after migrations 0001 through 0007. Bind that same database to both Pages and this Worker as `DB`.

Copy `wrangler.example.jsonc` to a private deployment configuration and replace the database ID. The preferred deployment connects Pages to this Worker through a `PUSH_DISPATCHER` service binding targeting `morse-room-push`. This avoids a public dispatch URL and does not require permission to read the account's `workers.dev` subdomain. The Worker may also bind `PUSH_DISPATCHER` to itself for continuation batches.

Set these secrets on **both** the Pages production environment and the push Worker:

| Name | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The Firebase service-account JSON, with permission to use the Firebase Cloud Messaging API for the app's project |
| `PUSH_DISPATCH_KEY` | A random 32-byte base64url value, generated separately from OAuth and signing credentials |

When service bindings are unavailable, set `PUSH_DISPATCH_URL` on both services to the Worker's HTTPS `/dispatch` URL. That fallback requires its `workers.dev` endpoint or an equivalent HTTPS custom domain. Keep `global_fetch_strictly_public` enabled on both services for public dispatch routing. Keep the one-minute cron in either deployment.

The Android app requires its matching `google-services.json` at build time and Firebase Messaging initialization. A frontend update alone cannot add Android notification permissions, receivers or notification actions.

## Delivery and security

`POST /api/notifications/devices` uses the app's existing same-origin session cookie. It returns a rotating device capability once. The database stores its SHA-256 hash, not the plaintext credential. The Android module stores the returned credential encrypted with Android Keystore. Registration is limited to eight installations per account.

An installation may move between accounts only when the caller presents its existing opaque FCM registration token or its previous device capability. Moving accounts discards the old account's pending notification jobs. Registering again for the same account preserves pending jobs.

Native notification actions use the capability with `GET /api/notifications/message`, `POST /api/notifications/reply`, and `POST /api/notifications/device-token`. The capability is tied to a current, unexpired chat session. Logout and account deletion revoke it through database foreign-key cascades. Message reads and replies recheck membership, accepted friendships, blocks and review-account isolation. A reply's source message must belong to the conversation being replied to.

Message sends queue one job for each eligible recipient device. The unique device/message pair prevents duplicate jobs when a client retries. A push contains only a message ID and conversation ID. Message text, Morse content and usernames are fetched through the authenticated native API rather than sent in the Firebase payload.

The Worker atomically leases at most 20 jobs for two minutes, sends with at most five concurrent FCM requests, and then starts another authenticated invocation if work remains. Service binding and URL dispatch paths both authenticate with `PUSH_DISPATCH_KEY`. Each invocation stays within the Workers Free allowance of 50 external requests. Jobs expire after 24 hours. Temporary failures use backoff; interrupted leases and unavailable dispatch requests recover through the cron. Invalid unregistered FCM tokens are removed without deleting a token that refreshed while a send was in progress.

Cloudflare caps Worker call chains. Large fan-outs beyond one chain resume on the next cron tick. Firebase or network retries can also result in duplicate delivery after an ambiguous timeout, so the Android notification handler uses message IDs to deduplicate displayed notifications. Push notifications remain subject to Android permission, battery and delivery restrictions.

## Verification

Run `node --test tests/notifications-backend.test.mjs`. Tests use generated RSA signing keys, an in-memory D1-compatible SQLite database and mocked outbound requests. They never send notifications to real users.

References: [FCM HTTP v1 authentication and sending](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/), and [public global fetch routing](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).
