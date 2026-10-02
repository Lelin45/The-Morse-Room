import test from 'node:test';
import assert from 'node:assert/strict';
import { MORSE, getTiming, buildCharacterSegments, MorsePlayer } from '../audio.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const close = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`,
);

test('the receiving alphabet includes all 26 letters and ten digits', () => {
  assert.equal(Object.keys(MORSE).length, 36);
  assert.equal(MORSE.Q, '--.-');
  assert.equal(MORSE.Y, '-.--');
  assert.equal(MORSE[0], '-----');
  assert.equal(MORSE[5], '.....');
  assert.ok(Object.isFrozen(MORSE));
});

test('normal timing follows the 50-unit PARIS word', () => {
  const timing = getTiming({ wpm: 20, farnsworth: 20 });
  close(timing.dit, 0.06);
  close(timing.dah, 0.18);
  close(timing.characterGap, 0.18);
  close(timing.wordGap, 0.42);
  close(31 * timing.dit + 4 * timing.characterGap + timing.wordGap, 3);
});

test('Farnsworth retains character speed and extends only inter-character spaces', () => {
  const normal = getTiming({ wpm: 20, farnsworth: 20 });
  const slower = getTiming({ wpm: 20, farnsworth: 8 });
  close(slower.dit, normal.dit);
  assert.ok(slower.characterGap > normal.characterGap);
  close(31 * slower.dit + 4 * slower.characterGap + slower.wordGap, 60 / 8);
  close(slower.wordGap / slower.characterGap, 7 / 3);
  assert.deepEqual(getTiming({ wpm: 20, farnsworth: 40 }), normal);
});

test('a character has correctly timed marks without an extra final gap', () => {
  const segments = buildCharacterSegments(' a ', { wpm: 20, farnsworth: 8 });
  assert.deepEqual(segments, [
    { tone: true, duration: 0.06 },
    { tone: false, duration: 0.06 },
    { tone: true, duration: 0.18 },
  ]);
  assert.equal(buildCharacterSegments('0').length, 9);
  assert.throws(() => buildCharacterSegments('?'), /Unsupported Morse character/);
});

test('silent spacing can pause and stop without creating an audio context', async () => {
  const player = new MorsePlayer();
  const spacing = player.wait(0.08);
  await sleep(20);
  assert.equal(player.pause(), true);
  assert.equal(player.isPaused, true);
  assert.equal(player.isPlaying, true);
  let settled = false;
  spacing.then(() => { settled = true; });
  await sleep(100);
  assert.equal(settled, false);
  assert.equal(player.stop(), true);
  assert.equal(await spacing, false);
  assert.equal(player.isPlaying, false);
  assert.equal(player.isPaused, false);
});

test('resuming a gap plays its remaining time rather than its full duration', async () => {
  const player = new MorsePlayer();
  const spacing = player.wait(0.2);
  await sleep(110);
  player.pause();
  await sleep(30);
  const resumedAt = performance.now();
  player.resume();
  assert.equal(await spacing, true);
  const resumedDuration = performance.now() - resumedAt;
  assert.ok(resumedDuration >= 40, `remaining gap was only ${resumedDuration} ms`);
  assert.ok(resumedDuration < 160, `the gap restarted for ${resumedDuration} ms`);
});

test('starting a new operation cancels the prior pending operation', async () => {
  const player = new MorsePlayer();
  const first = player.wait(10);
  const second = player.wait(0);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(player.isPlaying, false);
  await assert.rejects(player.wait(-1), /nonnegative/);
});


