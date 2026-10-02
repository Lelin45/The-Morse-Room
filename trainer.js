export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';

export const LESSON_PAIRS = Object.freeze([
  'ET', 'AN', 'IM', 'SO', 'RK', 'DU', 'GB',
  'QF', 'YL', 'CP', 'ZX', 'VW', 'HJ',
]);

const ALL_CHARACTERS = LESSON_PAIRS.join('') + DIGITS;

export const LEVELS = Object.freeze(
  Array.from({ length: 18 }, (_, index) => {
    const learnedCount = (index + 1) * 2;
    return Object.freeze({
      number: index + 1,
      newCharacters: ALL_CHARACTERS.slice(index * 2, learnedCount),
      cumulativeCharacters: ALL_CHARACTERS.slice(0, learnedCount),
      practiceCount: learnedCount * 5,
    });
  }),
);

/** Spaces are optional when receiving. Other typed characters remain errors. */
export function normalizeInput(input) {
  return String(input ?? '').toUpperCase().replace(/\s+/gu, '');
}

function characterPool(pool) {
  const text = Array.isArray(pool) ? pool.join('') : String(pool ?? '');
  return [...new Set(text.toUpperCase().replace(/[^A-Z0-9]/g, ''))];
}

function validateCount(count, name = 'Character count') {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`${name} must be a non-negative whole number.`);
  }
}

function randomIndex(length, random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Random values must be between 0 (inclusive) and 1 (exclusive).');
  }
  return Math.floor(value * length);
}

/** Generate a sequence from the selected characters. Pass { random } for repeatable runs. */
export function generateSequence(pool, count, { random = Math.random } = {}) {
  validateCount(count);
  if (count === 0) return '';
  const characters = characterPool(pool);
  if (characters.length === 0) {
    throw new RangeError('Choose at least one letter or number.');
  }
  return Array.from({ length: count }, () => characters[randomIndex(characters.length, random)]).join('');
}

/** Every learned character occurs exactly five times, then the entire lesson is shuffled. */
export function generateLessonSequence(levelOrNumber, { random = Math.random } = {}) {
  const level = typeof levelOrNumber === 'number'
    ? LEVELS[levelOrNumber - 1]
    : levelOrNumber;
  if (!level || !LEVELS.some((entry) => entry.number === level.number)) {
    throw new RangeError('Choose a lesson from 1 to 18.');
  }
  const canonicalLevel = LEVELS[level.number - 1];
  const characters = [...canonicalLevel.cumulativeCharacters.repeat(5)];
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join('');
}

/** A group size of zero leaves the received characters together. */
export function formatGroups(input, groupSize = 5) {
  validateCount(groupSize, 'Letters per group');
  const characters = Array.from(normalizeInput(input));
  if (groupSize === 0) return characters.join('');
  const groups = [];
  for (let index = 0; index < characters.length; index += groupSize) {
    groups.push(characters.slice(index, index + groupSize).join(''));
  }
  return groups.join(' ');
}

