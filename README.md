# Morse Room

A Morse code receiving trainer with free lessons and unlimited practice. Run it on your own computer, or visit [The Morse Room](https://learnmorse.lelinadhikari.com.np). Learn and Practice need no account. The optional Morse Chat Room uses Google sign-in to practise through conversations with friends.

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

Each level practises every character learned so far exactly five times in shuffled order. Level 4 uses `ETANIMSO` for 40 signals; level 18 uses all 36 letters and numbers for 180 signals. A visible **5, 4, 3, 2, 1** countdown runs before the first practice signal.

Type one character in the left column and press **Enter**. A green tick or red cross marks your answer; the right column shows the correct character and its Morse pattern. A correct answer plays the next signal automatically. A wrong answer repeats the same signal until you answer correctly. Complete every signal correctly to unlock the next level.

Use **Replay** beside the typing box to hear the current signal again. Click a revealed answer in the right column to hear that character without changing your progress.

Answer feedback, scores, and level completion messages appear centered below both columns.

## Practice

- **Random:** practise all letters and numbers, letters only, or numbers only.
- **Custom:** choose a character pool, such as `Q Y F L`. Each shuffled round plays every selected character once. The same character cannot occur twice in a row across rounds, unless you selected only one character.
- **Continuous:** keep receiving until you stop.
- **Character count:** receive a fixed number, such as 10 or 100.
- **Random word groups:** set the number of words and letters per word. For example, 50 words of five letters plays 250 random characters with proper word gaps. Spaces are added automatically as you type each group.

The **Characters** reference stays open in both Random and Custom practice, showing all letters and numbers with their Morse patterns. Click a character to hear a sample, or press its letter/number key while outside a typing field. A keyboard sample pauses a running test; **Resume** continues from its saved point. Typing in the answer box, custom selection, or settings does not play samples. These samples leave your custom selection and received count unchanged; type your chosen pool in the selection box.

Type continuously in the left column. Spaces and letter case do not affect checking. Answers stay hidden during playback and while paused. **Pause** and **Resume** preserve your place, including during the countdown.

The **Session audio** bar sits above the playback controls. Drag its slider to replay any received audio, including after a test finishes. Rewinding pauses the test; **Resume** continues from the saved point. Use **Pause replay** or **Resume replay** to control the replay separately. Replaying audio never adds characters to your answer key or changes your score.

After a finite run ends, press **Submit copy** when you finish typing. **Stop & check** ends a run and reveals results immediately. Only fully played characters are checked. The right column shows their Morse patterns and lets you replay them. Missing or extra characters are aligned so a single omission does not turn later correct answers into errors.

## Sound and saved progress

Adjust character speed from 5 to 60 WPM, Farnsworth speed from 1 WPM up to character speed, frequency from 200 to 1,200 Hz, and volume from 0 to 100%. Farnsworth increases the gaps between characters and words while keeping the selected character speed. Changes during a session apply to the next character. Use **Test your sound** before starting.

Timing follows the [standard PARIS calculation](https://morsecode.world/international/timing/) and [Farnsworth calculation](https://morsecode.world/international/timing/farnsworth.html). With character speed `C` and Farnsworth speed `F`, all durations below are in seconds:

- Dit: `1.2 / C`; dah: three dits; silence within a character: one dit.
- Farnsworth spacing unit: `(60 / F - 31 * dit) / 19`.
- Character gap: three spacing units; word gap: seven spacing units.

At 20 WPM with 10 WPM Farnsworth, a dit lasts 60 ms, a dah 180 ms, a character gap about 654 ms, and a word gap about 1,525 ms. Equal character and Farnsworth speeds give standard Morse spacing. Learn pauses for your answer, so its overall session speed also depends on how quickly you type.

Morse marks are scheduled on the browser's audio clock. A silent preparation period lets the audio start before the first mark, and continuous practice keeps its configured gaps between characters and words.

Use the **sun/moon switch** at the top right to change between the light theme and a black theme with bright green text and controls. The first visit follows your device's theme; your choice is saved for later visits.

Completed levels, sound settings, and your theme choice are stored in this browser's `localStorage`. They stay on your computer. Use the same browser and address to keep your progress when you update the app. Clearing site data or using another browser gives you a separate saved history.

## Morse Chat Room

Choose **Morse Chat Room** below Practice in the sidebar. Use the account icon at the top right to sign in with Google, then choose a unique username. Your username, profile settings, and Sign out stay in that account menu across all tabs. Sign-in applies only to Chat.

- **Friends:** send a request using an exact username or registered email. The recipient accepts or declines from the top-right notification bell. An accepted request opens a conversation for both people.
- **Private groups:** create a named group and copy its invite code or link. Join using either. An invite link is kept through sign-in and username setup. Anyone with an invite can join and read the group history.
- **Messages:** type ordinary text and send it as international Morse. Each message has **Show text** and **Listen** controls. Words stay hidden until revealed, and audio plays only when requested.
- **Sound:** **Default** keeps chat at 18 WPM, 12 WPM Farnsworth, and 600 Hz. **Custom** enables the speed and frequency controls in the sidebar. Chat settings are saved separately from Learn and Practice; volume is shared. Listen changes to **Stop audio** during playback.
- **Notifications:** the bell shows incoming friend requests and unread signals. An open conversation checks for messages every five seconds while the page is visible. The inbox checks every 30 seconds in Chat, every minute in Learn or Practice, and when you open the bell. Hidden tabs stop checking.
- **Typing:** select **Send text** to write ordinary text, or **Send Morse code** to enter the signal yourself. In Morse mode, Left Arrow enters a dit (`.`), Right Arrow enters a dah (`-`), Space separates letters (`/`), and two spaces separate words (`//`). Each dit and dah plays as you type. Touch buttons provide the same controls. Use Backspace to correct and Enter to send. Morse groups must be valid letters or numbers; Show text decodes them.
- **Drafts:** text and Morse drafts are kept separately while switching modes or conversations in the current page. In text mode, Shift + Enter adds a new line. Use **Load earlier signals** for older messages.

Morse display and audio include only letters A-Z and numbers 0-9. Punctuation and symbols are skipped in text messages' signals. **Show text** displays the original typed text, including case, punctuation, spacing, and new lines, or the decoded letters and numbers for a Morse message. Accented letters use their plain equivalents in Morse, while the original text stays unchanged. Each message needs at least one letter or number. An info note beside the message box explains this. Message boxes reserve room for the text so revealing it keeps the controls in place. Messages are stored with their readable text to support reveal and audio; Morse does not encrypt them.

For the live site, follow [Chat setup](docs/CHAT_SETUP.md). It covers the Pages build settings, D1 migration/binding, the exact Google callback URL, and private environment settings. `npm start` keeps serving the local trainer without a chat backend. For local Pages/D1 development, use `npm install`, `npm run db:local`, and `npm run dev:chat` as described in the guide.

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
