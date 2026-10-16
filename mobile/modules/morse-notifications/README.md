# Android message notifications

This local Expo module receives FCM data messages and provides notification actions without starting the chat screen. It is linked from `mobile/modules` during Expo prebuild. A new native build is required.

- Default message actions: Show text, Listen and Reply.
- Reply changes the notification to Text reply or Morse reply. Text uses Android inline reply. Morse uses an expanded native editor with dit, word space, dah, Send Morse and Backspace.
- Show text, Listen and reply mode changes use background broadcasts so the notification shade stays open. Text reply opens Android's inline keyboard in the same notification. Morse reply keeps the keyboard hidden and uses the notification's own buttons.
- A 650 ms pause separates Morse letters. The word-space button adds `//`. The sending endpoint validates and decodes the complete draft.
- Listen streams 18 WPM, 600 Hz audio through Android media playback. It respects the system media volume and audio focus. Stop ends playback.
- Locked devices display a generic private preview. Showing text, playing audio and sending replies require the device to be unlocked.
- Actions deliberately do not set `authenticationRequired`: Android closes the shade for that flag even on an unlocked phone. The receiver checks the lock state before reading or changing a message, Android protects inline reply on the lock screen, and the public preview has no private content or actions.
- Credentials, message previews and drafts use Android Keystore AES-GCM encryption. Sign-out cancels work and notifications and forgets account data. Only the device identifier and FCM registration token survive sign-out.
- The message cache keeps up to 20 previews for at most seven days. Worker job data contains routing identifiers only, never message text or credentials.

## Configuration

The app must supply Firebase Android configuration through its Expo config and Google services plugin. Firebase Cloud Messaging is used without Analytics. When Firebase configuration is missing, the module reports `fcmConfigured: false` and leaves Learn, Practice and Codes usable.

Request Android notification permission through the app UI before registration. `getStateAsync()` also checks the app-level and Morse messages channel switches. `openSettingsAsync()` opens the app's notification settings.

The app obtains a revocable, device-scoped capability from its own authenticated server and calls:

```ts
await nativeNotifications.configureAsync({ deviceId, userId, authToken });
```

`getStateAsync().deviceId` is the installation UUID and is sent to the registration endpoint as `installationId`. The registration endpoint returns a separate server `deviceId`; that returned value is passed to `configureAsync()`. State exposes it as `registeredDeviceId`, while `configuredUserId` identifies the signed-in account. Token rotation sends the configured server identifier. Call `clearAsync()` after revoking that device capability on sign-out. Account changes also clear old account data automatically.

## Server contract

FCM must send a high-priority **data-only** payload containing `messageId` and `conversationId`. Do not include a Firebase notification payload, because Android would handle it without the module's actions while the app is in the background. Message text and credentials do not enter FCM payloads.

All native requests use the fixed HTTPS app origin and `Authorization: Bearer <device capability>`. Redirects are disabled.

- `GET /api/notifications/message?id=...` returns `{message:{id,conversationId,senderUsername,text,morse,conversationName?}}` after authorizing that recipient.
- `POST /api/notifications/reply` receives `{messageId,conversationId,kind,clientId,text? ,morse?}`. The server validates participation, blocks, lengths and rate limits. `clientId` makes network retries idempotent.
- `POST /api/notifications/device-token` receives `{deviceId,fcmToken}` after authorizing that device. This lets token rotation update registration while JavaScript is closed.

## Verification

`MorseCodecTest` checks the complete alphabet and numbers, punctuation removal, accented text, invalid drafts and the standard PARIS timing unit. Run the module's `testReleaseUnitTest` task in a generated Android project.

`showDebugNotificationAsync()` rejects production builds. Release QA can call `fetchMessageNotificationAsync(realMessageId)`, which fetches only a real, authorized server message and runs the same delivery worker as FCM. This can verify notification controls while Firebase provisioning is pending. Actual push delivery still requires Firebase configuration and a physical or Play-services-enabled Android device.

Primary implementation references: [Expo module API](https://docs.expo.dev/modules/module-api/), [FCM receiving](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [Android custom notifications](https://developer.android.com/develop/ui/views/notifications/custom-notification).
