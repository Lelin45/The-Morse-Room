import test from 'node:test';
import assert from 'node:assert/strict';
import { PracticeRecording, ReplayPlayer } from '../replay.js';
import { getTiming } from '../audio.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${actual} differs from ${expected}`);

function mockAudio({ delayedResume = false } = {}) {
  const events = [];
  const contexts = [];
  class Parameter {
    constructor(name) { this.name = name; this.value = 0; }
    setValueAtTime(value, time) { this.value = value; events.push({ name: this.name, type: 'set', value, time }); }
    linearRampToValueAtTime(value, time) { this.value = value; events.push({ name: this.name, type: 'ramp', value, time }); }
    cancelScheduledValues(time) { events.push({ name: this.name, type: 'cancel', time }); }
    cancelAndHoldAtTime(time) { events.push({ name: this.name, type: 'hold', time }); }
  }
  class Context {
    constructor() {
      this.state = 'suspended';
      this.time = 0;
      this.resumedAt = null;
      this.destination = {};
      contexts.push(this);
    }
    get currentTime() {
      // Advance one initial quantum for preparation, then tests control time.
      if (!this.time && this.resumedAt !== null && performance.now() - this.resumedAt >= 10) this.time = 0.01;
      return this.time;
    }
    resume() {
      events.push({ type: 'resume' });
      const finish = () => { this.state = 'running'; this.resumedAt = performance.now(); };
      if (!delayedResume) { finish(); return Promise.resolve(); }
      return new Promise((resolve) => { this.finishResume = () => { finish(); resolve(); }; });
    }
    createOscillator() {
      events.push({ type: 'oscillator' });
      return {
        frequency: new Parameter('frequency'), connect() {},
        start(time) { events.push({ type: 'start', time }); },
      };
    }
    createGain() { return { gain: new Parameter('gain'), connect() {} }; }
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

function marks(events) {
  const gain = events.filter((event) => event.name === 'gain');
  return gain.flatMap((event, index) => {
    if (event.type !== 'ramp' || event.value <= 0) return [];
    const end = gain.slice(index + 1).find((next) => next.type === 'ramp' && next.value === 0);
    return end ? [{ start: event.time - 0.004, end: end.time, duration: end.time - event.time + 0.004 }] : [];
  });
}

test('recording preserves timing snapshots when speed and Farnsworth change', () => {
  const recording = new PracticeRecording();
  const settings = { wpm: 20, farnsworth: 10, frequency: 650, volume: 35 };
  const first = recording.appendCharacter('q', settings);
  const gap = getTiming(settings).characterGap;
  recording.appendGap(gap);
  settings.wpm = 40;
  settings.farnsworth = 20;
  const second = recording.appendCharacter('Q', settings);
  close(first.duration, 0.78);
  close(second.duration, 0.39);
  close(second.start - first.end, gap);
  close(recording.duration, 0.78 + gap + 0.39);
  assert.equal(recording.characterCount, 2);
  assert.equal(first.settings.wpm, 20);
  close(first.settings.farnsworth, 10);
  assert.equal(second.settings.wpm, 40);
  assert.ok(Object.isFrozen(first.settings));
  assert.equal(recording.timeline, recording.segments);
  assert.equal(recording.segments.filter((segment) => segment.tone).length, 8);
});

test('recording rejects invalid input without partial entries and clear resets the same arrays', () => {
  const recording = new PracticeRecording();
  assert.throws(() => recording.appendCharacter('?'), /Unsupported/);
  assert.throws(() => recording.appendGap(-1), /nonnegative/);
  assert.throws(() => recording.appendGap(Infinity), /finite/);
  assert.equal(recording.duration, 0);
  assert.equal(recording.appendGap(0), null);
  recording.appendCharacter('A');
  const segments = recording.segments;
  const characters = recording.characters;
  recording.clear();
  assert.equal(recording.duration, 0);
  assert.equal(recording.characterCount, 0);
  assert.equal(recording.segments, segments);
  assert.equal(recording.characters, characters);
  assert.deepEqual(segments, []);
});

test('seeking inside a dah schedules only its remaining duration with current tone controls', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('T', { wpm: 20, frequency: 400, volume: 80 });
    const positions = [];
    const player = new ReplayPlayer(recording, { onProgress: (position) => positions.push(position) });
    const replay = player.play(0.06, { frequency: 725, volume: 40 });
    assert.ok(events.some((event) => event.type === 'resume'));
    assert.equal(positions.at(-1), 0.06);
    await sleep(25);
    const tone = marks(events)[0];
    close(tone.start, 0.06);
    close(tone.duration, 0.12);
    assert.ok(events.some((event) => event.name === 'frequency' && event.value === 725));
    assert.ok(events.some((event) => event.name === 'gain' && event.type === 'ramp' && event.value === 0.4));
    contexts[0].time = 0.4;
    assert.equal(await replay, true);
    close(player.position, 0.18);
  });
});

test('seeking inside a recorded gap leaves its remaining silence before the next mark', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('E', { wpm: 20 });
    recording.appendGap(0.4);
    recording.appendCharacter('T', { wpm: 20 });
    const player = new ReplayPlayer(recording);
    const replay = player.play(0.2);
    await sleep(25);
    const tones = marks(events);
    assert.equal(tones.length, 1);
    close(tones[0].start - 0.06, 0.26);
    close(tones[0].duration, 0.18);
    contexts[0].time = 1;
    assert.equal(await replay, true);
  });
});