function mockAudio({ manual = false, delayedResume = false, holdInitialClock = false, failToneScheduling = false } = {}) {
  const events = [];
  const contexts = [];
  class Parameter {
    constructor(name) { this.name = name; this.value = 0; }
    setValueAtTime(value, time) { this.value = value; events.push({ parameter: this.name, type: 'set', value, time }); }
    linearRampToValueAtTime(value, time) {
      if (failToneScheduling && this.name === 'gain' && value > 0) throw new Error('Scheduling failed');
      this.value = value;
      events.push({ parameter: this.name, type: 'ramp', value, time });
    }
    cancelScheduledValues(time) { events.push({ parameter: this.name, type: 'cancel', time }); }
    cancelAndHoldAtTime(time) { events.push({ parameter: this.name, type: 'hold', time }); }
  }
  class Context {
    constructor() {
      this.state = 'suspended';
      this.time = 0;
      this.startedAt = performance.now();
      this.destination = {};
      contexts.push(this);
    }
    get currentTime() {
      // A first real render quantum unlocks preparation, then the clock is
      // controlled explicitly so tests can freeze it during scheduled sound.
      if (manual && !holdInitialClock && this.state === 'running'
          && this.time === 0 && performance.now() - this.startedAt >= 10) this.time = 0.01;
      return this.time + (!manual && this.state === 'running' ? (performance.now() - this.startedAt) / 1000 : 0);
    }
    resume() {
      events.push({ type: 'resume' });
      const finish = () => { this.state = 'running'; this.startedAt = performance.now(); };
      if (!delayedResume) { finish(); return Promise.resolve(); }
      return new Promise((resolve) => { this.finishResume = () => { finish(); resolve(); }; });
    }
    createOscillator() {
      events.push({ type: 'oscillator' });
      return {
        frequency: new Parameter('frequency'), connect() {}, disconnect() {},
        start(time) { events.push({ type: 'start', time }); },
        stop(time) { events.push({ type: 'stop', time }); },
      };
    }
    createGain() { return { gain: new Parameter('gain'), connect() {}, disconnect() {} }; }
  }
  return { Context, events, contexts };
}

async function withAudio(options, callback) {
  const original = globalThis.AudioContext;
  const audio = mockAudio(options);
  globalThis.AudioContext = audio.Context;
  try { await callback(audio); }
  finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
}

function scheduledMarks(events) {
  const gain = events.filter((event) => event.parameter === 'gain');
  const marks = [];
  for (const [index, event] of gain.entries()) {
    if (event.type !== 'ramp' || event.value <= 0) continue;
    const end = gain.slice(index + 1).find((next) => next.type === 'ramp' && next.value === 0);
    if (end) marks.push({ start: event.time - 0.004, end: end.time, duration: end.time - event.time + 0.004 });
  }
  return marks;
}

test('prepare starts a silent persistent carrier and resumes within the gesture', async () => {
  await withAudio({}, async ({ events }) => {
    const signals = [];
    const player = new MorsePlayer({ onSignal: (signal) => signals.push(signal) });
    assert.deepEqual(events, []);
    const preparing = player.prepare();
    assert.ok(events.some((event) => event.type === 'resume'));
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(player.isPlaying, false);
    await preparing;
    assert.deepEqual(signals, []);
    assert.equal(scheduledMarks(events).length, 0);
    assert.ok(events.some((event) => event.parameter === 'gain' && event.type === 'set' && event.value === 0));
    await player.prepare();
    assert.equal(events.filter((event) => event.type === 'oscillator').length, 1);
    assert.equal(events.filter((event) => event.type === 'resume').length, 1);
  });
});

test('prepare can be recalled while a countdown wait remains active', async () => {
  await withAudio({}, async () => {
    const player = new MorsePlayer();
    const countdown = player.wait(0.04);
    await player.prepare();
    assert.equal(player.isPlaying, true);
    await player.prepare();
    assert.equal(await countdown, true);
  });
});

test('prepare waits for initial audio-clock progress before declaring output ready', async () => {
  await withAudio({ manual: true, holdInitialClock: true }, async ({ contexts }) => {
    const player = new MorsePlayer();
    let ready = false;
    const preparing = player.prepare().then(() => { ready = true; });
    await sleep(30);
    assert.equal(ready, false);
    contexts[0].time = 0.01;
    await preparing;
    assert.equal(ready, true);
  });
});

test('missing Web Audio gives a helpful error without cancelling an existing wait', async () => {
  const original = globalThis.AudioContext;
  const originalLegacy = globalThis.webkitAudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    const player = new MorsePlayer();
    const countdown = player.wait(0.02);
    await assert.rejects(player.prepare(), /browser with Web Audio support/);
    assert.equal(player.isPlaying, true);
    assert.equal(await countdown, true);
  } finally {
    if (original !== undefined) globalThis.AudioContext = original;
    if (originalLegacy !== undefined) globalThis.webkitAudioContext = originalLegacy;
  }
});

