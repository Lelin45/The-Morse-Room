import test from 'node:test';
import assert from 'node:assert/strict';
import { LearnSession } from '../learn-session.js';

test('a wrong seventh answer retains that character until a correct retry', () => {
  const lesson = new LearnSession('ABCDEFGH');
  for (const character of 'ABCDEF') lesson.submit(character);
  const wrong = lesson.submit('X');
  assert.deepEqual(wrong, {
    actual: 'X', expected: 'G', correct: false, position: 7, attempt: 7,
  });
  assert.equal(lesson.index, 6);
  assert.equal(lesson.currentCharacter, 'G');
  assert.equal(lesson.completed, false);
  const retry = lesson.submit('G');
  assert.deepEqual(retry, {
    actual: 'G', expected: 'G', correct: true, position: 7, attempt: 8,
  });
  assert.equal(lesson.index, 7);
  assert.equal(lesson.currentCharacter, 'H');
  assert.equal(lesson.attempts[6], wrong);
  assert.equal(lesson.attempts[7], retry);
});

test('a thirty-character lesson requires thirty correct answers despite mistakes', () => {
  const sequence = 'ABCDEF'.repeat(5);
  const lesson = new LearnSession(sequence);
  for (const [index, character] of [...sequence].entries()) {
    lesson.submit('!');
    assert.equal(lesson.index, index);
    assert.equal(lesson.completed, false);
    lesson.submit(character);
  }
  assert.equal(lesson.index, 30);
  assert.equal(lesson.attempts.length, 60);
  assert.equal(lesson.attempts.filter((attempt) => attempt.correct).length, 30);
  assert.equal(lesson.completed, true);
  assert.equal(lesson.currentCharacter, '');
  for (const [index, attempt] of lesson.attempts.entries()) {
    assert.equal(attempt.attempt, index + 1);
    assert.equal(attempt.position, Math.floor(index / 2) + 1);
  }
});

test('empty and multiple-character submissions create no attempt and make no progress', () => {
  const lesson = new LearnSession('AB');
  for (const invalid of ['', ' \n\t', null, undefined, 'AB', 'A B']) {
    assert.throws(() => lesson.submit(invalid), /exactly one character/);
    assert.equal(lesson.index, 0);
    assert.equal(lesson.currentCharacter, 'A');
    assert.deepEqual(lesson.attempts, []);
  }
});

test('lowercase answers and surrounding spaces are accepted for letters and numbers', () => {
  const lesson = new LearnSession('q5');
  assert.equal(lesson.sequence, 'Q5');
  assert.equal(lesson.submit(' \tq\n').correct, true);
  assert.equal(lesson.currentCharacter, '5');
  assert.equal(lesson.submit(' 5 ').correct, true);
  assert.equal(lesson.completed, true);
});

test('single punctuation is recorded as an incorrect attempt without advancing', () => {
  const lesson = new LearnSession('A');
  const wrong = lesson.submit('?');
  assert.deepEqual(wrong, {
    actual: '?', expected: 'A', correct: false, position: 1, attempt: 1,
  });
  assert.equal(lesson.currentCharacter, 'A');
  assert.equal(lesson.index, 0);
  assert.equal(lesson.completed, false);
});

test('a completed lesson rejects further answers without adding attempts', () => {
  const lesson = new LearnSession('0');
  lesson.submit('0');
  assert.throws(() => lesson.submit('0'), /already complete/);
  assert.throws(() => lesson.submit(''), /already complete/);
  assert.equal(lesson.index, 1);
  assert.equal(lesson.attempts.length, 1);
});

test('the lesson sequence must contain one or more letters or numbers', () => {
  for (const invalid of ['', ' ', 'A B', 'AB?', null, undefined, 12, ['A']]) {
    assert.throws(() => new LearnSession(invalid), /nonempty sequence/);
  }
  const lesson = new LearnSession('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  assert.equal(lesson.index, 0);
  assert.equal(lesson.currentCharacter, 'A');
  assert.equal(lesson.completed, false);
});
