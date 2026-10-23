import { MORSE, getTiming } from './audio.js';

// Radio exchanges also need callsign separators, reports and punctuation.
export const RADIO_MORSE = Object.freeze({ ...MORSE,
  '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--',
  '=': '-...-', '+': '.-.-.', '-': '-....-', '(': '-.--.', ')': '-.--.-',
  '@': '.--.-.', ':': '---...', "'": '.----.', '"': '.-..-.',
  '!': '-.-.--', '&': '.-...', ';': '-.-.-.', '_': '..--.-',
});
const decoded = new Map(Object.entries(RADIO_MORSE).map(([letter, code]) => [code, letter]));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function encodeRadioText(text) {
  const value = String(text ?? '').toUpperCase().trim();
  const unsupported = [...new Set([...value].filter(letter => !/\s/u.test(letter) && !RADIO_MORSE[letter]))];
  if (unsupported.length) throw new RangeError(`These characters cannot be sent in Morse: ${unsupported.join(' ')}`);
  return value.split(/\s+/u).filter(Boolean).map(word => [...word].map(letter => RADIO_MORSE[letter]).join(' ')).join(' / ');
}

export function normalizeRadioMorse(input, { composer = false } = {}) {
  const value = String(input ?? '').replaceAll('·', '.').replace(/[−–]/gu, '-').trim();
  if (/[^.\-/\s]/u.test(value)) throw new RangeError('Use dit, dah and letter or word gaps for Morse.');
  if (composer) return value.split(/\/{2,}/u).map(word => word.split(/[\/\s]+/u).filter(Boolean).join(' ')).filter(Boolean).join(' / ');
  return value.split(/\s*\/\s*/u).map(word => word.trim().split(/\s+/u).filter(Boolean).join(' ')).filter(Boolean).join(' / ');
}

export function decodeRadioMorse(input, options) {
  const value = normalizeRadioMorse(input, options);
  return value ? value.split(' / ').map(word => word.split(' ').map(code => decoded.get(code) ?? '?').join('')).join(' ') : '';
}

export function radioTransmission(morse, settings = {}, id = `tx${Date.now()}`) {
  const value = normalizeRadioMorse(morse);
  if (!value || value.length > 4096) throw new RangeError('Send between 1 and 4,096 Morse symbols.');
  if (value.split(' / ').some(word => word.split(' ').some(code => !decoded.has(code)))) {
    throw new RangeError('One of the Morse characters is incomplete or unsupported.');
  }
  const timing = getTiming(settings);
  const ditMs = Math.round(timing.dit * 1000);
  const characterGapMs = Math.max(ditMs * 3, Math.round(timing.characterGap * 1000));
  return { id, morse: value, ditMs, characterGapMs,
    wordGapMs: Math.max(ditMs * 7, characterGapMs, Math.round(timing.wordGap * 1000)) };
}

/** Decode detected tone durations. Incoming speed follows the received signal. */
export class StreamingMorseDecoder {
  constructor({ wpm = 18, farnsworth = wpm, onUpdate = () => {} } = {}) {
    this.initialDit = 1200 / Math.max(5, Math.min(60, finite(wpm, 18)));
    this.initialLetterGap = getTiming({ wpm, farnsworth }).characterGap * 1000;
    this.onUpdate = onUpdate;
    this.reset();
  }
  reset() {
    this.dit = this.initialDit;
    this.text = ''; this.morse = ''; this.pending = '';
    this.active = false; this.duration = 0; this.samples = [];
    this.letterGap = this.initialLetterGap;
    this.letterEnded = false; this.wordEnded = false; this.confidence = 0;
  }
  snapshot() { return { text: this.text, morse: this.morse, pending: this.pending,
    wpm: Math.round(1200 / this.dit), confidence: this.confidence }; }
  process(active, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10000) return;
    if (active !== this.active) {
      if (this.active) this.endMark(this.duration);
      else if (this.duration >= this.dit * 2.2 && this.duration < this.letterGap * 1.7) {
        this.letterGap = Math.max(this.dit * 3, this.letterGap * .7 + this.duration * .3);
      }
      this.active = active; this.duration = 0;
      if (active) { this.letterEnded = false; this.wordEnded = false; }
    }
    this.duration += durationMs;
    if (!active) {
      // A split near two units separates normal one-unit and three-unit gaps.
      if (!this.letterEnded && this.duration >= this.dit * 2.2) { this.endLetter(); this.letterEnded = true; }
      if (!this.wordEnded && this.duration >= Math.max(this.dit * 5.5, this.letterGap * 1.7) && this.text && !this.pending) {
        this.text = this.text.trimEnd() + ' ';
        this.morse = this.morse.replace(/[ /]+$/u, '') + ' / ';
        this.wordEnded = true;
      }
    }
    this.onUpdate(this.snapshot());
  }
  endMark(duration) {
    if (duration < Math.max(10, this.dit * .22)) return;
    const dah = duration >= this.dit * 2;
    if (duration > this.dit * 6 || this.pending.length >= 8) {
      this.pending += '?'; this.confidence = 0; return;
    }
    this.pending += dah ? '-' : '.';
    const unit = duration / (dah ? 3 : 1);
    this.samples.push(unit);
    if (this.samples.length > 24) this.samples.shift();
    const ordered = this.samples.slice().sort((a, b) => a - b);
    const median = ordered[Math.floor(ordered.length / 2)];
    this.dit = Math.max(20, Math.min(240, this.dit * .85 + median * .15));
    this.confidence = Math.max(0, 1 - Math.abs(unit - this.dit) / this.dit);
  }
  endLetter() {
    if (!this.pending) return;
    this.text += decoded.get(this.pending) ?? '?';
    this.morse += (this.morse && !this.morse.endsWith(' / ') ? ' ' : '') + this.pending;
    this.pending = '';
    // Keep capture memory bounded during a long listening session.
    this.text = this.text.slice(-12000); this.morse = this.morse.slice(-48000);
  }
  flush() {
    if (this.active) this.endMark(this.duration);
    this.active = false; this.duration = 0;
    this.endLetter(); this.onUpdate(this.snapshot());
    return this.snapshot();
  }
}

