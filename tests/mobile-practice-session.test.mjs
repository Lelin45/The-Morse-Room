import test from 'node:test';
import assert from 'node:assert/strict';
import { MobilePracticeSession } from '../mobile-practice-session.js';
import { gradeInput } from '../trainer.js';

test('mobile practice counts only a completed signal and waits for its answer', () => {
  const session = new MobilePracticeSession({ total: 2 });
  session.startCharacter('q');
  assert.equal(session.played, 0);
  assert.throws(() => session.submitCharacter('Q'), /complete signal/);
  session.completeCharacter();
  assert.equal(session.played, 1);
  assert.throws(() => session.startCharacter('F'), /current signal/);
  assert.equal(session.submitCharacter('Q'), false);
  session.startCharacter('F');
  session.completeCharacter();
  assert.equal(session.submitCharacter('F'), true);
  assert.equal(session.sequence, 'QF');
  assert.equal(session.copy, 'QF');
  assert.throws(() => session.startCharacter('L'), /current signal/);
});

test('wrong practice answers advance, and results can stay hidden until review', () => {
  const session = new MobilePracticeSession({ total: 2 });
  session.startCharacter('A');
  session.completeCharacter();
  session.submitCharacter('B');
  session.startCharacter('Z');
  session.completeCharacter();
  session.submitCharacter('Z');
  const grade = gradeInput(session.copy, session.sequence);
  assert.equal(grade.correct, 1);
  assert.equal(grade.incorrect, 1);
});

test('a stopped run checks a completed but unanswered signal as missed', () => {
  const session = new MobilePracticeSession();
  session.startCharacter('E');
  session.completeCharacter();
  session.submitCharacter('E');
  session.startCharacter('T');
  session.completeCharacter();
  const grade = gradeInput(session.copy, session.sequence);
  assert.equal(grade.total, 2);
  assert.equal(grade.correct, 1);
  assert.equal(grade.missing, 1);
  session.submitCharacter('T');
  session.startCharacter('N');
  assert.equal(session.played, 2, 'a partial next sound is excluded from the answer key');
});

test('mobile word groups retain their character count and automatic spacing', () => {
  const session = new MobilePracticeSession({ total: 6, groupSize: 3 });
  for (const character of 'ABCDEF') {
    session.startCharacter(character);
    session.completeCharacter();
    session.submitCharacter(character);
  }
  assert.equal(session.copy, 'ABC DEF');
  assert.equal(session.played, 6);
  assert.equal(session.answered, 6);
  assert.equal(session.completed, true);
});

test('invalid taps and duplicate completion cannot corrupt a receiving session', () => {
  const session = new MobilePracticeSession({ total: 1 });
  assert.throws(() => session.startCharacter('.'), /one letter/);
  session.startCharacter('5');
  session.completeCharacter();
  assert.throws(() => session.completeCharacter(), /currently playing/);
  assert.throws(() => session.submitCharacter('55'), /one letter/);
  assert.equal(session.played, 1);
  assert.equal(session.answered, 0);
  session.submitCharacter(' 5 ');
  assert.equal(session.copy, '5');
});
