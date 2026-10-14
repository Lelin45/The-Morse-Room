# Android chat notifications

Firebase Cloud Messaging delivers Android push notifications. Chat accounts and messages stay in the existing Cloudflare D1 database. Firebase Authentication, Firestore, Analytics and a paid server are not needed. Cloud Messaging is available without charge on Firebase's Spark plan; Cloudflare's free usage limits still apply. [Firebase pricing](https://firebase.google.com/pricing).

## Firebase project and Android app

The configured Firebase project is **morse-room-3dd4b**. The Android package is **com.morsenepal**. This Firebase project can differ from the existing Google OAuth project; the app configuration and messaging service-account key must refer to the same Firebase project.

1. Open the [Firebase project](https://console.firebase.google.com/project/morse-room-3dd4b/overview).
2. Select the gear beside Project overview, then Project settings.
3. In General, register an Android app with package `com.morsenepal` if it is not already listed. A SHA-1 certificate is not required for push messaging.
4. Download `google-services.json` and save it as `mobile/.credentials/google-services.json` in this repository.
5. Open Service accounts, then Firebase Admin SDK. Generate a private key and save the downloaded JSON as `.credentials/firebase-service-account.json` at the repository root.

Both files are ignored by Git. The Android configuration is included in the native build through the `GOOGLE_SERVICES_JSON` file variable in EAS production and preview environments. `mobile/app.config.ts` uses that file in the cloud and the local client configuration for development. The service-account private key belongs only on the server and must never be included in the app, screenshots or public repository. [Android Firebase configuration](https://firebase.google.com/docs/android/setup), [service-account setup](https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments).

## When Cloud Messaging settings are hard to find

The Firebase Project settings page may show Cloud Messaging as a tab. Its direct URL is [Cloud Messaging settings](https://console.firebase.google.com/project/morse-room-3dd4b/settings/cloudmessaging).

The API can also be enabled from Google Cloud independently of that tab:

1. Open the [Firebase Cloud Messaging API](https://console.cloud.google.com/apis/library/fcm.googleapis.com?project=morse-room-3dd4b).
2. Confirm the selected project is `morse-room-3dd4b`.
3. If **Enable** appears, select it. If **Manage** appears, the API is already enabled.

This implementation uses HTTP v1 and a service account. A legacy server key is not required. The Firebase Messaging campaign composer is not used for chat: chat sends data-only payloads so the native app can attach Show text, Listen and Reply. [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

## Cloudflare connection

Apply migrations through `0009_learning_progress.sql` to the existing `morse-room-chat` D1 database. Migration 0008 adds notifications; migration 0009 adds signed-in lesson sync. Keep that database bound as `DB` on both Pages and the separate push Worker. Do not create a second user database.

For token-based setup, keep the existing Cloudflare Pages and D1 permissions and add **Account → Workers Scripts → Edit**. An internal service binding avoids needing access to the account's Workers subdomain settings.

Set these values on the push Worker and the Pages production environment:

| Name | Type | Purpose |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | Complete Firebase service-account JSON |
| `PUSH_DISPATCH_KEY` | Secret | Random 32-byte base64url credential for private dispatch requests |
| `PUSH_DISPATCHER` | Worker service binding | Internal connection to `morse-room-push` |

The preferred deployment uses a `PUSH_DISPATCHER` service binding on Pages to call the push Worker without a public dispatch URL. The Worker can use the same binding to itself for continued delivery batches; its one-minute cron also recovers pending work.

An HTTPS `PUSH_DISPATCH_URL` ending in `/dispatch` is the fallback when a service binding is unavailable. For that path, enable the Worker's public endpoint and `global_fetch_strictly_public` on both services. Worker deployment and delivery details are in [the push Worker README](../worker/push/README.md).

The Worker sends only message and conversation identifiers through FCM. The native app fetches authorized message content from the existing API. A device credential is tied to a current chat session; sign-out and account deletion revoke its server access.

## Build and test

A new Android build is required. A website change or OTA update alone cannot add the notification module, Firebase resources, receivers or media playback service.

1. Build with the matching Firebase Android configuration.
2. Install on a physical Android device with Google Play services or a compatible Google APIs emulator.
3. Sign in to Chat and choose Enable in the notification prompt. Turn on notifications in Android settings and return to the app.
4. Send a message from a separate authorized test account while the recipient app is in the background.
5. Verify Show text, Listen and Stop, then Text and Morse replies. Verify that sign-out stops access to the old account's notifications.

The Firebase console's ordinary notification campaigns do not test this app's data-only chat actions. Use a real test conversation. Android force-stop, notification settings, battery restrictions and connectivity can prevent or delay push delivery. [FCM Android requirements](https://firebase.google.com/docs/cloud-messaging/android/get-started).

For Google Play, update Device or other IDs in Data safety and declare the user-initiated Media playback foreground service. See [Play Console guidance](PLAY_CONSOLE.md).
