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

function mockAudio() {
  const events = [];
  class Parameter {
    value = 0;
    setValueAtTime(value, time) {
      this.value = value;
      events.push(['set', value, time]);
    }
    linearRampToValueAtTime(value, time) {
      this.value = value;
      events.push(['ramp', value, time]);
    }
    cancelAndHoldAtTime(time) { events.push(['hold', time]); }
  }
  class Context {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    resume() {
      events.push(['resume']);
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      events.push(['oscillator']);
      return {
        frequency: new Parameter(),
        connect() {},
        disconnect() {},
        start(time) { events.push(['start', time]); },
        stop(time) { events.push(['stop', time]); },
      };
    }
    createGain() {
      return { gain: new Parameter(), connect() {}, disconnect() {} };
    }
  }
  return { Context, events };
}

test('preparing audio unlocks its context without playing a tone or changing the signal', async () => {
  const original = globalThis.AudioContext;
  const { Context, events } = mockAudio();
  globalThis.AudioContext = Context;
  try {
    const signals = [];
    const player = new MorsePlayer({ onSignal: (signal) => signals.push(signal) });
    assert.deepEqual(events, []);
    const prepared = player.prepare();
    assert.deepEqual(events, [['resume']]);
    assert.equal(player.isPlaying, false);
    await prepared;
    assert.deepEqual(signals, []);
    assert.deepEqual(events, [['resume']]);
    await player.prepare();
    assert.deepEqual(events, [['resume']]);
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
});

test('preparing and preparing again leave a countdown wait active', async () => {
  const original = globalThis.AudioContext;
  const { Context, events } = mockAudio();
  globalThis.AudioContext = Context;
  try {
    const player = new MorsePlayer();
    const countdown = player.wait(0.04);
    await player.prepare();
    assert.equal(player.isPlaying, true);
    await player.prepare();
    assert.equal(player.isPlaying, true);
    assert.equal(await countdown, true);
    assert.deepEqual(events, [['resume']]);
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
});

test('preparing reports missing Web Audio without cancelling an existing wait', async () => {
  const original = globalThis.AudioContext;
  const originalLegacy = globalThis.webkitAudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    const player = new MorsePlayer();
    const countdown = player.wait(0.01);
    await assert.rejects(player.prepare(), /browser with Web Audio support/);
    assert.equal(player.isPlaying, true);
    assert.equal(await countdown, true);
  } finally {
    if (original !== undefined) globalThis.AudioContext = original;
    if (originalLegacy !== undefined) globalThis.webkitAudioContext = originalLegacy;
  }
});

test('audio starts lazily, resumes within the call, and can stop during a mark', async () => {
  const original = globalThis.AudioContext;
  const { Context, events } = mockAudio();
  globalThis.AudioContext = Context;
  try {
    const signals = [];
    const player = new MorsePlayer({ onSignal: (signal) => signals.push(signal) });
    assert.deepEqual(events, []);
    const playback = player.playCharacter('T', { wpm: 20, frequency: 725, volume: 40 });
    assert.deepEqual(events, [['resume']]);
    await Promise.resolve();
    assert.deepEqual(signals, [true]);
    assert.ok(events.some(([name, value]) => name === 'set' && value === 725));
    assert.ok(events.some(([name, value]) => name === 'ramp' && value === 0.4));
    assert.equal(player.stop(), true);
    assert.equal(await playback, false);
    assert.deepEqual(signals, [true, false]);
    assert.ok(events.some(([name]) => name === 'hold'));
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
});

test('pausing a mark switches the signal off and resumes the same character', async () => {
  const original = globalThis.AudioContext;
  const { Context, events } = mockAudio();
  globalThis.AudioContext = Context;
  try {
    const signals = [];
    const player = new MorsePlayer({ onSignal: (signal) => signals.push(signal) });
    const playback = player.playCharacter('T', { wpm: 30 });
    await sleep(30);
    player.pause();
    assert.deepEqual(signals, [true, false]);
    await sleep(150);
    assert.equal(player.isPlaying, true);
    player.resume();
    assert.equal(await playback, true);
    assert.deepEqual(signals, [true, false, true, false]);
    assert.equal(events.filter(([name]) => name === 'oscillator').length, 2);
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
});