function binPower(samples, rate, frequency) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let before = 0; let previous = 0;
  for (const sample of samples) {
    const next = sample + coefficient * previous - before;
    before = previous; previous = next;
  }
  return Math.max(0, previous * previous + before * before - coefficient * previous * before) * 2 / (samples.length ** 2);
}

/** Narrow-band detection over real microphone/USB PCM, with noise rejection. */
export class RadioReceivePipeline {
  constructor({ frequency = 600, wpm = 18, farnsworth = wpm, onUpdate = () => {}, onSignal = () => {} } = {}) {
    this.frequency = Math.max(200, Math.min(1200, finite(frequency, 600)));
    this.onUpdate = onUpdate; this.onSignal = onSignal;
    this.decoder = new StreamingMorseDecoder({ wpm, farnsworth });
    this.reset();
  }
  reset() {
    this.decoder.reset(); this.buffer = []; this.rate = 0;
    this.noise = 1e-7; this.signal = 0; this.active = false; this.elapsed = 0;
  }
  setFrequency(frequency) {
    this.frequency = Math.max(200, Math.min(1200, finite(frequency, 600)));
  }
  push(samples, sampleRate) {
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate < 4000 || rate > 192000 || !samples?.length || samples.length > 19200) return;
    if (rate !== this.rate) { this.buffer = []; this.rate = rate; }
    const frameLength = Math.max(40, Math.round(rate * .01));
    for (const sample of samples) this.buffer.push(Math.max(-1, Math.min(1, finite(sample, 0))));
    let cursor = 0;
    while (this.buffer.length - cursor >= frameLength) {
      const frame = this.buffer.slice(cursor, cursor + frameLength); cursor += frameLength;
      const mean = frame.reduce((sum, sample) => sum + sample, 0) / frameLength;
      for (let index = 0; index < frame.length; index += 1) frame[index] -= mean;
      const power = frame.reduce((sum, sample) => sum + sample * sample, 0) / frameLength;
      const tonePower = Math.max(...[-40, 0, 40].map(offset => binPower(frame, rate, this.frequency + offset)));
      const ratio = power > 0 ? Math.min(1, tonePower / power) : 0;
      const active = ratio > (this.active ? .28 : .43) && tonePower > Math.max(3e-7, this.noise * 2.5);
      if (!active && ratio < .25) this.noise = this.noise * .97 + power * .03;
      this.signal = Math.max(0, Math.min(1, Math.sqrt(power) * 8));
      if (active !== this.active) { this.active = active; this.onSignal(active); }
      this.decoder.process(active, frameLength * 1000 / rate);
      this.elapsed += frameLength * 1000 / rate;
    }
    if (cursor) this.buffer = this.buffer.slice(cursor);
    this.onUpdate({ ...this.decoder.snapshot(), signal: this.signal, active: this.active });
  }
  flush() {
    const snapshot = this.decoder.flush();
    this.active = false; this.onSignal(false);
    this.onUpdate({ ...snapshot, signal: this.signal, active: false });
    return snapshot;
  }
}
