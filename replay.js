import { buildCharacterSegments, getTiming } from './audio.js';

const FADE = 0.004;
const START_LEAD = 0.05;
const WINDOW = 1.5;

function finiteDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError('A recording gap must be a finite, nonnegative number.');
  }
  return number;
}

function toneSettings(settings = {}) {
  const suppliedFrequency = Number(settings.frequency ?? 600);
  const suppliedVolume = Number(settings.volume ?? 50);
  return {
    frequency: Number.isFinite(suppliedFrequency)
      ? Math.max(20, Math.min(20000, suppliedFrequency)) : 600,
    volume: Number.isFinite(suppliedVolume)
      ? Math.max(0, Math.min(100, suppliedVolume)) : 50,
  };
}

/** Only append characters after their original playback has finished. */
export class PracticeRecording {
  constructor() {
    this._segments = [];
    this._characters = [];
    this._duration = 0;
    this._generation = 0;
  }

  get duration() { return this._duration; }
  get characterCount() { return this._characters.length; }
  get segments() { return this._segments; }
  get timeline() { return this._segments; }
  get characters() { return this._characters; }

  appendCharacter(character, settings = {}) {
    const segments = buildCharacterSegments(character, settings);
    const timing = getTiming(settings);
    const snapshot = Object.freeze({
      wpm: 1.2 / timing.dit,
      farnsworth: 60 / (31 * timing.dit + 19 * timing.characterGap / 3),
      ...toneSettings(settings),
    });
    const start = this._duration;
    for (const segment of segments) this._append(segment.tone, segment.duration, snapshot);
    const entry = Object.freeze({
      character: String(character).trim().toUpperCase(),
      settings: snapshot,
      start,
      end: this._duration,
      duration: this._duration - start,
    });
    this._characters.push(entry);
    return entry;
  }

  appendGap(seconds) {
    const duration = finiteDuration(seconds);
    return duration ? this._append(false, duration, null) : null;
  }

  clear() {
    this._segments.length = 0;
    this._characters.length = 0;
    this._duration = 0;
    this._generation += 1;
  }

  _append(tone, duration, settings) {
    const segment = Object.freeze({
      tone, duration, settings, start: this._duration, end: this._duration + duration,
    });
    this._segments.push(segment);
    this._duration = segment.end;
    return segment;
  }
}

/**
 * Replay recorded timing through a persistent carrier and a 1.5-second native
 * scheduling window. No audio buffers proportional to session length are kept.
 */
export class ReplayPlayer {
  constructor(recording, { onProgress, onSignal, onEnded } = {}) {
    if (!(recording instanceof PracticeRecording)) {
      throw new TypeError('Replay needs a PracticeRecording.');
    }
    this.recording = recording;
    this._onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this._onSignal = typeof onSignal === 'function' ? onSignal : () => {};
    this._onEnded = typeof onEnded === 'function' ? onEnded : () => {};
    this._context = null;
    this._carrier = null;
    this._resumePromise = null;
    this._clockReady = false;
    this._operation = null;
    this._paused = false;
    this._signal = false;
    this._position = 0;
    this._settings = {};
  }

  get duration() { return this.recording.duration; }
  get isPlaying() { return this._operation !== null && !this._paused; }
  get isPaused() { return this._operation !== null && this._paused; }
  get position() {
    const operation = this._operation;
    if (operation && !this._paused && operation.startedAt !== null) {
      return Math.min(operation.duration,
        operation.offset + Math.max(0, this._context.currentTime - operation.startedAt));
    }
    return Math.min(this.duration, this._position);
  }

