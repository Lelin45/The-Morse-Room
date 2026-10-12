import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_REAL_WORD_LENGTH,
  MAX_REAL_WORD_LENGTH,
  MIN_REAL_WORD_COUNT,
  MAX_REAL_WORD_COUNT,
  getRealWords,
  generateRealWords,
  generateRealWordGroups
} from '../real-word-bank.js';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('every supported length can provide fifty distinct Morse-safe words offline', () => {
  assert.equal(MIN_REAL_WORD_LENGTH, 2);
  assert.equal(MAX_REAL_WORD_LENGTH, 10);
  assert.equal(MIN_REAL_WORD_COUNT, 2);
  assert.equal(MAX_REAL_WORD_COUNT, 50);
  for (let length = MIN_REAL_WORD_LENGTH; length <= MAX_REAL_WORD_LENGTH; length += 1) {
    const words = getRealWords(length);
    assert.ok(words.length >= MAX_REAL_WORD_COUNT, `Length ${length} needs at least fifty words.`);
    assert.equal(new Set(words).size, words.length);
    for (const word of words) {
      assert.match(word, /^[A-Z]+$/);
      assert.equal(word.length, length, `${word} must have exactly ${length} letters.`);
    }
  }
  for (const word of ['AS', 'IN', 'OR', 'OF', 'OK', 'HI']) {
    assert.ok(getRealWords(2).includes(word), `${word} should be in two-letter practice.`);
  }
});

test('a session respects word count and exact length without repeating words', () => {
  for (let length = MIN_REAL_WORD_LENGTH; length <= MAX_REAL_WORD_LENGTH; length += 1) {
    for (const count of [MIN_REAL_WORD_COUNT, 17, MAX_REAL_WORD_COUNT]) {
      const selected = generateRealWords(length, count, { random: seededRandom(length * count) });
      assert.equal(selected.length, count);
      assert.equal(new Set(selected).size, count);
      for (const word of selected) {
        assert.equal(word.length, length);
        assert.ok(getRealWords(length).includes(word));
      }
    }
  }
});

test('new random sessions have independent order while reproducible sources give the same result', () => {
  const first = generateRealWords(2, 50, { random: seededRandom(107) });
  const same = generateRealWords(2, 50, { random: seededRandom(107) });
  const other = generateRealWords(2, 50, { random: seededRandom(108) });
  assert.deepEqual(first, same);
  assert.notDeepEqual(first, other);
  assert.notDeepEqual(first, getRealWords(2).slice(0, 50));
  assert.deepEqual(
    generateRealWordGroups({ wordLength: 5, wordCount: 10, random: seededRandom(93) }),
    generateRealWords(5, 10, { random: seededRandom(93) })
  );
});

test('reading or shuffling words cannot change the shared bank or another session', () => {
  const pool = getRealWords(3);
  const before = [...pool];
  assert.ok(Object.isFrozen(pool));
  assert.throws(() => pool.push('BAD'), TypeError);
  const selected = generateRealWords(3, 10, { random: seededRandom(9) });
  selected[0] = 'XYZ';
  selected.push('ABC');
  assert.deepEqual(getRealWords(3), before);
  assert.equal(generateRealWords(3, 10, { random: seededRandom(9) }).length, 10);
});

test('word count and letter count reject fractions, nonnumbers and out-of-range values', () => {
  for (const length of [undefined, null, '2', 0, 1, 11, 2.5, NaN, Infinity]) {
    assert.throws(() => getRealWords(length), /whole number of letters per word from 2 to 10/);
    assert.throws(() => generateRealWords(length, 10), /whole number of letters per word from 2 to 10/);
  }
  for (const count of [undefined, null, '2', 0, 1, 51, 2.5, NaN, Infinity]) {
    assert.throws(() => generateRealWords(2, count), /whole number of words from 2 to 50/);
  }
});

test('injected random values must stay within the valid range', () => {
  assert.throws(() => generateRealWords(2, 10, { random: 0 }), /random must be a function/);
  for (const value of [-0.01, 1, NaN, Infinity, undefined, '0.5']) {
    assert.throws(() => generateRealWords(2, 10, { random: () => value }), /random must return a finite number/);
  }
  const lowest = generateRealWords(2, 50, { random: () => 0 });
  const highest = generateRealWords(2, 50, { random: () => 1 - Number.EPSILON });
  assert.equal(new Set(lowest).size, 50);
  assert.equal(new Set(highest).size, 50);
});
