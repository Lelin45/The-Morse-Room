import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AUDIO_PREFERENCES_KEY, readAudioPreferences, withAudioPreferences, createAudioPreferenceWriter } from '../src/audio-preferences.js';

const custom = { mode: 'custom', wpm: 24, farnsworth: 15, frequency: 700, volume: 50 };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native audio preferences use a separate storage key and retain Custom values in Default', () => {
  assert.equal(AUDIO_PREFERENCES_KEY, 'morse-room-audio-preferences');
  assert.deepEqual(readAudioPreferences(JSON.stringify(custom)), custom);
  assert.deepEqual(readAudioPreferences(custom), custom);
  assert.deepEqual(readAudioPreferences(JSON.stringify({ ...custom, mode: 'default' })), { ...custom, mode: 'default' });
});

test('invalid profiles cannot replace saved preferences', () => {
  for (const raw of [null, undefined, '', '{', 'null', '[]', '{}', JSON.stringify({ ...custom, mode: 'other' }),
    JSON.stringify({ ...custom, wpm: '24' }), JSON.stringify({ ...custom, volume: null }), JSON.stringify({ mode: 'custom', wpm: 24 })]) {
    assert.equal(readAudioPreferences(raw), null);
  }
});

test('valid numbers use the shared trainer limits and unrelated fields are discarded', () => {
  assert.deepEqual(readAudioPreferences(JSON.stringify({ ...custom, wpm: 3, farnsworth: 50, frequency: 1300, volume: -3, secret: 'private' })), {
    mode: 'custom', wpm: 5, farnsworth: 5, frequency: 1200, volume: 0,
  });
  assert.equal(readAudioPreferences(JSON.stringify({ ...custom, frequency: Infinity })), null);
});

test('initial HTML exposes normalized settings before any trainer bootstrap code', () => {
  const html = '<!doctype html><html><head><script>window.boot=true;</script></head><body></body></html>';
  const result = withAudioPreferences(html, { ...custom, secret: '</script><script>window.leak=true</script>' });
  const scripts = [...result.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const context = { window: {} };
  vm.runInNewContext(scripts[0], context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.__MORSE_AUDIO_SETTINGS)), custom);
  assert.equal(context.window.boot, undefined);
  assert.equal(result.includes('secret'), false);
  assert.equal(result.includes('leak'), false);
  assert.ok(result.indexOf('__MORSE_AUDIO_SETTINGS') < result.indexOf('window.boot'));
  assert.equal(withAudioPreferences(html, null), html);
  assert.throws(() => withAudioPreferences('<body></body>', custom), /head/);
});

test('a slow earlier save completes before the next profile is written', async () => {
  const saved = [];
  let release;
  const writer = createAudioPreferenceWriter(async raw => {
    const profile = JSON.parse(raw);
    if (!saved.length) await new Promise(resolve => { release = resolve; });
    saved.push(profile);
  });
  const first = writer(custom);
  const second = writer({ ...custom, mode: 'default' });
  await tick();
  assert.deepEqual(saved, []);
  release();
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.deepEqual(saved, [custom, { ...custom, mode: 'default' }]);
});

test('failed storage writes recover and each request snapshots only its audio profile', async () => {
  const saved = [];
  let attempts = 0;
  const writer = createAudioPreferenceWriter(raw => {
    if (++attempts === 1) throw new Error('Storage unavailable');
    saved.push(JSON.parse(raw));
  });
  const mutable = { ...custom, secret: 'never save' };
  const first = writer(custom);
  const second = writer(mutable);
  mutable.wpm = 42;
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.deepEqual(saved, [custom]);
  assert.equal(await writer({ ...custom, volume: NaN }), undefined);
  assert.equal(attempts, 2);
});
