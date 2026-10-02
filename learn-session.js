/** A lesson advances only after its current character has been received correctly. */
export class LearnSession {
  constructor(sequence) {
    if (typeof sequence !== 'string' || !/^[A-Za-z0-9]+$/.test(sequence)) {
      throw new RangeError('A lesson needs a nonempty sequence of letters and numbers.');
    }
    this.sequence = sequence.toUpperCase();
    this.index = 0;
    this.attempts = [];
  }

  get currentCharacter() {
    return this.sequence[this.index] ?? '';
  }

  get completed() {
    return this.index >= this.sequence.length;
  }

  submit(input) {
    if (this.completed) {
      throw new RangeError('This lesson is already complete.');
    }
    const actual = String(input ?? '').toUpperCase().replace(/\s+/gu, '');
    if (actual.length !== 1) {
      throw new RangeError('Type exactly one character before checking your answer.');
    }
    const expected = this.currentCharacter;
    const record = Object.freeze({
      actual,
      expected,
      correct: actual === expected,
      position: this.index + 1,
      attempt: this.attempts.length + 1,
    });
    this.attempts.push(record);
    if (record.correct) this.index += 1;
    return record;
  }
}