  async prepare() {
    this._ensureContext();
    let resumed = Promise.resolve();
    if (this._context.state !== 'running') {
      this._clockReady = false;
      if (!this._resumePromise) {
        this._resumePromise = Promise.resolve(this._context.resume())
          .finally(() => { this._resumePromise = null; });
      }
      resumed = this._resumePromise;
    }
    await resumed;
    if (!this._clockReady) {
      const initial = this._context.currentTime;
      const deadline = performance.now() + 1000;
      while (this._context.currentTime <= initial) {
        if (performance.now() >= deadline) throw new Error('Audio output is not ready. Try Replay again.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      this._clockReady = true;
    }
  }

  async play(offsetSeconds = 0, settings = {}) {
    const number = Number(offsetSeconds);
    if (!Number.isFinite(number)) throw new RangeError('Choose a finite replay position.');
    this.stop();
    this._settings = { ...settings };
    this._position = Math.max(0, Math.min(this.duration, number));
    if (!this.duration) {
      this._progress();
      return false;
    }
    if (this._position >= this.duration) {
      this._progress();
      this._onEnded(this.duration);
      return true;
    }
    const operation = {
      offset: this._position,
      duration: this.duration,
      generation: this.recording._generation,
      startedAt: null,
      cursor: 0,
      timer: null,
      preparing: false,
      settled: false,
    };
    operation.promise = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    this._operation = operation;
    this._progress();
    this._preparePlayback(operation);
    return operation.promise;
  }

  seek(offsetSeconds, settings = this._settings) {
    return this.play(offsetSeconds, settings);
  }

  pause() {
    const operation = this._operation;
    if (!operation || this._paused) return false;
    this._position = this.position;
    operation.offset = this._position;
    operation.startedAt = null;
    this._paused = true;
    clearTimeout(operation.timer);
    this._mute();
    this._setSignal(false);
    this._progress();
    return true;
  }

  resume() {
    if (!this.isPaused) return false;
    this._paused = false;
    this._preparePlayback(this._operation);
    this._progress();
    return true;
  }

  stop() {
    const operation = this._operation;
    this._position = this.position;
    if (operation) {
      clearTimeout(operation.timer);
      operation.settled = true;
      operation.resolve(false);
    }
    this._operation = null;
    this._paused = false;
    this._mute();
    this._setSignal(false);
    this._progress();
    return Boolean(operation);
  }

  _ensureContext() {
    if (this._context) return;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('Replay requires a browser with Web Audio support.');
    this._context = new AudioContext({ latencyHint: 'interactive' });
    const oscillator = this._context.createOscillator();
    const gain = this._context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(600, this._context.currentTime);
    gain.gain.setValueAtTime(0, this._context.currentTime);
    oscillator.connect(gain);
    gain.connect(this._context.destination);
    oscillator.start(this._context.currentTime);
    this._carrier = { oscillator, gain };
  }

  _preparePlayback(operation) {
    if (operation.preparing) return;
    operation.preparing = true;
    this.prepare().then(() => {
      operation.preparing = false;
      if (this._operation !== operation || this._paused) return;
      try {
        operation.startedAt = this._context.currentTime + START_LEAD;
        operation.anchor = operation.startedAt - operation.offset;
        operation.cursor = this._segmentIndex(operation.offset);
        this._carrier.gain.gain.cancelScheduledValues(operation.startedAt);
        this._carrier.gain.gain.setValueAtTime(0, operation.startedAt);
        this._tick(operation);
      } catch (error) { this._fail(operation, error); }
    }, (error) => this._fail(operation, error));
  }

  _segmentIndex(position) {
    const segments = this.recording.segments;
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segments[middle].end <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  _tick(operation) {
    if (this._operation !== operation || this._paused) return;
    if (operation.generation !== this.recording._generation) {
      this.stop();
      return;
    }
    const clock = this._context.currentTime;
    const position = this.position;
    if (clock >= operation.anchor + operation.duration) {
      this._finish(operation);
      return;
    }
    try { this._scheduleWindow(operation, clock); }
    catch (error) { this._fail(operation, error); return; }
    const segment = this.recording.segments[this._segmentIndex(position)];
    this._setSignal(clock >= operation.startedAt && Boolean(segment?.tone));
    this._progress();
    if (this._operation === operation && !this._paused) {
      operation.timer = setTimeout(() => this._tick(operation), 25);
    }
  }

  _scheduleWindow(operation, clock) {
    const segments = this.recording.segments;
    const horizon = clock + WINDOW;
    for (; operation.cursor < segments.length; operation.cursor += 1) {
      const segment = segments[operation.cursor];
      if (segment.start >= operation.duration) break;
      const plannedStart = Math.max(operation.startedAt, operation.anchor + segment.start);
      if (plannedStart > horizon) break;
      const end = Math.min(operation.anchor + segment.end, operation.anchor + operation.duration);
      if (!segment.tone || end <= clock) continue;
      const start = Math.max(plannedStart, clock + 0.003);
      if (end <= start) continue;
      const settings = toneSettings({ ...segment.settings, ...this._settings });
      const fade = Math.min(FADE, (end - start) / 3);
      const gain = this._carrier.gain.gain;
      this._carrier.oscillator.frequency.setValueAtTime(settings.frequency, start);
      gain.setValueAtTime(0, start);
      gain.linearRampToValueAtTime(settings.volume / 100, start + fade);
      gain.setValueAtTime(settings.volume / 100, end - fade);
      gain.linearRampToValueAtTime(0, end);
    }
  }

  _mute() {
    if (!this._carrier) return;
    const now = this._context.currentTime;
    const gain = this._carrier.gain.gain;
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
    else {
      const value = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(value, now);
    }
    gain.linearRampToValueAtTime(0, now + FADE);
    this._carrier.oscillator.frequency.cancelScheduledValues(now);
  }

  _setSignal(signal) {
    if (this._signal === signal) return;
    this._signal = signal;
    this._onSignal(signal);
  }

  _progress() { this._onProgress(this.position, this.duration); }

  _finish(operation) {
    if (this._operation !== operation) return;
    clearTimeout(operation.timer);
    this._position = operation.duration;
    this._operation = null;
    this._paused = false;
    operation.settled = true;
    this._setSignal(false);
    this._progress();
    operation.resolve(true);
    this._onEnded(operation.duration);
  }

  _fail(operation, error) {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    if (this._operation === operation) {
      this._position = this.position;
      this._operation = null;
      this._paused = false;
      this._mute();
      this._setSignal(false);
      this._progress();
    }
    operation.reject(error);
  }
}
