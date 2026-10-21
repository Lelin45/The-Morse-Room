export const DEFAULT_AUDIO = Object.freeze({ wpm: 18, farnsworth: 12, frequency: 600, volume: 50 });
export const AUDIO_SETTINGS_KEY = 'morse-room-audio-settings';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clamp = (value, min, max, fallback) => value !== null && value !== '' && Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;

// Keep existing trainer preferences when upgrading from separate chat controls.
export function restoreAudioSettings(saved, legacyTrainer, legacyChat) {
  const current = object(saved);
  const trainer = object(legacyTrainer);
  const chat = object(legacyChat);
  const trainerSaved = ['wpm', 'farnsworth', 'frequency', 'volume'].some(key => Number.isFinite(trainer[key]));
  const source = ['default', 'custom'].includes(current.mode) ? current
    : trainerSaved ? { ...trainer, mode: 'custom' }
      : chat.mode === 'custom' ? { ...chat, volume: trainer.volume, mode: 'custom' } : {};
  const wpm = clamp(source.wpm, 5, 60, DEFAULT_AUDIO.wpm);
  return {
    mode: source.mode === 'custom' ? 'custom' : 'default',
    wpm,
    farnsworth: Math.min(wpm, clamp(source.farnsworth, 1, 60, DEFAULT_AUDIO.farnsworth)),
    frequency: clamp(source.frequency, 200, 1200, DEFAULT_AUDIO.frequency),
    volume: clamp(source.volume, 0, 100, DEFAULT_AUDIO.volume),
  };
}

export function effectiveAudio(settings) {
  const source = settings.mode === 'default' ? DEFAULT_AUDIO : settings;
  return { wpm: source.wpm, farnsworth: source.farnsworth, frequency: settings.frequency, volume: settings.volume };
}
