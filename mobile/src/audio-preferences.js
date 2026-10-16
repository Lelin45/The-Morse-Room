import { restoreAudioSettings } from '../generated/audio-settings.js';

export const AUDIO_PREFERENCES_KEY = 'morse-room-audio-preferences';

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['default', 'custom'].includes(value.mode)
    || !['wpm', 'farnsworth', 'frequency', 'volume'].every(key => Number.isFinite(value[key]))) return null;
  return restoreAudioSettings(value);
}

// Only the audio profile crosses this boundary. Ignore unrelated stored fields.
export function readAudioPreferences(raw) {
  try { return normalize(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { return null; }
}

export function withAudioPreferences(html, settings) {
  const profile = normalize(settings);
  if (!profile) return html;
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('Trainer HTML requires a head element.');
  // Normalization produces only the fixed mode and four numbers, never user text.
  const script = `<script>window.__MORSE_AUDIO_SETTINGS=${JSON.stringify(profile)};</script>`;
  return html.replace(/<head\b[^>]*>/i, match => match + script);
}

// Serialize writes so an older, slower request cannot replace a newer profile.
export function createAudioPreferenceWriter(save) {
  let pending = Promise.resolve();
  return settings => {
    const profile = normalize(settings);
    if (!profile) return Promise.resolve();
    const raw = JSON.stringify(profile);
    pending = pending.then(() => save(raw)).then(() => {}, () => {});
    return pending;
  };
}
