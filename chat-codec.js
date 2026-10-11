import { MORSE } from './audio.js';

export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_MORSE_LENGTH = 6000;

const MORSE_LETTERS = Object.freeze(Object.fromEntries(
  Object.entries(MORSE).map(([letter, signal]) => [signal, letter]),
));

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

/** In the composer, / separates letters and // separates words. */
export function validateMorseMessage(input) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Write a Morse message first.');
  if (input.length > MAX_MORSE_LENGTH) throw new RangeError('Keep your Morse message to 6,000 symbols.');
  if (/[^.\-/\s]/.test(input)) throw new RangeError('Use only dits (.), dahs (-), and separators (/).');
  const signal = input.trim().replace(/\s*\/\s*/g, '/');
  if (/\/{3,}/.test(signal)) throw new RangeError('Use / between letters and // between words.');
  // A separator typed after the final character has no message content.
  const content = signal.replace(/\/{1,2}$/, '').trim();
  if (!content || content.startsWith('/')) throw new RangeError('Include a Morse letter or number.');
  const words = content.split('//').map((word) => {
    const groups = word.split(/[\s/]+/);
    return groups.map((group) => {
      const letter = MORSE_LETTERS[group];
      if (!letter) throw new RangeError(`The Morse group "${group}" is not a letter or number.`);
      return { letter, signal: group };
    });
  });
  const text = words.map((word) => word.map(({ letter }) => letter).join('')).join(' ');
  if (text.length > MAX_MESSAGE_LENGTH) throw new RangeError('Keep your message to 1,000 characters.');
  return {
    text,
    morse: words.map((word) => word.map(({ signal: group }) => group).join(' ')).join(' / '),
  };
}

export function decodeMorse(input) {
  return validateMorseMessage(input).text;
}

export function validateUsername(input) {
  const username = String(input ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new RangeError('Choose 3 to 24 letters, numbers, or underscores for your username.');
  }
  return username;
}
