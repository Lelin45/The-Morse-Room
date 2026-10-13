import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MORSE, getTiming } from '../../audio.js';

const mobile = fileURLToPath(new URL('..', import.meta.url));

test('bundled trainer contains its complete local code and styling, without server modules', async () => {
  const { default: html, trainerRevision } = await import('../generated/trainer-html.js');
  const manifest = JSON.parse(await readFile(resolve(mobile, 'generated/trainer-manifest.json'), 'utf8'));
  assert.equal(createHash('sha256').update(html).digest('hex').slice(0, 20), trainerRevision);
  assert.equal(manifest.revision, trainerRevision);
  assert.equal(manifest.bytes, Buffer.byteLength(html));
  assert(html.includes('<title>Morse Code Nepal</title>'));
  assert(html.includes('data-mode="learn"'));
  assert(html.includes('data-mode="practice"'));
  assert(html.includes('data-mode="characters"'));
  assert(html.includes('data:image/png;base64,'));
  assert(html.includes('morse-native-background'));
  assert(!/<script\b[^>]*\bsrc=/i.test(html));
  assert(!/<link\b[^>]*rel=["']stylesheet/i.test(html));
  assert(!/\bimport\s*(?:\(|['"]|[^;]*from\s*['"])/.test(html));
  assert(manifest.modules.includes('/audio.js'));
  assert(manifest.modules.includes('/real-word-bank.js'));
  assert(manifest.modules.every((value) => !/\.env|\/server\/|\/node_modules\//.test(value)));
  for (const name of ['CLOUDFLARE_API_TOKEN', 'GOOGLE_CLIENT_SECRET', 'EXPO_TOKEN', 'PLAY_REVIEW_PASSWORD']) assert(!html.includes(name));
});

test('WELCOME audio uses shared Morse definitions and 24 WPM with silent lead and smooth marks', async () => {
  const wav = await readFile(resolve(mobile, 'assets/welcome.wav'));
  const metadata = JSON.parse(await readFile(resolve(mobile, 'generated/welcome-timing.json'), 'utf8'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  const timing = getTiming({ wpm: 24, farnsworth: 24 });
  const sampleRate = wav.readUInt32LE(24);
  let expected = 0.18;
  for (const [index, letter] of [...'WELCOME'].entries()) {
    if (index) expected += timing.characterGap;
    assert.equal(metadata.letters[index].letter, letter);
    assert(Math.abs(metadata.letters[index].start - expected) < 0.0001);
    const start = Math.round(expected * sampleRate);
    assert.equal(wav.readInt16LE(44 + start * 2), 0);
    let energy = 0;
    for (let sample = start + 200; sample < start + 800; sample += 1) energy += Math.abs(wav.readInt16LE(44 + sample * 2));
    assert(energy > 100000);
    const code = MORSE[letter];
    expected += [...code].reduce((sum, mark) => sum + (mark === '.' ? timing.dit : timing.dah), 0) + (code.length - 1) * timing.intraCharacterGap;
  }
  expected += 0.15;
  assert(Math.abs(metadata.duration - expected) < 0.0001);
  assert(Math.abs((wav.length - 44) / (sampleRate * 2) - expected) < 0.0001);
  assert(wav.subarray(44, 44 + Math.round(0.18 * sampleRate) * 2).every((byte) => byte === 0));
});
