# Morse Room

A Morse code trainer with free lessons, sending practice, and receiving practice. Run it on your own computer, or visit [Morse Room](https://learnmorse.lelinadhikari.com.np). Learn and Practice need no account. The optional Morse Chat Room uses Google sign-in to practise through conversations with friends.

## Requirements

- **Node.js 22.13 or newer:** install it from the [official Node.js download page](https://nodejs.org/en/download). The installer includes npm.
- **Windows, macOS, or Linux**, with a modern browser that supports Web Audio, such as Chrome, Edge, Firefox, or Safari.
- **Git** is needed only if you choose the clone method below.

Learn and Practice have zero runtime dependencies. You do **not** need to run `npm install` for the local trainer. After downloading the app and installing Node.js, these modes work offline. Chat needs an internet connection, Cloudflare Pages Functions, a D1 database, and configured Google sign-in.

## Download and run

### Clone with Git

Open a terminal and run:

```sh
git clone https://github.com/Lelin45/The-Morse-Room.git
cd The-Morse-Room
npm start
```

Open [http://localhost:4173](http://localhost:4173) in your browser.

### Download a ZIP

1. Open [Lelin45/The-Morse-Room on GitHub](https://github.com/Lelin45/The-Morse-Room).
2. Select **Code > Download ZIP**, or [download the ZIP directly](https://github.com/Lelin45/The-Morse-Room/archive/refs/heads/main.zip).
3. Extract the ZIP and open the extracted project folder, which contains `package.json`.
4. Open a terminal in that folder and run:

   ```sh
   npm start
   ```

5. Open [http://localhost:4173](http://localhost:4173) in your browser.

### Windows PowerShell

If PowerShell blocks `npm` because script execution is disabled, use `npm.cmd` instead:

```powershell
npm.cmd start
```

For the test command, use `npm.cmd test`.

### Starting and stopping

Keep the terminal running while using Morse Room. You can close the browser and reopen [http://localhost:4173](http://localhost:4173) while the local server is still running.

Press **Ctrl + C** in the terminal to stop the server. After restarting your computer, open a terminal in the project folder, run `npm start` again, and reopen the browser address. On Windows PowerShell, `npm.cmd start` also works.

## Get updates

If you cloned the repository, stop the server with **Ctrl + C**, then run these commands inside `The-Morse-Room`:

```sh
git pull --ff-only
npm start
```

Commit or stash any local changes before pulling. Refresh the browser after restarting the server. On Windows PowerShell, use `npm.cmd start` if needed.

If you downloaded a ZIP, download a fresh ZIP from GitHub, extract it into a new folder, and start the app from that folder. Downloading updates requires an internet connection.

## Learn

There are 18 levels. Levels 1 to 13 introduce two letters at a time in this exact order:

`ET`, `AN`, `IM`, `SO`, `RK`, `DU`, `GB`, `QF`, `YL`, `CP`, `ZX`, `VW`, `HJ`

Levels 14 to 18 introduce `01`, `23`, `45`, `67`, and `89`.

The level introduction shows the two new characters with their Morse patterns underneath. Select **Start lesson** to hear each character with its dit/dah guide. Replay as often as you like, then move to the next character. After both characters, choose **Replay lesson** or **Start practice**.

Lessons have 5, 10, 15 signals and increase by five each level, up to 90 at level 18. The first lesson uses E and T only. From level 2, 60% of signals use the newest pair and 40% review all previous characters, mixed in random order. Level 4 has 20 signals and level 18 has 90. A visible **5, 4, 3, 2, 1** countdown runs before the first practice signal.

On a computer, type one character in the left column and press **Enter**. On a phone, listen to the full signal, then tap its letter or number on the built-in keyboard. The tap checks your answer automatically without opening the phone keyboard. A green tick or red cross marks your answer; the right column shows the correct character and its Morse pattern. A correct answer plays the next signal automatically. A wrong answer repeats the same signal until you answer correctly. Complete every signal correctly to unlock the next level.

Use **Replay** beside the typing box to hear the current signal again. Click a revealed answer in the right column to hear that character without changing your progress.

Answer feedback, scores, and level completion messages appear centered below both columns.

## Practice

Choose **Receiving** or **Sending**, then **Letters**, **Numbers**, or **Custom**.

For Letters and Numbers, choose **Unlimited** or **Set number of characters** (**Set a limit** on a phone). Mobile setup groups the mode, practice characters, and session length into separate sections with tap controls. These modes have no copy-and-answer columns.

- **Receiving:** hear one signal, then press its letter or number on a computer keyboard. On a phone, tap the built-in QWERTY keyboard with its number row. A wrong answer shows a red alert and replays the same signal. Only a correct answer moves forward. **Show correct answer** reveals the character and Morse pattern, then replays it; you still need to answer correctly.
- **Sending:** a character appears. Enter its Morse with Left Arrow for dit and Right Arrow for dah on a computer, or the round Dit/Dah buttons on a phone. Pause between letters and use Space between words. **Check** checks your signal; a mistake clears your Morse entry and keeps the same target for another attempt. Undo and Show correct answer are available.

**Custom Receiving** keeps continuous copying. Choose Custom to type your character selection, or use All letters, All numbers, or All. A preset disables the manual field; switching back to Custom restores your previous selection. Listen and type in the copy field. Answers stay hidden until **Submit copy** after a finite session, or **Stop & check**. Pause keeps answers hidden. Case and optional spaces do not affect grading. The audio slider replays received audio without changing the session or score.

Custom sessions offer Unlimited, a set character count, Random word groups, and Real word groups. Random groups use the selected character pool with proper word gaps and automatic spaces as you type. **Real word groups** uses whole English words, with 2 to 50 words and exactly 2 to 10 letters per word. Real words use the word bank rather than the selected character pool. Each session shuffles a fresh selection without repeated words. **Custom Sending** shows one character or word at a time and advances after a correct Morse answer.

Real-word practice includes 2,996 offline words, including 94 two-letter entries. The words are a curated subset of [Yet Another Word List (YAWL)](https://github.com/elasticdog/yawl), by Mendel Leo Cooper and Alan Beale. The selected word data is public domain; see the [author's notice](https://raw.githubusercontent.com/elasticdog/yawl/master/yawl-0.3.2.03/README). Two-letter words include dictionary terms, interjections, and musical notes. OK is included as a common addition.

On a phone, **Codes** is a separate tab after Practice. It shows a QWERTY keyboard with a number row and Morse patterns under all 36 keys; tap a key to hear it. On a computer, the reference stays inside Practice. Press a letter or number outside a text field to hear its Morse preview. An active Receiving quiz uses those keys to answer; previews during other active practice pause the session, and Resume continues it. Mobile Learn also uses the QWERTY keyboard. Desktop shortcut hints stay off mobile screens.

## Sound and saved progress

On phones, tap **Speed** above Learn or Practice, or the speaker icon in the header, to adjust WPM, Farnsworth, frequency, and volume. Adjust character speed from 5 to 60 WPM, Farnsworth speed from 1 WPM up to character speed, frequency from 200 to 1,200 Hz, and volume from 0 to 100%. Farnsworth increases the gaps between characters and words while keeping the selected character speed. Changes during a session apply to the next character. Use **Test your sound** before starting.

Timing follows the [standard PARIS calculation](https://morsecode.world/international/timing/) and [Farnsworth calculation](https://morsecode.world/international/timing/farnsworth.html). With character speed `C` and Farnsworth speed `F`, all durations below are in seconds:

- Dit: `1.2 / C`; dah: three dits; silence within a character: one dit.
- Farnsworth spacing unit: `(60 / F - 31 * dit) / 19`.
- Character gap: three spacing units; word gap: seven spacing units.

At 20 WPM with 10 WPM Farnsworth, a dit lasts 60 ms, a dah 180 ms, a character gap about 654 ms, and a word gap about 1,525 ms. Equal character and Farnsworth speeds give standard Morse spacing. Learn pauses for your answer, so its overall session speed also depends on how quickly you type.

Morse marks are scheduled on the browser's audio clock. A silent preparation period lets the audio start before the first mark, and continuous practice keeps its configured gaps between characters and words.

Use the **sun/moon switch** at the top right to change between the light theme and a black theme with bright green text and controls. The first visit follows your device's theme; your choice is saved for later visits.

Completed levels, sound settings, and your theme choice are stored in this browser's `localStorage`. They stay on your computer. Use the same browser and address to keep your progress when you update the app. Clearing site data or using another browser gives you a separate saved history.

## Android app

The Expo Android project in [mobile](mobile/) is named **Morse Room: Learn & Chat**, with application ID **com.morsenepal**. It bundles Learn, Practice, Codes, and the sound generator for offline use. Only Chat needs sign-in and an internet connection. The opening animation plays WELCOME in Morse at 24 WPM and can be skipped.

See [Android setup and builds](docs/ANDROID_APP.md) for the APK testing build, Play Store AAB, signing credentials, and developer commands. [Play Console setup](docs/PLAY_CONSOLE.md) includes the public policy links, review access instructions, and data disclosures.

## Advanced Radio mode

Turn on **Advanced mode** in the audio settings to use **Radio, Practice, Callsigns and Chat**. Turn it off to return to Learn and Codes; lesson progress is preserved. The standard training and chat layouts keep their existing controls and themes.

The Android Radio screen can decode live PCM audio from a selected microphone or compatible wired/USB audio input. Choose the input and audible target tone in Connection setup, then Start receiving. Incoming audio is processed locally in memory and is not saved or uploaded. Noise and uneven sending can cause decoding errors. Callsigns provides a local station profile and saved-station notebook; no online callsign identity verification is implied.

S-Pixie transmission requires an external isolated **MR1 USB keyer**, not an ordinary USB cable. Transmit remains disabled until a compatible controller completes its handshake, a station callsign has been entered, and the physical interface has been acknowledged. The controller performs dit/dah timing and has a 2.5-second host-loss watchdog. Only its completion event marks a message as transmitted. Leaving the app, unplugging hardware or pressing Stop cancels the operation.

The 7.023 MHz Pixie has no USB or Bluetooth built in. USB-C phones such as the OnePlus Nord 2T need an audio adapter with a microphone/line **input**; output-only headphone dongles cannot receive radio audio. A compatible hub can connect audio and keying interfaces together. See the [hardware guide and Raspberry Pi Pico reference firmware](hardware/pixie-keyer/README.md) before choosing or connecting adapters. Wireless keying and other radio-control protocols are not included in this first version. Hardware communication is available in the Android build, while the website can show setup guidance and manage local callsigns.

Android chat notifications use Firebase Cloud Messaging with a separate Cloudflare Worker. They offer Show text, Listen, and Text or Morse replies directly in the notification. See [notification setup](docs/NOTIFICATIONS_SETUP.md) for the Firebase files, private Worker binding and build requirements. Chat data stays in the existing D1 database.

Signing in also syncs completed lessons and best scores between the website and Android app. Reinstalling the app restores that account's lessons after sign-in. Guest practice stays local, and offline account progress syncs when the device reconnects.

The [Google Play upload files](store-listing/) include the app name, descriptions, icon, feature graphic, phone and tablet screenshots, and a preview video. The folder's guide lists which files go into each Console field.

## Morse Chat Room

Choose **Morse Chat Room** below Practice in the sidebar. Use the account icon at the top right to sign in with Google, then choose a unique username. Your username, profile settings, and Sign out stay in that account menu across all tabs. Sign-in applies only to Chat.

- **Friends:** send a request using an exact username or registered email. The recipient accepts or declines from the top-right notification bell. An accepted request opens a conversation for both people.
- **Groups:** choose a name and make the group Public or Private. **Find public groups** searches the public directory and shows each group's member count out of 100. Request to join; the creator accepts or declines in the notification bell. Private groups stay out of the directory and keep the invite-code or invite-link flow. Existing groups remain private after upgrading.
- **Group members:** each group has a strict 100-member limit. The creator can use **Members** to remove someone, which immediately revokes their access and prevents reuse of an old invite. If the creator deletes their account, ownership passes to a remaining member.
- **Messages:** type ordinary text and send it as international Morse. Each message has **Show text** and **Listen** controls below its bubble. Words stay hidden until revealed, and audio plays only when requested.
- **Sound:** The top audio settings apply to Learn, Practice, Codes, Chat, and Android notification playback. **Default** uses 18 WPM and 12 WPM Farnsworth; tone frequency and volume remain adjustable. **Custom** also enables the speed controls and remembers your selected speeds. Listen changes to **Stop audio** during playback.
- **Notifications:** the bell shows incoming friend requests and unread signals. An open conversation checks for messages every five seconds while the page is visible. The inbox checks every 30 seconds in Chat, every minute in Learn or Practice, and when you open the bell. Hidden tabs stop checking.
- **Typing:** select **Text** to write ordinary text, or **Morse** to enter the signal yourself. On a computer, Left Arrow enters a dit (`.`) and Right Arrow enters a dah (`-`). On a phone, use the two round Dit and Dah buttons; the phone keyboard stays closed. A pause completes the current letter automatically, and the next tap starts a new letter. Space creates a word gap. The default pause is 700 ms; slower custom spacing can extend it up to 1.5 seconds. Each tap plays its tone. Use Backspace or the backspace icon to correct, and the Send button beside the field to send. Morse groups must be valid letters or numbers; Show text decodes them.
- **Drafts:** text and Morse drafts are kept separately while switching modes or conversations in the current page. Use **Load earlier signals** for older messages.

Morse display and audio include only letters A-Z and numbers 0-9. Punctuation and symbols are skipped in text messages' signals. **Show text** displays the original typed text, including case, punctuation, spacing, and new lines, or the decoded letters and numbers for a Morse message. Accented letters use their plain equivalents in Morse, while the original text stays unchanged. Each message needs at least one letter or number. An info note beside the message box explains this. Message boxes reserve room for the text so revealing it keeps the controls in place. Messages are stored with their readable text to support reveal and audio; Morse does not encrypt them.

For the live site, follow [Chat setup](docs/CHAT_SETUP.md). It covers the Pages build settings, D1 migration/binding, the exact Google callback URL, and private environment settings. `npm start` keeps serving the local trainer without a chat backend. For local Pages/D1 development, use `npm install`, `npm run db:local`, and `npm run dev:chat` as described in the guide.

The Pages build gives each release new JavaScript and stylesheet filenames, including every imported module. A normal browser refresh loads the current release even when older files are cached. Saved lessons, sound settings, and theme preferences remain in place.

## Keyboard

| Shortcut | Action |
| --- | --- |
| Enter | Check a Learn answer; the next signal or retry plays automatically |
| Alt + R | Replay the current Learn signal |
| Alt + P | Pause or resume Practice |
| Ctrl + Enter / Cmd + Enter | Submit a finished Practice run |
| Letter / number key outside a typing field | Play that character in Practice |

## Run the tests

From the project folder, run:

```sh
npm test
```

On Windows PowerShell, use `npm.cmd test` if scripts are blocked. Tests cover Morse mappings, Farnsworth timing, audio preparation and playback controls, all 18 lessons, incorrect-answer retries, shuffled custom rounds, word groups, answer alignment, chat encoding, sign-in validation, and conversation permissions.
