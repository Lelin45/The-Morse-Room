# Morse Code Nepal in Google Play Console

Store name: **Morse Code Nepal**. Android package: **com.morsenepal**. Developer: **Lelin Adhikari**. The package name identifies this app across every Android update.

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

Google's form includes Personal information, User IDs, Messages, Contacts including social connections, and Other user-generated content. Map each stored field to the applicable types in the current Console form. Treat Chat-related collection as optional for the overall app, since all trainer features work without Chat. Cloudflare and Google process data as described in the privacy policy. Provider processing and user-directed message delivery have specific sharing exceptions; apply the form's definitions to this implementation. [Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469).

Account deletion removes the user's live account, sessions, provider identity, friendships, requests, memberships, authored messages, direct conversations and related reports. Groups with other people transfer ownership and keep those people's messages. D1 recovery history may contain earlier records for up to seven days. Device progress is removed by clearing app storage or uninstalling the app.

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