test('pause retains the audio-clock position and resume continues the remaining mark', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q', { wpm: 20 });
    const positions = [];
    let ended = 0;
    const player = new ReplayPlayer(recording, {
      onProgress: (position) => positions.push(position), onEnded: () => { ended += 1; },
    });
    const replay = player.play(0);
    await sleep(25);
    contexts[0].time = 0.15;
    player.pause();
    close(player.position, 0.09);
    close(positions.at(-1), 0.09);
    assert.equal(player.isPlaying, false);
    assert.equal(player.isPaused, true);
    const pauseEvents = events.length;
    contexts[0].time = 3;
    await sleep(30);
    close(player.position, 0.09);
    assert.equal(events.length, pauseEvents);
    player.resume();
    await sleep(0);
    const resumed = marks(events.slice(pauseEvents));
    close(resumed[0].duration, 0.09);
    contexts[0].time = 4;
    assert.equal(await replay, true);
    assert.equal(ended, 1);
    assert.equal(events.filter((event) => event.type === 'oscillator').length, 1);
  });
});

test('stop cancels future envelopes, keeps position, and does not fire onEnded', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q');
    let ended = 0;
    const positions = [];
    const player = new ReplayPlayer(recording, {
      onEnded: () => { ended += 1; }, onProgress: (position) => positions.push(position),
    });
    const replay = player.play(0);
    await sleep(25);
    contexts[0].time = 0.2;
    player.stop();
    assert.equal(await replay, false);
    close(player.position, 0.14);
    close(positions.at(-1), 0.14);
    assert.equal(ended, 0);
    assert.ok(events.some((event) => event.name === 'gain' && event.type === 'hold'));
    assert.ok(events.some((event) => event.name === 'frequency' && event.type === 'cancel'));
    assert.equal(player.isPlaying, false);
  });
});

test('seeking replaces the old replay and publishes its new position immediately', async () => {
  await withAudio({}, async () => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q');
    const positions = [];
    const player = new ReplayPlayer(recording, { onProgress: (position) => positions.push(position) });
    const first = player.play(0);
    await sleep(25);
    const second = player.seek(0.5);
    assert.equal(await first, false);
    close(positions.at(-1), 0.5);
    close(player.position, 0.5);
    player.stop();
    assert.equal(await second, false);
  });
});

test('wall timers cannot finish replay while the prepared audio clock is frozen', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q');
    const player = new ReplayPlayer(recording);
    let completed = false;
    const replay = player.play(0).then((result) => { completed = result; return result; });
    await sleep(25);
    const scheduled = events.filter((event) => event.name === 'gain');
    await sleep(150);
    assert.equal(completed, false);
    assert.equal(player.isPlaying, true);
    close(player.position, 0);
    assert.deepEqual(events.filter((event) => event.name === 'gain'), scheduled);
    contexts[0].time = 1;
    assert.equal(await replay, true);
  });
});

test('a 600 ms page stall leaves all already scheduled mark timings intact', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    for (let index = 0; index < 10; index += 1) {
      recording.appendCharacter('Q');
      recording.appendGap(0.18);
    }
    const player = new ReplayPlayer(recording);
    const replay = player.play(0);
    await sleep(25);
    const initial = marks(events);
    assert.ok(initial.length >= 6);
    const blockedUntil = performance.now() + 600;
    while (performance.now() < blockedUntil) {}
    contexts[0].time = 0.65;
    await sleep(0);
    assert.deepEqual(marks(events).slice(0, initial.length), initial);
    player.stop();
    assert.equal(await replay, false);
  });
});

test('10,000-character history keeps audio scheduling bounded and creates no session audio buffer', async () => {
  await withAudio({}, async ({ events }) => {
    const recording = new PracticeRecording();
    for (let index = 0; index < 10000; index += 1) {
      recording.appendCharacter('E');
      recording.appendGap(0.18);
    }
    assert.equal(recording.characterCount, 10000);
    const player = new ReplayPlayer(recording);
    const replay = player.play(0);
    await sleep(25);
    assert.ok(marks(events).length >= 5);
    assert.ok(marks(events).length < 20);
    assert.equal(events.filter((event) => event.type === 'oscillator').length, 1);
    player.stop();
    assert.equal(await replay, false);
  });
});

test('stopping during cold preparation ignores a stale context resume', async () => {
  await withAudio({ delayedResume: true }, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q');
    const player = new ReplayPlayer(recording);
    const replay = player.play(0);
    player.stop();
    assert.equal(await replay, false);
    contexts[0].finishResume();
    await sleep(30);
    assert.equal(marks(events).length, 0);
    assert.equal(player.isPlaying, false);
  });
});

test('replay snapshots only the recorded duration present when play starts', async () => {
  await withAudio({}, async ({ events, contexts }) => {
    const recording = new PracticeRecording();
    recording.appendCharacter('E');
    const player = new ReplayPlayer(recording);
    const replay = player.play(0);
    await sleep(25);
    recording.appendCharacter('Q');
    contexts[0].time = 0.5;
    assert.equal(await replay, true);
    assert.equal(marks(events).length, 1);
    close(player.position, 0.06);
  });
});

test('clearing the recording cancels active replay without any remaining progress', async () => {
  await withAudio({}, async () => {
    const recording = new PracticeRecording();
    recording.appendCharacter('Q');
    const player = new ReplayPlayer(recording);
    const replay = player.play(0);
    await sleep(25);
    recording.clear();
    assert.equal(await replay, false);
    assert.equal(player.position, 0);
    assert.equal(player.duration, 0);
    assert.equal(await player.play(0), false);
  });
});
