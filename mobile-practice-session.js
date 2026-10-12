import { formatGroups, normalizeInput } from './trainer.js';

/** Receiving on a phone waits for one answer before playing another signal. */
export class MobilePracticeSession {
  constructor({ total = null, groupSize = 0 } = {}) {
    if (total !== null && (!Number.isSafeInteger(total) || total < 1)) {
      throw new RangeError('Choose a positive character count or continuous practice.');
    }
    if (!Number.isSafeInteger(groupSize) || groupSize < 0) {
      throw new RangeError('Letters per group must be a nonnegative whole number.');
    }
    this.total = total;
    this.groupSize = groupSize;
    this.sequence = '';
    this.copy = '';
    this.currentCharacter = '';
    this.phase = 'idle';
  }

  get played() { return this.sequence.length; }
  get answered() { return normalizeInput(this.copy).length; }
  get awaitingAnswer() { return this.phase === 'answer'; }
  get completed() { return this.phase === 'ready'; }

  startCharacter(character) {
    if (this.phase !== 'idle') throw new RangeError('Answer the current signal before continuing.');
    const next = normalizeInput(character);
    if (!/^[A-Z0-9]$/.test(next)) throw new RangeError('A signal must be one letter or number.');
    this.currentCharacter = next;
    this.phase = 'playing';
    return next;
  }

  completeCharacter() {
    if (this.phase !== 'playing') throw new RangeError('No character is currently playing.');
    this.sequence += this.currentCharacter;
    this.phase = 'answer';
    return this.played;
  }

  submitCharacter(character) {
    if (!this.awaitingAnswer) throw new RangeError('Listen to the complete signal before answering.');
    const next = normalizeInput(character);
    if (!/^[A-Z0-9]$/.test(next)) throw new RangeError('Choose one letter or number.');
    this.copy = formatGroups(this.copy + next, this.groupSize);
    this.phase = this.total !== null && this.answered >= this.total ? 'ready' : 'idle';
    return this.completed;
  }
}
