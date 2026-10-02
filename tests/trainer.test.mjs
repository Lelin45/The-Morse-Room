import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTERS, DIGITS, LEVELS, generateSequence, generateLessonSequence, normalizeInput, formatGroups, gradeInput } from '../trainer.js';

const LETTER_LESSON_PAIRS = ['ET', 'AN', 'IM', 'SO', 'RK', 'DU', 'GB', 'QF', 'YL', 'CP', 'ZX', 'VW', 'HJ'];
const EXPECTED_LESSON_ORDER = LETTER_LESSON_PAIRS.join('') + '0123456789';

function seededRandom(seed = 19) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('18 lessons teach the requested letter pairs, then all ten digits, two at a time', () => {
  assert.equal(LEVELS.length, 18);
  const letterPairs = LEVELS.slice(0, 13).map((level) => level.newCharacters);
  assert.deepEqual(letterPairs, LETTER_LESSON_PAIRS);
  assert.equal([...letterPairs.join('')].sort().join(''), LETTERS);
  assert.deepEqual(LEVELS.slice(13).map((level) => level.newCharacters), ['01', '23', '45', '67', '89']);
  assert.equal(LEVELS[3].cumulativeCharacters, 'ETANIMSO');
  assert.equal(LEVELS[3].practiceCount, 40);
  assert.equal(LEVELS[17].practiceCount, 180);
  for (const level of LEVELS) {
    assert.equal(level.newCharacters.length, 2);
    assert.equal(level.cumulativeCharacters.length, level.number * 2);
    assert.equal(level.practiceCount, level.cumulativeCharacters.length * 5);
  }
});

test('each lesson practices every learned character exactly five times', () => {
  for (const level of LEVELS) {
    const expectedPool = EXPECTED_LESSON_ORDER.slice(0, level.number * 2);
    const sequence = generateLessonSequence(level, { random: seededRandom(level.number) });
    assert.equal(level.cumulativeCharacters, expectedPool);
    assert.equal(sequence.length, expectedPool.length * 5);
    for (const character of expectedPool) {
      assert.equal([...sequence].filter((item) => item === character).length, 5);
    }
    assert.ok([...sequence].every((character) => expectedPool.includes(character)));
  }
  assert.throws(() => generateLessonSequence(0), /1 to 18/);
  assert.throws(() => generateLessonSequence(19), /1 to 18/);
});

test('custom practice produces 100 characters using only the chosen pool', () => {
  const sequence = generateSequence('q y f l q!', 100, { random: seededRandom() });
  assert.equal(sequence.length, 100);
  assert.ok([...sequence].every((character) => 'QYFL'.includes(character)));
  assert.deepEqual([...new Set(sequence)].sort(), ['F', 'L', 'Q', 'Y']);
  assert.match(generateSequence([LETTERS, DIGITS], 100, { random: seededRandom() }), /^[A-Z0-9]{100}$/);
  assert.equal(generateSequence('', 0), '');
  assert.throws(() => generateSequence('', 10), /Choose at least one/);
  assert.throws(() => generateSequence('AB', -1), /whole number/);
  assert.throws(() => generateSequence('AB', 1.5), /whole number/);
});

test('grouping inserts a space after five letters and keeps an unfinished final word', () => {
  assert.equal(formatGroups('abcde fghij kl', 5), 'ABCDE FGHIJ KL');
  assert.equal(formatGroups('AB CD', 0), 'ABCD');
  assert.equal(formatGroups('', 5), '');
  assert.throws(() => formatGroups('ABC', -1), /whole number/);
});

test('grading accepts lowercase and optional spaces without discarding wrong punctuation', () => {
  assert.equal(normalizeInput('q \ny\tf!'), 'QYF!');
  const result = gradeInput('abc de\nf g', 'ABCDEFG');
  assert.equal(result.total, 7);
  assert.equal(result.correct, 7);
  assert.equal(result.accuracy, 100);
  assert.equal(result.incorrect + result.missing + result.extra, 0);
  assert.ok(result.rows.every((row) => row.status === 'correct'));
  const punctuation = gradeInput('AB!CD', 'ABCD');
  assert.equal(punctuation.correct, 4);
  assert.equal(punctuation.extra, 1);
  assert.equal(punctuation.rows[2].actual, '!');
});

test('a wrong letter is marked once and later letters still match', () => {
  const result = gradeInput('AXCD', 'ABCD');
  assert.equal(result.correct, 3);
  assert.equal(result.incorrect, 1);
  assert.equal(result.accuracy, 75);
  assert.deepEqual(result.rows[1], {
    index: 1, expectedIndex: 1, inputIndex: 1,
    expected: 'B', actual: 'X', status: 'incorrect',
  });
});

test('one omitted letter does not mark every later letter wrong', () => {
  const result = gradeInput('ACDE', 'ABCDE');
  assert.equal(result.correct, 4);
  assert.equal(result.missing, 1);
  assert.equal(result.incorrect, 0);
  assert.equal(result.extra, 0);
  assert.equal(result.accuracy, 80);
  assert.deepEqual(result.rows[1], {
    index: 1, expectedIndex: 1, inputIndex: null,
    expected: 'B', actual: '', status: 'missing',
  });
});

test('one inserted letter is counted separately without shifting later answers', () => {
  const result = gradeInput('ABXCDE', 'ABCDE');
  assert.equal(result.correct, 5);
  assert.equal(result.extra, 1);
  assert.equal(result.missing, 0);
  assert.equal(result.incorrect, 0);
  assert.equal(result.accuracy, 83.3);
  assert.deepEqual(result.rows[2], {
    index: 2, expectedIndex: null, inputIndex: 2,
    expected: '', actual: 'X', status: 'extra',
  });
});

test('an empty attempt marks all expected characters missing', () => {
  const result = gradeInput(' \n', 'ABCDE');
  assert.equal(result.missing, 5);
  assert.equal(result.correct, 0);
  assert.equal(result.accuracy, 0);
  assert.equal(gradeInput('', '').accuracy, 100);
});

test('long attempts align a missing letter between errors at both ends', () => {
  const expected = 'ABCDEFGHIJ'.repeat(130);
  const input = `X${expected.slice(1, 650)}${expected.slice(651, -1)}X`;
  const result = gradeInput(input, expected);
  assert.equal(result.total, 1300);
  assert.equal(result.correct, 1297);
  assert.equal(result.incorrect, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.extra, 0);
});
