# Morse Room

A receiving-only Morse code trainer that runs on your own computer in a browser. Learn letters and numbers, or practise with random characters and custom groups. No account is needed.

## Requirements

- **Node.js 22 or newer:** install it from the [official Node.js download page](https://nodejs.org/en/download). The installer includes npm.
- **Windows, macOS, or Linux**, with a modern browser that supports Web Audio, such as Chrome, Edge, Firefox, or Safari.
- **Git** is needed only if you choose the clone method below.

The app has zero external dependencies. You do **not** need to run `npm install`. After downloading the app and installing Node.js, it works offline.

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

Select **Start lesson** to hear each new character with its Morse pattern. Replay as often as you like, then move to the next character. After both characters, choose **Replay lesson** or **Start practice**.

Each level practises every character learned so far exactly five times in shuffled order. Level 4 uses `ETANIMSO` for 40 signals; level 18 uses all 36 letters and numbers for 180 signals. A visible **5, 4, 3, 2, 1** countdown runs before the first practice signal.

Type one character in the left column and press **Enter**. A green tick or red cross marks your answer; the right column shows the correct character and its Morse pattern. A correct answer plays the next signal automatically. A wrong answer repeats the same signal until you answer correctly. Complete every signal correctly to unlock the next level.

Use **Replay** beside the typing box to hear the current signal again. Click a revealed answer in the right column to hear that character without changing your progress.

## Practice

- **Random:** practise all letters and numbers, letters only, or numbers only.
- **Custom:** choose a character pool, such as `Q Y F L`.
- **Continuous:** keep receiving until you stop.
- **Character count:** receive a fixed number, such as 10 or 100.
- **Random word groups:** set the number of words and letters per word. For example, 50 words of five letters plays 250 random characters with proper word gaps. Spaces are added automatically as you type each group.

Type continuously in the left column. Spaces and letter case do not affect checking. Answers stay hidden during playback and while paused. **Pause** and **Resume** preserve your place, including during the countdown.

After a finite run ends, press **Submit copy** when you finish typing. **Stop & check** ends a run and reveals results immediately. Only fully played characters are checked. The right column shows their Morse patterns and lets you replay them. Missing or extra characters are aligned so a single omission does not turn later correct answers into errors.

## Sound and saved progress

Adjust character speed from 5 to 60 WPM, Farnsworth speed from 1 WPM up to character speed, frequency from 200 to 1,200 Hz, and volume from 0 to 100%. Farnsworth increases the gaps between characters and words while keeping the selected character speed. Changes during a session apply to the next character. Use **Test your sound** before starting.

Completed levels and sound settings are stored in this browser's `localStorage`. They stay on your computer. Use the same browser and address to keep your progress when you update the app. Clearing site data or using another browser gives you a separate saved history.

## Keyboard

| Shortcut | Action |
| --- | --- |
| Enter | Check a Learn answer; the next signal or retry plays automatically |
| Alt + R | Replay the current Learn signal |
| Alt + P | Pause or resume Practice |
| Ctrl + Enter / Cmd + Enter | Submit a finished Practice run |

## Run the tests

From the project folder, run:

```sh
npm test
```

On Windows PowerShell, use `npm.cmd test` if scripts are blocked. Tests cover Morse mappings, Farnsworth timing, audio preparation and playback controls, all 18 lessons, incorrect-answer retries, custom sequences, word groups, and answer alignment.
