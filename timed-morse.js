/** Collect taps into letters, using the pause between taps as the boundary. */
export class TimedMorseInput {
  constructor({
    onChange = () => {},
    onBoundary = () => {},
    getLetterGap = () => 700,
    now = () => globalThis.performance?.now() ?? Date.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
    maxLength = 6000,
  } = {}) {
    this.onChange = onChange;
    this.onBoundary = onBoundary;
    this.getLetterGap = getLetterGap;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxLength = maxLength;
    this._value = '';
    this._boundary = false;
    this._timer = null;
    this._deadline = null;
    this._generation = 0;
  }

  get value() { return this._value; }

  get letterPending() {
    return !this._boundary && /[.-]$/.test(this._value);
  }

  append(symbol) {
    if (symbol !== '.' && symbol !== '-') {
      throw new TypeError('Use a dit (.) or a dah (-).');
    }
    // A background tab can delay a timeout. The input time still sets the gap.
    if (this._deadline !== null && this.now() >= this._deadline) this.flush();
    const separator = this._boundary && /[.-]$/.test(this._value) ? '/' : '';
    const next = `${this._value}${separator}${symbol}`;
    this._checkLength(next);
    this._value = next;
    this._boundary = false;
    this._schedule();
    this.onChange(this._value);
    return this._value;
  }

  word() {
    const content = this._value.replace(/[\s/]+$/, '');
    if (!content) return this._value;
    const next = `${content}//`;
    this._checkLength(next);
    this.stop();
    this._value = next;
    this._boundary = true;
    this.onChange(this._value);
    return this._value;
  }

  backspace() {
    this.stop();
    if (!this._value) return this._value;
    this._value = this._value.slice(0, -1);
    this._boundary = !/[.-]$/.test(this._value);
    if (this.letterPending) this._schedule();
    this.onChange(this._value);
    return this._value;
  }

  replace(raw) {
    if (typeof raw !== 'string') throw new TypeError('The Morse draft must be text.');
    this._checkLength(raw);
    this.stop();
    this._value = raw;
    // A restored draft ends with a completed letter. A fresh tap starts another.
    this._boundary = Boolean(raw);
    this.onChange(this._value);
    return this._value;
  }

  flush() {
    this.stop();
    if (this.letterPending) {
      this._boundary = true;
      this.onBoundary({ value: this._value, letter: this._value.match(/[.-]+$/)[0] });
    }
    return this._value;
  }

  stop() {
    this._generation += 1;
    if (this._timer !== null) this.clearTimer(this._timer);
    this._timer = null;
    this._deadline = null;
    return this._value;
  }

  _checkLength(value) {
    if (value.length > this.maxLength) {
      throw new RangeError(`Keep your Morse message to ${this.maxLength.toLocaleString('en-US')} symbols.`);
    }
  }

  _schedule() {
    this.stop();
    const configuredGap = Number(this.getLetterGap());
    const gap = Number.isFinite(configuredGap) ? Math.max(500, configuredGap) : 700;
    this._deadline = this.now() + gap;
    const generation = this._generation;
    this._timer = this.setTimer(() => {
      if (generation !== this._generation) return;
      this.flush();
    }, gap);
  }
}
