export const MORSE = Object.freeze({
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
});

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * PARIS has 31 units inside its characters and 19 units between them.
 * Farnsworth slows the spaces while leaving each character at its stated WPM.
 * https://morsecode.world/international/timing/
 * https://morsecode.world/international/timing/farnsworth.html
 */
export function getTiming({ wpm = 20, farnsworth } = {}) {
  const characterSpeed = positiveNumber(wpm, 20);
  const effectiveSpeed = Math.min(
    characterSpeed,
    positiveNumber(farnsworth, characterSpeed),
  );
  const dit = 1.2 / characterSpeed;
  const spacingUnit = (60 / effectiveSpeed - 31 * dit) / 19;
  return {
    dit,
    dah: dit * 3,
    intraCharacterGap: dit,
    characterGap: spacingUnit * 3,
    wordGap: spacingUnit * 7,
  };
}

/** A character contains only marks and the short gaps between its marks. */
export function buildCharacterSegments(character, settings = {}) {
  const key = String(character).trim().toUpperCase();
  if (!Object.hasOwn(MORSE, key)) {
    throw new RangeError(`Unsupported Morse character: ${character}`);
  }
  const { dit, dah } = getTiming(settings);
  const segments = [];
  for (const mark of MORSE[key]) {
    if (segments.length) segments.push({ tone: false, duration: dit });
    segments.push({ tone: true, duration: mark === '.' ? dit : dah });
  }
  return segments;
}


const FADE_SECONDS = 0.004;
const LOOKAHEAD_SECONDS = 0.05;
const MINIMUM_LEAD_SECONDS = 0.003;
const nowSeconds = () => globalThis.performance.now() / 1000;

/** Sound uses the render clock; page timers update indicators and completion only. */
export class MorsePlayer {
  constructor({ onSignal } = {}) {
    this._onSignal = typeof onSignal === 'function' ? onSignal : () => {};
    this._context = null;
    this._carrier = null;
    this._resumePromise = null;
    this._clockReady = false;
    this._operation = null;
    this._paused = false;
    this._signal = false;
    this._lastAudioEnd = null;
    this._nextStartAt = null;
  }

  get isPlaying() { return this._operation !== null; }
  get isPaused() { return this._paused; }

  /** Warm a connected, silent carrier from the Start gesture. */
  async prepare() {
    this._ensureContext();
    // Invoke resume before await while the user gesture is available.
    const resumed = this._resumeContext();
    await resumed;
    if (!this._clockReady) await this._waitForAudioClock();
  }

  async playCharacter(character, settings = {}) {
    const segments = buildCharacterSegments(character, settings);
    const operation = this._createOperation('audio', settings);
    operation.segments = segments;
    operation.leadRemaining = null;
    try {
      this._ensureContext();
      this._prepareAudio(operation);
    } catch (error) {
      this._settle(operation, false, error);
    }
    return operation.promise;
  }

  /** A full-duration delay, including countdowns before audio is prepared. */
  async wait(seconds) {
    const duration = this._duration(seconds);
    const operation = this._createOperation('wait');
    operation.remaining = duration;
    this._runWait(operation);
    return operation.promise;
  }

  /**
   * Reserve an audio-clock gap after the preceding character. Resolve up to
   * 50 ms early so the next playCharacter can schedule at the exact deadline.
   * wait() instead waits for its complete duration before resolving.
   */
  async gap(seconds) {
    const duration = this._duration(seconds);
    if (!this._context || this._lastAudioEnd === null) return this.wait(duration);
    const deadline = this._lastAudioEnd + duration;
    const operation = this._createOperation('gap');
    operation.remaining = Math.max(0, deadline - this._context.currentTime);
    operation.gapDeadline = deadline;
    this._runGap(operation);
    return operation.promise;
  }

  pause() {
    const operation = this._operation;
    if (!operation || this._paused) return false;
    this._paused = true;
    clearTimeout(operation.timer);
    operation.timer = null;
    if (operation.type === 'audio' && operation.audioStart !== null) {
      const clock = this._context.currentTime;
      operation.segments = this._remainingSegments(operation.segments, Math.max(0, clock - operation.audioStart));
      operation.leadRemaining = clock < operation.audioStart
        ? operation.audioStart - clock : LOOKAHEAD_SECONDS;
      operation.audioStart = null;
      operation.scheduled = [];
      this._mute();
    } else if (operation.type === 'wait' && operation.startedAt !== null) {
      operation.remaining = Math.max(0, operation.remaining - (nowSeconds() - operation.startedAt));
      operation.startedAt = null;
    } else if (operation.type === 'gap') {
      operation.remaining = Math.max(0, operation.gapDeadline - this._context.currentTime);
      operation.gapDeadline = null;
    }
    this._setSignal(false);
    return true;
  }

  resume() {
    const operation = this._operation;
    if (!operation || !this._paused) return false;
    this._paused = false;
    if (operation.type === 'audio') {
      try { this._prepareAudio(operation); }
      catch (error) { this._settle(operation, false, error); }
    } else if (operation.type === 'gap') {
      this._runGap(operation);
    } else {
      this._runWait(operation);
    }
    return true;
  }

  stop() {
    this._nextStartAt = null;
    this._lastAudioEnd = null;
    if (!this._operation) {
      this._paused = false;
      this._mute();
      this._setSignal(false);
      return false;
    }
    this._settle(this._operation, false);
    return true;
  }

