import test from 'node:test';
import assert from 'node:assert/strict';
import { TimedMorseInput } from '../timed-morse.js';
import { decodeMorse } from '../chat-codec.js';

function clock() {
  let time = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      tasks.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimer: (id) => tasks.delete(id),
    advance(milliseconds, runTimers = true) {
      const end = time + milliseconds;
      if (runTimers) {
        while (true) {
          const due = [...tasks].filter(([, task]) => task.at <= end)
            .sort(([, first], [, second]) => first.at - second.at)[0];
          if (!due) break;
          time = due[1].at;
          tasks.delete(due[0]);
          due[1].callback();
        }
      }
      time = end;
    },
    get tasks() { return tasks; },
  };
}

test('quick taps form a letter and a pause starts the next without a Space', () => {
  const timer = clock();
  const changes = [];
  const boundaries = [];
  const input = new TimedMorseInput({ ...timer, onChange: (value) => changes.push(value), onBoundary: (event) => boundaries.push(event) });
  input.append('.');
  timer.advance(150);
  input.append('-');
  timer.advance(699);
  assert.equal(input.value, '.-');
  assert.equal(input.letterPending, true);
  timer.advance(1);
  assert.equal(input.value, '.-');
  assert.equal(input.letterPending, false);
  assert.deepEqual(boundaries, [{ value: '.-', letter: '.-' }]);
  input.append('-');
  timer.advance(150);
  input.append('.');
  timer.advance(150);
  input.append('.');
  timer.advance(150);
  input.append('.');
  assert.equal(input.value, '.-/-...');
  assert.equal(decodeMorse(input.value), 'AB');
  assert.deepEqual(changes, ['.', '.-', '.-/-', '.-/-.', '.-/-..', '.-/-...']);
});

test('an idle pause never invents a word and leaves no trailing separator', () => {
  const timer = clock();
  const input = new TimedMorseInput(timer);
  input.append('.');
  timer.advance(60_000);
  assert.equal(input.value, '.');
  input.append('-');
  assert.equal(input.value, './-');
  assert.equal(decodeMorse(input.value), 'ET');
});

test('Space makes an explicit word separator before or after the letter timer', () => {
  for (const pause of [0, 700]) {
    const timer = clock();
    const input = new TimedMorseInput(timer);
    assert.equal(input.word(), '');
    input.append('.');
    timer.advance(pause);
    input.word();
    input.word();
    assert.equal(input.value, './/');
    input.append('-');
    assert.equal(input.value, './/-');
    assert.equal(decodeMorse(input.value), 'E T');
    assert.equal(timer.tasks.size, 1);
  }
});

test('configured gaps are read for every new tap and have a human tapping floor', () => {
  const timer = clock();
  let gap = 100;
  const input = new TimedMorseInput({ ...timer, getLetterGap: () => gap });
  input.append('.');
  timer.advance(499);
  assert.equal(input.letterPending, true);
  timer.advance(1);
  assert.equal(input.letterPending, false);
  gap = 1200;
  input.append('-');
  timer.advance(1199);
  assert.equal(input.letterPending, true);
  timer.advance(1);
  assert.equal(input.letterPending, false);
  gap = NaN;
  input.append('.');
  timer.advance(700);
  assert.equal(input.letterPending, false);
});

test('delayed browser timers still respect the measured gap before the next tap', () => {
  const timer = clock();
  const input = new TimedMorseInput(timer);
  input.append('.');
  timer.advance(900, false);
  input.append('-');
  assert.equal(input.value, './-');
  assert.equal(timer.tasks.size, 1);
  timer.advance(200);
  assert.equal(input.letterPending, true);
});

test('flush commits the final letter once without changing the submitted value', () => {
  const timer = clock();
  let boundaryCount = 0;
  const input = new TimedMorseInput({ ...timer, onBoundary: () => { boundaryCount += 1; } });
  input.append('.');
  input.append('-');
  assert.equal(input.flush(), '.-');
  input.flush();
  timer.advance(700);
  assert.equal(boundaryCount, 1);
  assert.equal(input.value, '.-');
  input.append('.');
  assert.equal(input.value, '.-/.');
});

test('backspace corrects the last mark and allows adding its replacement', () => {
  const timer = clock();
  const input = new TimedMorseInput(timer);
  input.append('.');
  input.append('-');
  timer.advance(700);
  input.backspace();
  input.append('.');
  assert.equal(input.value, '..');
  input.backspace();
  input.backspace();
  assert.equal(input.value, '');
  assert.equal(input.backspace(), '');
  assert.equal(timer.tasks.size, 0);
});

test('backspace can remove explicit separators without a stale timer altering a draft', () => {
  const timer = clock();
  const input = new TimedMorseInput(timer);
  input.append('.');
  input.word();
  input.backspace();
  assert.equal(input.value, './');
  timer.advance(800);
  input.append('-');
  assert.equal(input.value, './-');
  input.backspace();
  input.backspace();
  input.append('.');
  assert.equal(input.value, '..');
});

test('replacing or stopping a draft prevents old callbacks from committing later', () => {
  const timer = clock();
  const boundaries = [];
  const input = new TimedMorseInput({ ...timer, onBoundary: (event) => boundaries.push(event) });
  input.append('.');
  const staleCallback = [...timer.tasks.values()][0].callback;
  input.replace('-...');
  staleCallback();
  assert.equal(input.value, '-...');
  assert.deepEqual(boundaries, []);
  input.append('.');
  assert.equal(input.value, '-.../.');
  input.stop();
  timer.advance(10_000);
  assert.equal(input.value, '-.../.');
  assert.deepEqual(boundaries, []);
  assert.equal(timer.tasks.size, 0);
});

test('restored drafts retain pasted separators and are extended with a new letter', () => {
  const timer = clock();
  const input = new TimedMorseInput(timer);
  input.replace(' .- / -... // ');
  input.append('.');
  assert.equal(decodeMorse(input.value), 'AB E');
  input.word();
  assert.equal(input.value, ' .- / -... // .//');
  input.replace('');
  input.append('-');
  assert.equal(input.value, '-');
});

test('length checks include inserted boundaries and leave drafts unchanged on failure', () => {
  const timer = clock();
  const input = new TimedMorseInput({ ...timer, maxLength: 3 });
  input.append('.');
  timer.advance(700);
  input.append('-');
  assert.equal(input.value, './-');
  assert.throws(() => input.append('.'), /3 symbols/);
  assert.equal(input.value, './-');
  assert.throws(() => input.word(), /3 symbols/);
  assert.equal(input.value, './-');
  assert.throws(() => input.replace('----'), /3 symbols/);
  assert.equal(input.value, './-');
  assert.throws(() => input.append('/'), /dit/);
  assert.throws(() => input.replace(null), /draft must be text/);
});