function distanceRow(expected, actual) {
  let previous = Uint32Array.from({ length: actual.length + 1 }, (_, index) => index);
  let current = new Uint32Array(actual.length + 1);
  for (let row = 1; row <= expected.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= actual.length; column += 1) {
      current[column] = Math.min(
        previous[column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1),
        previous[column] + 1,
        current[column - 1] + 1,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

function alignSmall(expected, actual) {
  const width = actual.length + 1;
  const directions = new Uint8Array((expected.length + 1) * width);
  let previous = Uint32Array.from({ length: width }, (_, index) => index);
  let current = new Uint32Array(width);
  for (let column = 1; column < width; column += 1) directions[column] = 3;

  for (let row = 1; row <= expected.length; row += 1) {
    current[0] = row;
    directions[row * width] = 2;
    for (let column = 1; column < width; column += 1) {
      const diagonal = previous[column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      const missing = previous[column] + 1;
      const extra = current[column - 1] + 1;
      const best = Math.min(diagonal, missing, extra);
      current[column] = best;
      directions[row * width + column] = diagonal === best ? 1 : missing === best ? 2 : 3;
    }
    [previous, current] = [current, previous];
  }

  const rows = [];
  let row = expected.length;
  let column = actual.length;
  while (row > 0 || column > 0) {
    const direction = directions[row * width + column];
    if (direction === 1) {
      const expectedCharacter = expected[--row];
      const actualCharacter = actual[--column];
      rows.push({ expected: expectedCharacter, actual: actualCharacter, status: expectedCharacter === actualCharacter ? 'correct' : 'incorrect' });
    } else if (direction === 2) {
      rows.push({ expected: expected[--row], actual: '', status: 'missing' });
    } else {
      rows.push({ expected: '', actual: actual[--column], status: 'extra' });
    }
  }
  return rows.reverse();
}

function align(expected, actual) {
  if (expected.length === 0) return actual.map((character) => ({ expected: '', actual: character, status: 'extra' }));
  if (actual.length === 0) return expected.map((character) => ({ expected: character, actual: '', status: 'missing' }));
  if (expected.length === 1 || actual.length === 1 || expected.length * actual.length <= 1_000_000) {
    return alignSmall(expected, actual);
  }

  // Divide large attempts into smaller alignments without allocating a large matrix.
  const middle = Math.floor(expected.length / 2);
  const forward = distanceRow(expected.slice(0, middle), actual);
  const backward = distanceRow(expected.slice(middle).reverse(), actual.slice().reverse());
  const preferredSplit = Math.round(actual.length * middle / expected.length);
  let split = 0;
  let best = Infinity;
  for (let column = 0; column <= actual.length; column += 1) {
    const distance = forward[column] + backward[actual.length - column];
    if (distance < best || (distance === best && Math.abs(column - preferredSplit) < Math.abs(split - preferredSplit))) {
      best = distance;
      split = column;
    }
  }
  return [
    ...align(expected.slice(0, middle), actual.slice(0, split)),
    ...align(expected.slice(middle), actual.slice(split)),
  ];
}

/**
 * Check an attempt using minimum-edit alignment, so an omitted letter does not
 * turn the remaining correct letters into errors. Accuracy is a percentage.
 */
export function gradeInput(input, expected) {
  const normalizedInput = normalizeInput(input);
  const normalizedExpected = normalizeInput(expected);
  const actualCharacters = Array.from(normalizedInput);
  const expectedCharacters = Array.from(normalizedExpected);

  let prefix = 0;
  while (prefix < Math.min(actualCharacters.length, expectedCharacters.length)
    && actualCharacters[prefix] === expectedCharacters[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(actualCharacters.length, expectedCharacters.length) - prefix
    && actualCharacters[actualCharacters.length - suffix - 1] === expectedCharacters[expectedCharacters.length - suffix - 1]) suffix += 1;

  const alignedRows = [
    ...expectedCharacters.slice(0, prefix).map((character) => ({ expected: character, actual: character, status: 'correct' })),
    ...align(expectedCharacters.slice(prefix, expectedCharacters.length - suffix), actualCharacters.slice(prefix, actualCharacters.length - suffix)),
    ...expectedCharacters.slice(expectedCharacters.length - suffix).map((character) => ({ expected: character, actual: character, status: 'correct' })),
  ];

  let expectedIndex = 0;
  let inputIndex = 0;
  const counts = { correct: 0, incorrect: 0, missing: 0, extra: 0 };
  const rows = alignedRows.map((row, index) => {
    counts[row.status] += 1;
    return {
      ...row,
      index,
      expectedIndex: row.expected ? expectedIndex++ : null,
      inputIndex: row.actual ? inputIndex++ : null,
    };
  });
  const denominator = Math.max(expectedCharacters.length, actualCharacters.length);
  return {
    rows,
    total: expectedCharacters.length,
    ...counts,
    accuracy: denominator === 0 ? 100 : Math.round(counts.correct / denominator * 1000) / 10,
    input: normalizedInput,
    expected: normalizedExpected,
  };
}