  _duration(seconds) {
    const duration = Number(seconds);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError('The waiting time must be a finite, nonnegative number.');
    }
    return duration;
  }

  _createOperation(type, settings = {}) {
    if (this._operation) this.stop();
    const operation = {
      type, settings, timer: null, startedAt: null, audioStart: null,
      audioEnd: null, scheduled: [], preparing: false, settled: false,
    };
    operation.promise = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    this._operation = operation;
    return operation;
  }

  _ensureContext() {
    if (this._context) return;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('Morse audio requires a browser with Web Audio support.');
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

  _resumeContext() {
    if (this._context.state === 'running') return Promise.resolve();
    if (!this._resumePromise) {
      this._clockReady = false;
      const resumed = this._context.resume();
      this._resumePromise = Promise.resolve(resumed).finally(() => { this._resumePromise = null; });
    }
    return this._resumePromise;
  }

  async _waitForAudioClock() {
    const initial = this._context.currentTime;
    const deadline = nowSeconds() + 1;
    while (this._context.currentTime <= initial) {
      if (nowSeconds() >= deadline) throw new Error('Audio output is not ready. Try Start again.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this._clockReady = true;
  }

  _prepareAudio(operation) {
    if (this._operation !== operation || operation.preparing) return;
    operation.preparing = true;
    this.prepare().then(() => {
      operation.preparing = false;
      if (this._operation !== operation || this._paused) return;
      try { this._scheduleAudio(operation); }
      catch (error) { this._settle(operation, false, error); }
    }, (error) => this._settle(operation, false, error));
  }

  _scheduleAudio(operation) {
    if (this._operation !== operation || this._paused || operation.audioStart !== null) return;
    if (!operation.segments.length) return this._settle(operation, true);
    const context = this._context;
    const now = context.currentTime;
    let start;
    if (operation.leadRemaining !== null) {
      start = now + Math.max(MINIMUM_LEAD_SECONDS, operation.leadRemaining);
    } else if (this._nextStartAt !== null) {
      start = Math.max(this._nextStartAt, now + MINIMUM_LEAD_SECONDS);
    } else {
      start = now + LOOKAHEAD_SECONDS;
    }
    this._nextStartAt = null;
    const frequency = Math.min(20000, Math.max(20, positiveNumber(operation.settings.frequency, 600)));
    const suppliedVolume = Number(operation.settings.volume ?? 50);
    const volume = Number.isFinite(suppliedVolume)
      ? Math.min(100, Math.max(0, suppliedVolume)) / 100 : 0.5;
    const gain = this._carrier.gain.gain;
    this._carrier.oscillator.frequency.setValueAtTime(frequency, start);
    // Leave any preceding stop fade intact, replacing only later automation.
    gain.cancelScheduledValues(start);
    gain.setValueAtTime(0, start);
    operation.audioStart = start;
    operation.scheduled = [];
    let cursor = start;
    for (const segment of operation.segments) {
      const end = cursor + segment.duration;
      operation.scheduled.push({ ...segment, start: cursor, end });
      if (segment.tone) {
        const fade = Math.min(FADE_SECONDS, segment.duration / 3);
        gain.setValueAtTime(0, cursor);
        gain.linearRampToValueAtTime(volume, cursor + fade);
        gain.setValueAtTime(volume, end - fade);
        gain.linearRampToValueAtTime(0, end);
      }
      cursor = end;
    }
    operation.audioEnd = cursor;
    this._lastAudioEnd = cursor;
    this._tickAudio(operation);
  }

  _tickAudio(operation) {
    if (this._operation !== operation || this._paused) return;
    const clock = this._context.currentTime;
    // A wall timer can fire while a cold or suspended render clock is frozen.
    // Do not cancel any marks or resolve until the audio clock reaches the end.
    if (clock >= operation.audioEnd) return this._settle(operation, true);
    const active = operation.scheduled.find((segment) => clock >= segment.start && clock < segment.end);
    this._setSignal(Boolean(active?.tone));
    const next = clock < operation.audioStart
      ? operation.audioStart : active?.end ?? operation.audioEnd;
    operation.timer = setTimeout(() => this._tickAudio(operation),
      Math.max(4, Math.min(100, (next - clock) * 1000)));
  }

  _runWait(operation) {
    if (this._operation !== operation || this._paused) return;
    if (operation.remaining <= 0) return this._settle(operation, true);
    operation.startedAt = nowSeconds();
    operation.timer = setTimeout(() => {
      if (this._operation === operation && !this._paused) this._settle(operation, true);
    }, operation.remaining * 1000);
  }

  _runGap(operation) {
    if (this._operation !== operation || this._paused) return;
    if (operation.gapDeadline === null) operation.gapDeadline = this._context.currentTime + operation.remaining;
    const clock = this._context.currentTime;
    const readyAt = operation.gapDeadline - LOOKAHEAD_SECONDS;
    if (clock >= readyAt) {
      this._nextStartAt = operation.gapDeadline;
      this._settle(operation, true);
    } else {
      operation.timer = setTimeout(() => this._runGap(operation),
        Math.max(4, Math.min(100, (readyAt - clock) * 1000)));
    }
  }

  _remainingSegments(segments, elapsed) {
    const remaining = [];
    for (const segment of segments) {
      if (elapsed >= segment.duration) elapsed -= segment.duration;
      else {
        remaining.push({ ...segment, duration: segment.duration - elapsed });
        elapsed = 0;
      }
    }
    return remaining;
  }

  _mute() {
    if (!this._carrier) return;
    const now = this._context.currentTime;
    const parameter = this._carrier.gain.gain;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(now);
    else {
      const value = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(value, now);
    }
    parameter.linearRampToValueAtTime(0, now + FADE_SECONDS);
  }

  _setSignal(signal) {
    if (this._signal === signal) return;
    this._signal = signal;
    this._onSignal(signal);
  }

  _settle(operation, completed, error) {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    if (this._operation === operation) {
      if (!completed && operation.type === 'audio') this._mute();
      this._setSignal(false);
      this._operation = null;
      this._paused = false;
    }
    if (error) operation.reject(error);
    else operation.resolve(completed);
  }
}
