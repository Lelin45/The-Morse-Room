import test from 'node:test';
import assert from 'node:assert/strict';
import { morseText, validateMessage, encodeMorse, validateUsername } from '../chat-codec.js';
import { MORSE, buildCharacterSegments } from '../audio.js';

test('chat keeps the original text exactly while encoding only letters and numbers', () => {
  const original = "  Hi,\n My name is Lelin! :)  45.  ";
  assert.equal(validateMessage(original), original);
  assert.equal(morseText(original), 'HI MY NAME IS LELIN 45');
  assert.equal(encodeMorse('Hi My name is Lelin'), '.... .. / -- -.-- / -. .- -- . / .. ... / .-.. . .-.. .. -.');
  assert.equal(encodeMorse('Q? 50!'), '--.- / ..... -----');
});

test('symbols are omitted without adding Morse punctuation or breaking words', () => {
  assert.equal(morseText("I'm @home... A/B\t12-34 \u{1F44B} yes"), 'IM HOME AB 1234 YES');
  assert.equal(encodeMorse('A, . ! B? 2'), '.- / -... / ..---');
  assert.equal(morseText('Q \u2122 \u00bc \u2460 \u2109'), 'Q');
  const text = '<script>Hi!</script> \u{1F44B}';
  assert.equal(validateMessage(text), text);
  assert.equal(morseText(text), 'SCRIPTHISCRIPT');
});

test('chat validates length and requires a letter or number for the signal', () => {
  for (const text of ['!?.,', '\u{1F642}', '\u{1F642} @ #']) {
    assert.throws(() => validateMessage(text), /at least one English letter or number/);
  }
  assert.throws(() => validateMessage('a'.repeat(1001)), /1,000/);
  assert.throws(() => validateMessage('  '), /message first/);
  assert.throws(() => validateMessage(null), /message first/);
  assert.equal(validateMessage('a'.repeat(1000)).length, 1000);
});

test('accents are kept in the readable text and use plain letters in the signal', () => {
  const text = 'Caf\u00e9\tthere\u2019s';
  assert.equal(validateMessage(text), text);
  assert.equal(morseText(text), 'CAFE THERES');
});

test('chat uses the same 36-character alphabet as the trainer', () => {
  const original = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?,./@';
  const encoded = encodeMorse(original).split(' ');
  assert.equal(encoded.length, 36);
  assert.deepEqual(new Set(encoded), new Set(Object.values(MORSE)));
  assert.throws(() => buildCharacterSegments('?'), /Unsupported Morse/);
});

test('usernames have a predictable case-insensitive identity', () => {
  assert.equal(validateUsername(' LeLin_45 '), 'lelin_45');
  for (const input of ['ab', 'name@example.com', 'has space', 'a'.repeat(25), '<script>']) {
    assert.throws(() => validateUsername(input), /3 to 24/);
  }
});
