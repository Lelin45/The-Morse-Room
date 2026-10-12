import test from 'node:test';
import assert from 'node:assert/strict';
import { PracticeRoundSession } from '../practice-round-session.js';
import { QWERTY_ROWS, renderQwertyKeyboard } from '../qwerty-keyboard.js';

test('a wrong receiving answer retries the same target and finite count measures correct answers', () => {
  let draws = 0;
  const session = new PracticeRoundSession({ total: 2, next: () => ['Q', 'Y'][draws++] });
  assert.equal(session.begin(), 'Q');
  assert.equal(session.submit('K').correct, false);
  assert.equal(session.index, 0);
  assert.equal(session.begin(), 'Q');
  assert.equal(draws, 1);
  assert.equal(session.submit('q').correct, true);
  assert.equal(session.begin(), 'Y');
  assert.equal(session.submit('y').correct, true);
  assert.equal(session.completed, true);
  assert.equal(session.accuracy, 67);
  assert.equal(session.begin(), '');
});

test('sending a word requires the entire word before advancing', () => {
  const session = new PracticeRoundSession({ units: ['HI', 'OK'] });
  assert.equal(session.begin(), 'HI');
  assert.equal(session.submit('H').correct, false);
  assert.equal(session.begin(), 'HI');
  assert.equal(session.submit('h i').correct, true);
  assert.equal(session.begin(), 'OK');
  assert.equal(session.submit('ok').correct, true);
  assert.equal(session.completed, true);
});

test('unlimited rounds remain active and keep successful and incorrect attempts', () => {
  const session = new PracticeRoundSession({ next: () => '4' });
  for (let index = 0; index < 20; index += 1) { session.begin(); session.submit('4'); }
  assert.equal(session.index, 20);
  assert.equal(session.completed, false);
});

test('invalid targets and session limits are rejected', () => {
  assert.throws(() => new PracticeRoundSession({ total: 0, next: () => 'A' }));
  assert.throws(() => new PracticeRoundSession({ units: ['A', '!'] }));
  const session = new PracticeRoundSession({ next: () => '?' });
  assert.throws(() => session.begin());
  assert.throws(() => session.submit('A'));
});

test('the training keyboard has a number row and familiar QWERTY positions', () => {
  assert.deepEqual(QWERTY_ROWS, ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']);
  const markup = renderQwertyKeyboard();
  assert.equal((markup.match(/data-training-key=/g) || []).length, 36);
  assert.equal((markup.match(/class="qwerty-row"/g) || []).length, 4);
  assert.throws(() => renderQwertyKeyboard({ attribute: 'x"onclick' }));
});
