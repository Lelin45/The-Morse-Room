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
 * See ARRL's standard: https://www.arrl.org/files/file/Technology/x9004008.pdf
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
const nowSeconds = () => globalThis.performance.now() / 1000;

/**
 * One cancellable playback operation at a time. A new operation cancels the old
 * one. Both playCharacter() and wait() resolve false on stop, or true on finish.
 * Pausing retains the remaining duration of the current mark or gap.
 */
export class MorsePlayer {
  constructor({ onSignal } = {}) {
    this._onSignal = typeof onSignal === 'function' ? onSignal : () => {};
    this._context = null;
    this._operation = null;
    this._paused = false;
    this._signal = false;
  }

  get isPlaying() {
    return this._operation !== null;
  }

  get isPaused() {
    return this._paused;
  }

  /** Unlock audio from a user gesture without starting or cancelling playback. */
  async prepare() {
    this._ensureContext();
    if (this._context.state !== 'running') {
      // The resume call must happen before await to retain the Start gesture.
      await this._context.resume();
    }
  }

  async playCharacter(character, settings = {}) {
    const segments = buildCharacterSegments(character, settings);
    const operation = this._createOperation(segments, settings, true);
    try {
      this._ensureContext();
      // Invoke resume synchronously so the first call keeps its user gesture.
      this._prepareAudio(operation);
    } catch (error) {
      this._settle(operation, false, error);
    }
    return operation.promise;
  }

  async wait(seconds) {
    const duration = Number(seconds);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError('The waiting time must be a finite, nonnegative number.');
    }
    const operation = this._createOperation(
      [{ tone: false, duration }], {}, false,
    );
    this._runSegment(operation);
    return operation.promise;
  }

  pause() {
    const operation = this._operation;
    if (!operation || this._paused) return false;
    this._paused = true;
    if (operation.startedAt !== null) {
      operation.remaining = Math.max(
        0, operation.remaining - (nowSeconds() - operation.startedAt),
      );
      operation.startedAt = null;
    }
    clearTimeout(operation.timer);
    operation.timer = null;
    this._stopTone(operation);
    return true;
  }

  resume() {
    const operation = this._operation;
    if (!operation || !this._paused) return false;
    this._paused = false;
    if (operation.requiresAudio) {
      try {
        this._prepareAudio(operation);
      } catch (error) {
        this._settle(operation, false, error);
      }
    } else {
      this._runSegment(operation);
    }
    return true;
  }

  stop() {
    if (!this._operation) {
      this._paused = false;
      return false;
    }
    this._settle(this._operation, false);
    return true;
  }

  _createOperation(segments, settings, requiresAudio) {
    this.stop();
    const operation = {
      segments,
      settings,
      requiresAudio,
      ready: !requiresAudio,
      preparing: false,
      index: 0,
      remaining: segments[0]?.duration ?? 0,
      startedAt: null,
      timer: null,
      sound: null,
      settled: false,
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
    if (!AudioContext) {
      throw new Error('Morse audio requires a browser with Web Audio support.');
    }
    this._context = new AudioContext();
  }

  _prepareAudio(operation) {
    if (this._operation !== operation || operation.preparing) return;
    if (this._context.state === 'running') {
      operation.ready = true;
      this._runSegment(operation);
      return;
    }
    operation.ready = false;
    operation.preparing = true;
    const resumed = this._context.resume();
    Promise.resolve(resumed).then(() => {
      operation.preparing = false;
      if (this._operation !== operation) return;
      operation.ready = true;
      this._runSegment(operation);
    }, (error) => this._settle(operation, false, error));
  }

  _runSegment(operation) {
    if (this._operation !== operation || this._paused || !operation.ready) return;
    // A pending context resume can arrive after playback has already started.
    if (operation.startedAt !== null) return;
    while (operation.remaining <= 0 && operation.index < operation.segments.length) {
      operation.index += 1;
      operation.remaining = operation.segments[operation.index]?.duration ?? 0;
    }
    if (operation.index >= operation.segments.length) {
      this._settle(operation, true);
      return;
    }
    const segment = operation.segments[operation.index];
    operation.startedAt = nowSeconds();
    try {
      if (segment.tone) this._startTone(operation);
    } catch (error) {
      this._settle(operation, false, error);
      return;
    }
    operation.timer = setTimeout(() => {
      if (this._operation !== operation || this._paused) return;
      operation.timer = null;
      operation.startedAt = null;
      operation.remaining = 0;
      this._stopTone(operation);
      this._runSegment(operation);
    }, operation.remaining * 1000);
  }

  _startTone(operation) {
    const context = this._context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    const end = start + operation.remaining;
    const fade = Math.min(FADE_SECONDS, operation.remaining / 3);
    const frequency = Math.min(20000, Math.max(
      20, positiveNumber(operation.settings.frequency, 600),
    ));
    const suppliedVolume = Number(operation.settings.volume ?? 50);
    const volume = Number.isFinite(suppliedVolume)
      ? Math.min(100, Math.max(0, suppliedVolume)) / 100 : 0.5;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + fade);
    gain.gain.setValueAtTime(volume, Math.max(start + fade, end - fade));
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    operation.sound = { oscillator, gain };
    oscillator.start(start);
    oscillator.stop(end);
    this._setSignal(true);
  }

  _stopTone(operation) {
    const sound = operation.sound;
    operation.sound = null;
    if (sound) {
      const now = this._context.currentTime;
      const parameter = sound.gain.gain;
      if (typeof parameter.cancelAndHoldAtTime === 'function') {
        parameter.cancelAndHoldAtTime(now);
      } else {
        const current = parameter.value;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(current, now);
      }
      parameter.linearRampToValueAtTime(0, now + FADE_SECONDS);
      // A second stop call replaces the oscillator's previous scheduled stop.
      sound.oscillator.stop(now + FADE_SECONDS);
    }
    this._setSignal(false);
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
    this._stopTone(operation);
    if (this._operation === operation) {
      this._operation = null;
      this._paused = false;
    }
    if (error) operation.reject(error);
    else operation.resolve(completed);
  }
}
