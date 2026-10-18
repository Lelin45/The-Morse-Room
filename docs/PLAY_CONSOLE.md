# Morse Room: Learn & Chat in Google Play Console

Store name: **Morse Room: Learn & Chat**. Android package: **com.morsenepal**. Developer: **Lelin Adhikari**. The package name identifies this app across every Android update.

Build 11 introduces OTA support for compatible JavaScript, styles and bundled assets. Build 10 and earlier still need a binary update to gain that support. Native changes, including Android notification code or permissions, require a new AAB and the normal Play Console release process. OTA publication and website deployment are separate operations. See [Android updates](ANDROID_APP.md#updates-without-a-new-download-from-google-play) for the update channels and publishing commands.

## Public links

| Console field | URL |
| --- | --- |
| Privacy policy | https://learnmorse.lelinadhikari.com.np/privacy.html |
| Account deletion | https://learnmorse.lelinadhikari.com.np/delete-account.html |
| Terms and conditions | https://learnmorse.lelinadhikari.com.np/terms.html |
| Website | https://learnmorse.lelinadhikari.com.np/ |

The deletion page lets a signed-in person delete their own chat account and related live data. It also provides the developer's email for a verified removal request when sign-in is unavailable. Google requires both in-app account deletion and a public deletion resource for apps that create accounts. [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).

## App access instructions

Select the option indicating that some functionality is restricted. Learn, Practice, Codes, sound settings and themes work without an account. Chat is the restricted area.

Use the review email and password configured privately on the server in the Console's credential fields. They are a separate review access code, not a Google password. Never put them in app configuration or the public repository.

Paste these instructions into the reviewer instructions field:

> Learn, Practice and Codes do not require sign-in. Open Chat, then tap Review access. Enter the email and password supplied in the App access fields. No Google sign-in, verification code or two-factor step is needed for this review account. The account opens isolated test conversations with review_bot, an incoming test friend request, and a test group. Send a text message or Morse code, then use Show text and Listen. You can also test message reporting, blocking, unblocking through the account menu, and account deletion. The review username is fixed. If the test account is deleted, sign in through Review access again to recreate it. Ordinary users sign in with Google only for Chat.

The server restricts the review account to test users, requests and groups. It cannot see or contact real accounts. Review sign-in attempts are rate limited.

## Data safety answers

Complete the form against the submitted build and the published privacy policy. The current trainer has no advertising, analytics SDK, microphone recording, GPS, camera or device contacts access. Morse audio is generated on the device. Chat sends data to Cloudflare over HTTPS.

| Information | Current use |
| --- | --- |
| Verified Google email and account identifier | Account identity and optional friend discovery by email |
| Chosen username | Profile display, friend discovery and attribution of chat messages |
| Friend requests, friendships and group memberships | The user's social graph and access to conversations |
| Message text, Morse, group names and read positions | Messaging and Morse practice |
| Reports, reasons and supporting message evidence | Abuse review and account safety |
| Hashed network IP for temporary rate limits | Preventing repeated sign-in and review-code guesses |
| Optional push token, app installation identifier and account association | Delivering Android chat notifications to the selected installation |
| Completed lessons, best scores, lesson sequence and completion times | Restoring and syncing lessons for signed-in accounts |

Google's form includes Personal information, User IDs, Messages, Contacts including social connections, Other user-generated content, App activity, and Device or other IDs. Map each stored field to the applicable types in the current Console form. Completed lessons and scores serve App functionality and can fall under App interactions. Account-related collection is optional for the overall app, since all trainer features work without sign-in. Notification identifiers are optional and serve App functionality. Stored records are not processed only ephemerally. Cloudflare and Google process data as described in the privacy policy. Provider processing and user-directed message delivery have specific sharing exceptions; apply the form's definitions to this implementation. [Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469).

Firebase Messaging and its Installations dependency handle installation identifiers and technical app information for push delivery. Analytics collection and automatic messaging initialization are disabled; the app obtains a push token after the person enables notifications and signs in to Chat. Message content is fetched from the authenticated app API and is absent from the Firebase push payload. Account-specific native credentials, previews and reply drafts are encrypted on the device. Local-only records are separate from server collection. Verify the SDK disclosures against the final submitted binary. [Firebase Android data disclosure](https://firebase.google.com/docs/android/play-data-disclosure).

Account deletion removes the user's live account, sessions, provider identity, friendships, requests, memberships, authored messages, direct conversations, related reports, notification device registrations, queued delivery jobs and synced lesson progress. Groups with other people transfer ownership and keep those people's messages. D1 recovery history may contain earlier records for up to seven days. Local progress is removed by clearing app storage or uninstalling the app; account lessons can be restored after sign-in until the account is deleted. Sign-out also revokes the current session's notification credentials. A local push token and installation identifier may remain for reuse without an active account association.

## Android notification review

Notifications need the new native build, Android permission, Firebase configuration and a Google Play services device. They are optional; declining them leaves Learn, Practice, Codes and Chat usable. See [notification setup](NOTIFICATIONS_SETUP.md).

The first prompt explains message delivery and offers **Not now** or **Enable**. Enable opens Android's app notification settings. The account menu also provides Notifications to reopen those settings. Receive a message in a test conversation, expand its notification, then test **Show text**, **Listen**, and **Reply**. Reply offers Android text input or an expanded Morse editor. Locked devices require unlocking before content actions or sending a reply.

## Foreground service declaration

In Play Console's App content section, declare **Media playback** for `FOREGROUND_SERVICE_MEDIA_PLAYBACK`. The person starts it by tapping **Listen** on a message notification or a dit/dah paddle in its Morse reply editor. Choose audio playback as the use case. Receiving a message or sending a text reply does not start this service.

Suggested functionality description:

> When the user taps Listen on a chat notification, the app plays the message as Morse tones while the chat screen stays closed. Tapping the notification's Morse reply paddles also plays the selected tone. Playback has a visible notification with Stop and ends when the tones finish or the user stops it.

Suggested impact description:

> Delaying playback makes the Listen action appear unresponsive. Interrupting playback cuts the Morse sequence and makes it harder to decode. The user can stop playback at any time.

Provide a short demonstration video showing receipt of a test message, the Listen action, audible playback, and Stop. Google requires a video link for this declaration. No full-screen intent permission is used. [Foreground service declaration guidance](https://support.google.com/googleplay/android-developer/answer/13392821).

## Reviewing reports

The Report action records evidence in Cloudflare D1. The developer reviews that queue in the D1 console for `morse-room-chat`. It does not send emails automatically.

Read pending reports with:

```sql
SELECT id, reason, details, evidence_text, subject_id, conversation_id,
       datetime(created_at / 1000, 'unixepoch') AS reported_at
FROM chat_reports
WHERE status = 'pending'
ORDER BY created_at;
```

After investigating a report, replace the example value below with its exact report ID and mark it reviewed:

```sql
UPDATE chat_reports SET status = 'reviewed' WHERE id = 'REPORT_ID_FROM_QUERY';
```

Resolve abusive content through the database console according to the published terms. Reporting does not itself remove a message or ban a person; the user's Block action stops contact immediately. Keep report review within the developer's Cloudflare account. [Google Play user-generated content requirements](https://support.google.com/googleplay/android-developer/answer/9876937).
