# Morse Room: Learn & Chat for Android

The Expo project is in `mobile/`. Its Play Store name is **Morse Room: Learn & Chat** and its permanent Android application ID is **com.morsenepal**. It belongs to the existing Expo project `@lelin455/the-morse-room`.

Learn, Practice and Codes open without signing in. Their HTML, styles, character tables, word lists and sound generator are bundled in the app, so they work offline. Chat uses the existing website and Cloudflare D1 database and needs an internet connection. Google sign-in opens a system browser and returns to the app.

## Open and test the project

From the repository folder:

```powershell
cd mobile
npm.cmd ci
npm.cmd run check
npm.cmd start
```

`npm run check` rebuilds the offline trainer, runs its authentication and audio tests, checks ESLint, and checks TypeScript. Use the preview APK to test the complete app on a real Android phone. Expo Go cannot test the app's custom Google sign-in return URL.

The generated `mobile/generated/` directory is deliberately ignored by Git. `npm run prepare:trainer` recreates it from the public website sources. EAS runs that same command after dependency installation. Keep the website sources in the EAS upload alongside the `mobile/` project.

## Build files

`mobile/eas.json` defines two Android profiles:

| Profile | Output | Purpose |
| --- | --- | --- |
| `preview` | APK | Install and test directly on an Android phone. |
| `production` | AAB | Upload to a Google Play testing track. |

Both profiles use local upload-key credentials. The ignored `mobile/credentials.json` points at an ignored keystore inside `mobile/.credentials/`. Keep the keystore and both passwords backed up privately. They sign app updates; they are separate from the Expo account token, the Google OAuth secret and the database credentials.

From the repository root, the build commands are:

```powershell
node scripts/android-build.mjs preview
node scripts/android-build.mjs production
```

The build helper loads only the Expo access token from the ignored root `.env`, passes it to EAS CLI as `EXPO_TOKEN`, and queues the selected cloud build. Credentials belong in private files and must not be copied into app config, generated trainer files or `EXPO_PUBLIC_*` variables.

Building an AAB does not publish the app. Store submission, listing content and release review happen separately in Google Play Console.

## Updates without a new download from Google Play

Build 11 adds EAS Update. Build 10 and earlier do not contain its native configuration and cannot receive these updates. People must install build 11 or a later compatible build first.

The app checks for updates when it opens. It starts with its embedded or already downloaded version while a compatible update downloads in the background. The downloaded update runs on the next app restart. No update button or extra prompt is required. The embedded trainer remains available offline.

The preview and production builds use separate update channels and matching EAS environments. Publish a tested JavaScript, CSS, HTML or bundled asset change from the repository root with:

```powershell
node scripts/android-update.mjs preview "Check the new practice layout"
node scripts/android-update.mjs production "Improve practice feedback"
```

Each command publishes an Android update to the named channel. The helper regenerates the offline trainer before EAS exports the app, so website source changes reach the bundled WebView. It uses EAS CLI 24.12.1 and loads only `EXPO_TOKEN` from the ignored root `.env`; unrelated local credentials are excluded, and Expo's automatic local `.env` loading is disabled during export. Keep the update message in quotes.

Keep the same Firebase Android configuration used for that native build at `mobile/.credentials/google-services.json`. You can instead set the terminal environment variable `GOOGLE_SERVICES_JSON` to its readable file path. The helper checks the file and Android package before export. A fresh checkout needs this private setup file restored: omitting or changing it changes the native fingerprint, and the installed build cannot receive an update with a different runtime. A different path with identical file contents keeps the same runtime.

The `fingerprint` runtime policy separates updates when native inputs change. Native Kotlin, notification controls, Android permissions, native dependencies, signing or app configuration can require a new binary. This includes the build 11 notification tap fix and the initial OTA setup. OTA changes cannot add native capabilities to an installed older build. A website deployment is separate from publishing an app update.

Test a preview update by opening its compatible release build with internet available, then fully closing and reopening the app after the download. Verify the changed feature, saved preferences and offline startup before publishing the production update. Configuring EAS Update does not publish any update automatically.

