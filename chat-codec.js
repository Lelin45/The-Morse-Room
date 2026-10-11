import { MORSE } from './audio.js';

export const MAX_MESSAGE_LENGTH = 1000;

/** Derive the signal without changing the readable message. */
export function morseText(input) {
  return String(input ?? '').replace(/[^\p{L}0-9\s]/gu, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().split(/\s+/).map((word) => word.replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean).join(' ');
}

export function validateMessage(input) {
  if (typeof input !== 'string') throw new TypeError('Write a message first.');
  if (!input.trim()) throw new RangeError('Write a message first.');
  if (input.length > MAX_MESSAGE_LENGTH) throw new RangeError('Keep your message to 1,000 characters.');
  if (!morseText(input)) throw new RangeError('Include at least one English letter or number.');
  return input;
}

export function encodeMorse(input) {
  return morseText(validateMessage(input)).split(' ')
    .map((word) => [...word].map((letter) => MORSE[letter]).join(' ')).join(' / ');
}

export function validateUsername(input) {
  const username = String(input ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new RangeError('Choose 3 to 24 letters, numbers, or underscores for your username.');
  }
  return username;
}
