import { normalizeInput } from './trainer.js';

/** A round only advances when its answer is correct. */
export class PracticeRoundSession {
  constructor({ total = null, units = null, next = null } = {}) {
    if (total !== null && (!Number.isSafeInteger(total) || total < 1)) throw new RangeError('Choose a positive round count.');
    if (units !== null && (!Array.isArray(units) || !units.length || units.some((unit) => !/^[A-Z0-9]+$/.test(unit)))) throw new RangeError('Practice targets must contain letters or numbers.');
    if (!units && typeof next !== 'function') throw new TypeError('Provide practice targets or a character generator.');
    this.total = units ? units.length : total;
    this.units = units?.slice() ?? null;
    this.next = next;
    this.index = 0;
    this.current = '';
    this.attempts = [];
  }

  get completed() { return this.total !== null && this.index >= this.total; }
  get accuracy() { return this.attempts.length ? Math.round(this.index / this.attempts.length * 100) : 0; }

  begin() {
    if (this.completed) return '';
    if (!this.current) {
      const target = this.units ? this.units[this.index] : this.next();
      if (!/^[A-Z0-9]+$/.test(target)) throw new RangeError('A practice target must contain letters or numbers.');
      this.current = target;
    }
    return this.current;
  }

  submit(answer) {
    if (!this.current || this.completed) throw new RangeError('Start a round before answering.');
    const actual = normalizeInput(answer);
    const record = { expected: this.current, actual, correct: actual === this.current, position: this.index + 1 };
    this.attempts.push(record);
    if (record.correct) { this.index += 1; this.current = ''; }
    return record;
  }
}