[EAS Update setup](https://docs.expo.dev/eas-update/getting-started/), [runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/), [Expo SDK 57 update settings](https://docs.expo.dev/versions/v57.0.0/sdk/updates/).

## Android release optimization

Release builds enable R8 code shrinking, optimization and obfuscation, together with resource shrinking. `expo-build-properties` enables minification and resource shrinking. The local `withAndroidReleaseOptimization.cjs` config plugin selects `proguard-android-optimize.txt` and enables R8 full mode and integrated resource shrinking during prebuild. Keep these settings in app config so EAS regenerates them for every release.

The existing Expo and React Native consumer rules preserve native registration, JNI and WebView JavaScript bridge methods. Avoid adding package-wide keep rules: they can disable optimization across large libraries. Test the signed optimized APK's startup, audio, offline trainer, Chat, browser sign-in and saved settings before uploading its AAB.

Inspect `BUNDLE-METADATA/com.android.tools/r8.json` in the finished AAB for the measurements used by Play, and keep its `proguard.map` for crash deobfuscation. Play can read the mapping embedded in the AAB. A native optimization change requires a new Android build.

[Google's DEX optimization guidance](https://developer.android.com/google/play/vitals/code-optimization), [R8 release configuration](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization), [Expo SDK 57 build properties](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/).

## Opening animation

The app opens with a short animation and the word WELCOME in Morse at 24 WPM and 600 Hz. It follows the trainer's saved theme and volume once the bundled screen has loaded, and also respects device sound settings. Skip stops the sound immediately and opens the trainer. Moving the app into the background stops the introduction. It runs once per cold launch and does not repeat when returning to an open app.

`prepare-trainer.mjs` generates `assets/welcome.wav` from the same `MORSE` and `getTiming` definitions used by the trainer. It includes a silent lead and short fades to avoid clipping or clicks. The app plays it with native `expo-audio`; the main trainer keeps its existing Web Audio timing engine.

## Sign-in and local progress

The offline document uses the website's HTTPS origin in WebView. Its same-origin API calls use the existing HttpOnly session cookie. Google pages are never loaded inside WebView. A system browser completes website sign-in, then hands the app a short-lived, single-use code. The app proves ownership using its original PKCE verifier before the backend installs a session cookie in WebView. Codes and verifiers are kept temporarily in encrypted SecureStore and are cleared when used, expired or signed out.

Guest progress and sound settings stay on the device. Signing in syncs completed lessons and best scores with the account in Cloudflare D1, across the Android app and website. Reinstalling removes local settings, but account lessons return after sign-in. Offline account progress syncs after reconnection. Installing an update preserves local storage. Account deletion removes server-side lesson progress along with the chat account.

Firebase Cloud Messaging delivers optional Android chat notifications. Cloudflare Pages and D1 continue to serve account, lesson and chat data. A separate free Cloudflare Worker sends message identifiers to Firebase; the Android module retrieves authorized content and supports Show text, Listen, Text replies and Morse replies. See [notification setup](NOTIFICATIONS_SETUP.md). Firebase Authentication, Firestore and Analytics are not used.

## Google Play links

- Privacy policy: <https://learnmorse.lelinadhikari.com.np/privacy.html>
- Terms and conditions: <https://learnmorse.lelinadhikari.com.np/terms.html>
- Account deletion: <https://learnmorse.lelinadhikari.com.np/delete-account.html>

For Play Console's App access section, choose the option indicating that some functionality is restricted. Explain that Learn, Practice and Codes work without an account. Chat is the restricted feature. Give reviewers the dedicated review sign-in instructions and the review credentials from your private setup, without placing those credentials in the app or repository. The review account uses a separate test conversation and cannot sign in as an ordinary user.

Before requesting a public release, install the APK on a real phone and check the introduction and Skip, first Morse sound, Receiving and Sending, the Codes keyboard, keyboard visibility, rotation, background pause, Google sign-in, Chat sending, sign-out, and account deletion. Test Learn, Practice and Codes with airplane mode enabled. Google Play's Data safety answers must match the current privacy policy and the account and Chat features included in the submitted build.

## Implementation references

- [Expo Android build guide](https://docs.expo.dev/build/setup/)
- [React Native WebView](https://docs.expo.dev/versions/v57.0.0/sdk/webview/)
- [Android local HTML and HTTPS base URLs](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Expo native audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/)
- [Google browser authentication policy](https://developers.google.com/identity/protocols/oauth2/policies)
