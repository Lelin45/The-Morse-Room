import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AUDIO, restoreAudioSettings, effectiveAudio } from '../audio-settings.js';

test('first launch uses one default audio profile for every mode', () => {
  const settings = restoreAudioSettings(null);
  assert.equal(settings.mode, 'default');
  assert.deepEqual(effectiveAudio(settings), DEFAULT_AUDIO);
});

test('upgrading keeps the saved trainer speed and intentional mute as global custom settings', () => {
  const previous = { wpm: 25, farnsworth: 13, frequency: 750, volume: 0 };
  const settings = restoreAudioSettings(null, previous, { mode: 'custom', wpm: 32, farnsworth: 20, frequency: 900 });
  assert.equal(settings.mode, 'custom');
  assert.deepEqual(effectiveAudio(settings), previous);
});

test('older custom chat preferences can migrate when no trainer settings exist', () => {
  const settings = restoreAudioSettings(null, null, { mode: 'custom', wpm: 24, farnsworth: 14, frequency: 700 });
  assert.deepEqual(effectiveAudio(settings), { wpm: 24, farnsworth: 14, frequency: 700, volume: 50 });
});

test('default keeps volume and preserves custom values through reload and switching back', () => {
  const settings = restoreAudioSettings({ mode: 'custom', wpm: 30, farnsworth: 17, frequency: 800, volume: 35 });
  settings.mode = 'default';
  assert.deepEqual(effectiveAudio(settings), { ...DEFAULT_AUDIO, volume: 35 });
  const reloaded = restoreAudioSettings(JSON.parse(JSON.stringify(settings)), { wpm: 18, farnsworth: 12, frequency: 600, volume: 35 });
  reloaded.mode = 'custom';
  assert.deepEqual(effectiveAudio(reloaded), { wpm: 30, farnsworth: 17, frequency: 800, volume: 35 });
});

test('invalid stored preferences are bounded and Farnsworth never exceeds character speed', () => {
  const settings = restoreAudioSettings({ mode: 'custom', wpm: 7, farnsworth: 80, frequency: 1, volume: 500 });
  assert.deepEqual(effectiveAudio(settings), { wpm: 7, farnsworth: 7, frequency: 200, volume: 100 });
  assert.deepEqual(effectiveAudio(restoreAudioSettings({ mode: 'default', wpm: 'bad', volume: '' })), DEFAULT_AUDIO);
});