test('cold Q schedules all four complete marks and exact intra-character gaps upfront', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const signals = [];
    const player = new MorsePlayer({ onSignal: (signal) => signals.push(signal) });
    const playback = player.playCharacter('Q', { wpm: 20, frequency: 725, volume: 40 });
    assert.ok(events.some((event) => event.type === 'resume'));
    await sleep(25);
    const marks = scheduledMarks(events);
    assert.equal(marks.length, 4);
    assert.ok(marks[0].start >= contexts[0].currentTime + 0.049);
    [0.18, 0.18, 0.06, 0.18].forEach((duration, index) => close(marks[index].duration, duration));
    for (let index = 1; index < marks.length; index += 1) close(marks[index].start - marks[index - 1].end, 0.06);
    assert.ok(events.some((event) => event.parameter === 'frequency' && event.value === 725));
    assert.ok(events.some((event) => event.parameter === 'gain' && event.type === 'ramp' && event.value === 0.4));
    assert.deepEqual(signals, []);
    assert.equal(events.filter((event) => event.type === 'oscillator').length, 1);
    assert.equal(player.stop(), true);
    assert.equal(await playback, false);
    assert.ok(events.some((event) => event.parameter === 'gain' && event.type === 'hold'));
    assert.equal(events.filter((event) => event.type === 'stop').length, 0);
  });
});

test('a cold direct Q waits for the first render-clock tick before scheduling every mark', async () => {
  await withAudio({ manual: true, holdInitialClock: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('Q', { wpm: 20 });
    await sleep(30);
    assert.equal(scheduledMarks(events).length, 0);
    assert.equal(player.isPlaying, true);
    contexts[0].time = 0.01;
    await sleep(25);
    const marks = scheduledMarks(events);
    assert.equal(marks.length, 4);
    close(marks[0].start, 0.06);
    player.stop();
    assert.equal(await playback, false);
  });
});

test('a frozen initial audio clock cannot finish or truncate Q through wall timers', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    let completed = false;
    const playback = player.playCharacter('Q', { wpm: 20 }).then((result) => { completed = result; return result; });
    await sleep(25);
    const scheduled = events.filter((event) => event.parameter === 'gain').length;
    await sleep(300);
    assert.equal(completed, false);
    assert.equal(player.isPlaying, true);
    assert.equal(events.filter((event) => event.parameter === 'gain').length, scheduled);
    assert.equal(scheduledMarks(events).length, 4);
    contexts[0].time = 0.7;
    await sleep(60);
    assert.equal(completed, false);
    contexts[0].time = 1;
    assert.equal(await playback, true);
  });
});

test('an event-loop stall does not create, skip, or reschedule native Q marks', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('Q', { wpm: 20 });
    await sleep(25);
    const before = events.filter((event) => event.parameter === 'gain');
    const blockedUntil = performance.now() + 100;
    while (performance.now() < blockedUntil) {}
    contexts[0].time = 0.7;
    await sleep(0);
    assert.deepEqual(events.filter((event) => event.parameter === 'gain'), before);
    contexts[0].time = 1;
    assert.equal(await playback, true);
    assert.deepEqual(events.filter((event) => event.parameter === 'gain'), before);
  });
});

test('pause cancels scheduled Q and resume preserves remaining first dah and every later mark', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('Q', { wpm: 20 });
    await sleep(25);
    contexts[0].time = scheduledMarks(events)[0].start + 0.07;
    assert.equal(player.pause(), true);
    const pauseEvents = events.length;
    assert.ok(events.some((event) => event.parameter === 'gain' && event.type === 'hold' && event.time === contexts[0].time));
    contexts[0].time = 2;
    await sleep(60);
    assert.equal(player.isPlaying, true);
    assert.equal(player.isPaused, true);
    assert.equal(events.length, pauseEvents);
    player.resume();
    await sleep(0);
    const resumedMarks = scheduledMarks(events.slice(pauseEvents));
    assert.equal(resumedMarks.length, 4);
    [0.11, 0.18, 0.06, 0.18].forEach((duration, index) => close(resumedMarks[index].duration, duration));
    contexts[0].time = 3;
    assert.equal(await playback, true);
    assert.equal(events.filter((event) => event.type === 'oscillator').length, 1);
  });
});

test('pausing before the first mark retains its remaining lead and the complete character', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('Q', { wpm: 20 });
    await sleep(25);
    const originalMarks = scheduledMarks(events);
    contexts[0].time = originalMarks[0].start - 0.03;
    player.pause();
    const pausedAt = events.length;
    contexts[0].time = 2;
    player.resume();
    await sleep(0);
    const resumed = scheduledMarks(events.slice(pausedAt));
    assert.equal(resumed.length, 4);
    close(resumed[0].start, 2.03);
    [0.18, 0.18, 0.06, 0.18].forEach((duration, index) => close(resumed[index].duration, duration));
    contexts[0].time = 3;
    assert.equal(await playback, true);
  });
});

test('pausing inside an intra-character gap preserves the exact remainder of that gap', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('A', { wpm: 20 });
    await sleep(25);
    contexts[0].time = scheduledMarks(events)[0].end + 0.02;
    player.pause();
    const pauseEvents = events.length;
    contexts[0].time = 1;
    player.resume();
    await sleep(0);
    const marks = scheduledMarks(events.slice(pauseEvents));
    assert.equal(marks.length, 1);
    close(marks[0].start - 1.05, 0.04);
    close(marks[0].duration, 0.18);
    contexts[0].time = 2;
    assert.equal(await playback, true);
  });
});

test('stop during initial context resume prevents stale scheduling and resolves false immediately', async () => {
  await withAudio({ manual: true, delayedResume: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const playback = player.playCharacter('Q');
    player.stop();
    assert.equal(await playback, false);
    contexts[0].finishResume();
    await sleep(0);
    assert.equal(scheduledMarks(events).length, 0);
    assert.equal(player.isPlaying, false);
  });
});

test('a scheduling error rejects playback and leaves no pending operation', async () => {
  await withAudio({ failToneScheduling: true }, async () => {
    const player = new MorsePlayer();
    await assert.rejects(player.playCharacter('Q'), /Scheduling failed/);
    assert.equal(player.isPlaying, false);
    assert.equal(player.isPaused, false);
  });
});

test('continuous character gaps use the configured deadline without adding a scheduling lead', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const first = player.playCharacter('E', { wpm: 20 });
    await sleep(25);
    const firstMark = scheduledMarks(events)[0];
    contexts[0].time = firstMark.end + 0.01;
    assert.equal(await first, true);
    const timing = getTiming({ wpm: 20, farnsworth: 10 });
    const gap = player.gap(timing.characterGap);
    contexts[0].time = firstMark.end + timing.characterGap - 0.04;
    assert.equal(await gap, true);
    const second = player.playCharacter('T', { wpm: 20 });
    await sleep(0);
    const secondMark = scheduledMarks(events)[1];
    close(secondMark.start - firstMark.end, timing.characterGap);
    contexts[0].time = secondMark.end + 0.01;
    assert.equal(await second, true);
  });
});

test('pausing a continuous gap preserves its remaining duration and next exact start', async () => {
  await withAudio({ manual: true }, async ({ events, contexts }) => {
    const player = new MorsePlayer();
    const first = player.playCharacter('E', { wpm: 20 });
    await sleep(25);
    const firstEnd = scheduledMarks(events)[0].end;
    contexts[0].time = firstEnd + 0.01;
    assert.equal(await first, true);
    const gap = player.gap(0.5);
    contexts[0].time = firstEnd + 0.19;
    player.pause();
    contexts[0].time = 2;
    player.resume();
    contexts[0].time = 2.28;
    assert.equal(await gap, true);
    const next = player.playCharacter('E', { wpm: 20 });
    await sleep(0);
    const mark = scheduledMarks(events).at(-1);
    close(mark.start, 2.31);
    contexts[0].time = 3;
    assert.equal(await next, true);
  });
});
