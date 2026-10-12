import { MORSE, MorsePlayer, getTiming } from './audio.js';
import { LETTERS, DIGITS, LEVELS, createPracticeGenerator, generateLessonSequence, normalizeInput, formatGroups, gradeInput } from './trainer.js';
import { LearnSession } from './learn-session.js';
import { PracticeRoundSession } from './practice-round-session.js';
import { QWERTY_ROWS, renderQwertyKeyboard } from './qwerty-keyboard.js';
import { TimedMorseInput } from './timed-morse.js';
import { decodeMorse } from './chat-codec.js';
import { generateRealWordGroups } from './real-word-bank.js';
import { PracticeRecording, ReplayPlayer } from './replay.js';
import { createChatRoom } from './chat.js';

const $ = (selector) => document.querySelector(selector);
const mobileViewport = matchMedia('(max-width: 760px)');
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (id, label, symbol, classes = '', disabled = false) => `<button id="${id}" class="button ${classes}" ${disabled ? 'disabled' : ''}>${symbol ? icon(symbol) : ''}${label}</button>`;
const clamp = (number, min, max, fallback) => Number.isFinite(Number(number)) ? Math.min(max, Math.max(min, Math.round(Number(number)))) : fallback;
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The trainer also works when storage is unavailable. */ } };

function applyTheme(theme, save = false) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  const toggle = $('#theme-toggle');
  toggle.setAttribute('aria-checked', String(selected === 'dark'));
  $('meta[name="theme-color"]').content = selected === 'dark' ? '#000000' : '#f7f6f2';
  if (save) {
    try { localStorage.setItem('morse-room-theme', selected); } catch { /* The switch also works without saved preferences. */ }
  }
}

applyTheme(document.documentElement.dataset.theme);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

const savedSound = readStorage('morse-room-sound', {});
const sound = {
  wpm: clamp(savedSound.wpm, 5, 60, 20),
  farnsworth: clamp(savedSound.farnsworth, 1, 60, 10),
  frequency: clamp(savedSound.frequency, 200, 1200, 600),
  volume: clamp(savedSound.volume, 0, 100, 50),
};
sound.farnsworth = Math.min(sound.farnsworth, sound.wpm);
const chatAudioDefaults = { wpm: 18, farnsworth: 12, frequency: 600 };
const savedChatSound = readStorage('morse-room-chat-sound', {});
const chatSound = {
  mode: savedChatSound.mode === 'custom' ? 'custom' : 'default',
  wpm: clamp(savedChatSound.wpm, 5, 60, 18),
  farnsworth: clamp(savedChatSound.farnsworth, 1, 60, 12),
  frequency: clamp(savedChatSound.frequency, 200, 1200, 600),
};
chatSound.farnsworth = Math.min(chatSound.farnsworth, chatSound.wpm);
const progressKey = `morse-room-progress:${LEVELS.map((level) => level.newCharacters).join('')}`;
const savedProgress = readStorage(progressKey, {});
const progress = {
  completed: Array.isArray(savedProgress.completed) ? savedProgress.completed.filter((level) => Number.isInteger(level) && level >= 1 && level <= 18) : [],
  best: savedProgress.best && typeof savedProgress.best === 'object' ? savedProgress.best : {},
};
let mode = 'learn';
let runId = 0;
let tutorialBusy = false;
let tutorialCharacter = '';
let toneBusy = false;
let answerBusy = '';
let answerRunId = 0;
let countdownValue = 0;
let replayViewing = false;
let replayScrubbing = false;
let replayRunId = 0;
const learn = { level: Math.min(18, Math.max(0, ...progress.completed) + 1), phase: 'intro', sequence: '', session: null, index: 0, records: [], input: '', audible: false, playing: false, countdown: false, tutorialIndex: 0, tutorialHeard: false };
const practice = { direction: 'receiving', category: 'letters', customPreset: 'manual', custom: 'QYFL', length: 'continuous', count: 50, words: 50, groupSize: 5, phase: 'idle', sequence: '', played: 0, answer: '', grading: null, session: null, mobileInput: '', round: null, roundReady: false, roundBusy: false, roundShown: false, roundFeedback: '', roundCorrect: null, morse: '' };
const mobileTrainingPanel = document.createElement('div');
mobileTrainingPanel.className = 'mobile-training';
mobileTrainingPanel.hidden = true;
$('.receiver').insertBefore(mobileTrainingPanel, $('.writing-columns'));
const roundPanel = document.createElement('div');
roundPanel.id = 'practice-round-panel';
roundPanel.className = 'practice-round-panel';
roundPanel.hidden = true;
$('.receiver').insertBefore(roundPanel, $('.writing-columns'));
const sendingPlayer = new MorsePlayer();
const sendingInput = new TimedMorseInput({
  getLetterGap: () => Math.max(500, getTiming(sound).characterGap * 1000),
  onChange: (value) => { practice.morse = value; const entry = $('#practice-morse-entry'); if (entry) entry.value = value; },
});

function mobileTrainingActive() {
  return mode === 'learn' && mobileViewport.matches && learn.phase === 'practice';
}

function roundPractice() { return mode === 'practice' && (practice.session?.roundMode ?? (practice.direction === 'sending' || practice.category !== 'custom')); }


const signals = { main: false, answer: false, replay: false };
function setSignal(source, active) {
  signals[source] = active;
  const audible = Object.values(signals).some(Boolean);
  $('#signal-light').classList.toggle('on', audible);
  $('#waveform').classList.toggle('active', audible);
}
const player = new MorsePlayer({ onSignal: (active) => setSignal('main', active) });
const answerPlayer = new MorsePlayer({ onSignal: (active) => setSignal('answer', active) });
const recording = new PracticeRecording();
const replayPlayer = new ReplayPlayer(recording, {
  onSignal: (active) => setSignal('replay', active),
  onProgress: () => renderAudioTimeline(),
  onEnded: () => updateTransport(),
});
$('#waveform').innerHTML = Array.from({ length: 31 }, (_, index) => `<i style="--bar:${[5, 9, 14, 7, 19, 12, 23, 8, 16][index % 9]}px"></i>`).join('');

function notify(text = '', success = false) {
  $('#message').textContent = text;
  $('#message').classList.toggle('success', success);
}

function cancelAudio() {
  runId += 1;
  player.stop();
  sendingPlayer.stop();
  sendingInput.stop();
  stopReplay();
  stopAnswerAudio();
  tutorialBusy = false;
  tutorialCharacter = '';
  toneBusy = false;
  learn.playing = false;
  learn.countdown = false;
  countdownValue = 0;
  $('#test-tone').disabled = false;
}

function handleAudioError(error) {
  cancelAudio();
  if (mode === 'practice' && ['countdown', 'playing', 'paused'].includes(practice.phase)) practice.phase = 'interrupted';
  notify(error?.message || 'Audio could not start. Try playing again.');
  renderActions();
  updateTransport();
}

function syncSound() {
  const current = activeSound();
  for (const [key, value] of Object.entries(current)) {
    const range = $(`#${key}-range`);
    const number = $(`#${key}-number`);
    if (key === 'farnsworth') { range.max = current.wpm; number.max = current.wpm; }
    range.disabled = number.disabled = mode === 'chat' && chatSound.mode === 'default' && key !== 'volume';
    range.value = value;
    number.value = value;
    const percent = (value - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100;
    range.style.background = `linear-gradient(to right, var(--range-fill) ${percent}%, var(--range-track) ${percent}%)`;
  }
  writeStorage('morse-room-sound', sound);
  writeStorage('morse-room-chat-sound', chatSound);
  document.body.dataset.chatAudio = chatSound.mode;
  $('.chat-audio-presets').hidden = mode !== 'chat';
  const mobileAudioSummary = $('#mobile-audio-summary');
  if (mobileAudioSummary) mobileAudioSummary.textContent = `${current.wpm} WPM · ${current.farnsworth} Farnsworth`;
  for (const preset of ['default', 'custom']) {
    const selected = chatSound.mode === preset;
    $(`#chat-audio-${preset}`).classList.toggle('active', selected);
    $(`#chat-audio-${preset}`).setAttribute('aria-pressed', String(selected));
  }
}

function activeSound() {
  return mode === 'chat' ? { ...(chatSound.mode === 'default' ? chatAudioDefaults : {
    wpm: chatSound.wpm, farnsworth: chatSound.farnsworth, frequency: chatSound.frequency,
  }), volume: sound.volume } : { ...sound };
}

for (const preset of ['default', 'custom']) {
  $(`#chat-audio-${preset}`).addEventListener('click', () => {
    chatRoom.stopAudio(); chatSound.mode = preset; syncSound();
  });
}

for (const key of Object.keys(sound)) {
  const update = (event) => {
    const input = event.target;
    if (input.value === '') { if (event.type === 'change') syncSound(); return; }
    const target = mode === 'chat' && key !== 'volume' ? chatSound : sound;
    target[key] = clamp(input.value, Number(input.min), Number(input.max), target[key]);
    target.farnsworth = Math.min(target.farnsworth, target.wpm);
    if (mode === 'chat') chatRoom.stopAudio();
    syncSound();
  };
  $(`#${key}-range`).addEventListener('input', update);
  $(`#${key}-number`).addEventListener('change', update);
}

$('#test-tone').addEventListener('click', async () => {
  if (learn.playing || learn.countdown || tutorialBusy || answerBusy || replayPlayer.isPlaying || ['countdown', 'playing', 'paused'].includes(practice.phase)) return;
  cancelAudio();
  chatRoom.stopAudio();
  const token = runId;
  toneBusy = true;
  $('#test-tone').disabled = true;
  updateTransport();
  try {
    await player.playCharacter('V', activeSound());
    if (token !== runId) return;
    toneBusy = false;
    $('#test-tone').disabled = false;
    updateTransport();
  } catch (error) { handleAudioError(error); }
});

function setMode(nextMode) {
  if (mode === nextMode) return;
  if (mode === 'practice' && ['countdown', 'playing', 'paused', 'interrupted'].includes(practice.phase)) stopPractice();
  cancelAudio();
  if (mode === 'chat') chatRoom.close();
  if (mode === 'learn' && learn.phase === 'practice') learn.audible = false;
  mode = nextMode;
  const url = new URL(location.href);
  if (mode === 'chat') url.searchParams.set('chat', '1');
  else { url.searchParams.delete('chat'); url.searchParams.delete('join'); }
  history.replaceState(null, '', url);
  notify();
  render();
}
document.querySelectorAll('.mode-button[data-mode]').forEach((element) => element.addEventListener('click', () => setMode(element.dataset.mode)));

function render() {
  document.body.dataset.mode = mode;
  document.querySelectorAll('.mode-button[data-mode]').forEach((element) => {
    const selected = element.dataset.mode === mode;
    element.classList.toggle('active', selected);
    element.setAttribute('aria-current', selected ? 'page' : 'false');
  });
  $('#page-title').textContent = mode === 'learn' ? 'Learn Morse Code' : mode === 'practice' ? 'Practice Morse Code' : mode === 'characters' ? 'Morse Characters' : 'Morse Chat Room';
  syncSound();
  $('#chat-panel').hidden = mode !== 'chat';
  $('#setup-panel').hidden = mode === 'chat' || mode === 'characters';
  if ($('#characters-panel')) $('#characters-panel').hidden = mode !== 'characters';
  roundPanel.hidden = true;
  document.body.dataset.practiceRound = 'false';
  document.body.dataset.practiceCopy = 'false';
  document.body.dataset.practiceReviewed = 'false';
  mobileTrainingPanel.hidden = true;
  document.body.dataset.trainingActive = 'false';
  if (mode === 'characters') {
    $('#view-heading').hidden = true;
    $('.receiver').hidden = true;
    $('.bottom-note').hidden = true;
    renderCharacterPanel();
    return;
  }
  if (mode === 'chat') {
    $('#view-heading').hidden = true;
    $('.receiver').hidden = true;
    $('.bottom-note').hidden = true;
    chatRoom.open();
    return;
  }
  const receiving = mode === 'practice' || ['practice', 'finished'].includes(learn.phase);
  $('.receiver').hidden = !receiving;
  $('.bottom-note').hidden = !receiving;
  renderHeading();
  renderSetup();
  renderWorkspace();
  updateTransport();
}

function renderHeading() {
  $('#view-heading').hidden = true;
  $('#view-heading').innerHTML = '';
}

function renderSetup() {
  if (mode === 'practice') { renderPracticeSetup(); return; }
  const level = LEVELS[learn.level - 1];
  const unlocked = Math.min(18, Math.max(0, ...progress.completed) + 1);
  const character = level.newCharacters[learn.tutorialIndex];
  let stage;
  if (learn.phase === 'intro') {
    stage = `<div class="lesson-stage"><h1 class="lesson-stage-eyebrow">Level ${level.number}</h1><div class="lesson-stage-characters" aria-label="${level.newCharacters.split('').join(' and ')}">${[...level.newCharacters].map((item) => `<div class="lesson-stage-character"><span class="lesson-stage-letter">${item}</span><span class="lesson-stage-morse morse-pattern" aria-label="${morseWords(item)}">${morseDisplay(item)}</span></div>`).join('')}</div><p class="lesson-stage-description">Learn these two characters, one at a time.<br>Then receive ${level.practiceCount} signals using everything you’ve learned.</p><div class="lesson-stage-actions">${button('start-lesson', `Start lesson ${level.number}`, 'play', 'primary')}</div></div>`;
  } else if (['tutorial', 'lesson-complete'].includes(learn.phase)) {
    const completed = learn.phase === 'lesson-complete';
    stage = `<div class="lesson-stage ${tutorialBusy ? 'is-listening' : ''}"><h1 class="lesson-stage-eyebrow">Level ${level.number} · Character ${learn.tutorialIndex + 1} of 2</h1><div class="tutorial-letter"><span class="lesson-stage-letter">${character}</span></div><div class="tutorial-pattern morse-pattern" aria-label="${morseWords(character)}">${morseDisplay(character)}</div><p class="tutorial-sounds">${morseWords(character)}</p><p class="lesson-stage-description" role="status">${tutorialBusy ? 'Listen to the character.' : completed ? 'You’ve heard both characters. Replay the lesson or start practice.' : learn.tutorialHeard ? 'Replay as often as you like, then listen to the next character.' : 'Play the character to continue.'}</p><div class="lesson-stage-actions">${button('replay-tutorial', tutorialBusy ? 'Playing…' : `Replay ${character}`, 'replay', '', tutorialBusy)}${completed ? `${button('replay-lesson', 'Replay lesson', 'replay', '', tutorialBusy)}${button('start-learn-practice', 'Start practice', 'arrow', 'primary', tutorialBusy)}` : button('next-tutorial', `Next: ${level.newCharacters[1]}`, 'arrow', 'primary', tutorialBusy || !learn.tutorialHeard)}</div></div>`;
  } else {
    stage = `<div class="lesson-stage lesson-stage-compact"><h1>Level ${level.number}${learn.phase === 'finished' ? '' : ' practice'}</h1><p class="lesson-stage-description">${learn.phase === 'finished' ? 'Review your copy beside the received signals. Click a received character to hear it.' : `${level.practiceCount} correct answers to complete this level. A mistake repeats the same signal.`}</p></div>`;
  }
  $('#setup-panel').innerHTML = `<div class="lesson-card">
    <div class="lesson-path"><span class="small-label">YOUR LEARNING PATH</span><div class="level-track" aria-label="18 lesson levels">${LEVELS.map((item) => `<button class="level-button ${item.number === learn.level ? 'active' : progress.completed.includes(item.number) ? 'completed' : ''}" data-level="${item.number}" ${item.number > unlocked ? 'disabled' : ''} aria-label="Level ${item.number}: ${item.newCharacters.split('').join(' and ')}${progress.completed.includes(item.number) ? ', completed' : ''}" ${item.number === learn.level ? 'aria-current="step"' : ''} title="${item.number > unlocked ? 'Complete the previous level to unlock' : `Learn ${item.newCharacters.split('').join(' and ')}`}">${item.number}</button>`).join('')}</div></div>
    ${stage}</div>`;
  document.querySelectorAll('[data-level]').forEach((element) => element.addEventListener('click', () => {
    cancelAudio();
    Object.assign(learn, { level: Number(element.dataset.level), phase: 'intro', sequence: '', session: null, index: 0, records: [], input: '', audible: false, tutorialIndex: 0, tutorialHeard: false });
    notify();
    render();
  }));
  $('#start-lesson')?.addEventListener('click', startLesson);
  $('#replay-tutorial')?.addEventListener('click', playTutorialCharacter);
  $('#replay-lesson')?.addEventListener('click', startLesson);
  $('#start-learn-practice')?.addEventListener('click', startLearnPractice);
  $('#next-tutorial')?.addEventListener('click', () => {
    if (tutorialBusy || !learn.tutorialHeard || learn.tutorialIndex !== 0) return;
    learn.tutorialIndex = 1;
    learn.tutorialHeard = false;
    playTutorialCharacter();
  });
}

function practiceLocked() { return ['countdown', 'playing', 'paused', 'ready', 'interrupted'].includes(practice.phase); }

function characterReferenceMarkup({ keyboard = false } = {}) {
  const key = (character) => `<button type="button" class="character-reference" data-reference="${character}" aria-label="Listen to ${character}: ${morseWords(character)}"><span class="reference-letter">${character}</span><span class="reference-morse" aria-hidden="true">${morseDisplay(character)}</span></button>`;
  if (keyboard) return `<div class="reference-keyboard" role="group" aria-label="Morse code keyboard">${QWERTY_ROWS.map((row) => `<div class="reference-keyboard-row">${[...row].map(key).join('')}</div>`).join('')}</div>`;
  return `<div class="character-reference-grid">${[...LETTERS + DIGITS].map(key).join('')}</div>`;
}

function bindCharacterReferences(container) {
  container.querySelectorAll('[data-reference]').forEach((element) => element.addEventListener('click', () => playReferenceCharacter(element.dataset.reference, element)));
}

function renderCharacterPanel() {
  const panel = $('#characters-panel');
  if (!panel) return;
  panel.innerHTML = `<section class="character-reference-panel"><div class="reference-heading"><h2>Letters and numbers</h2><p>Tap a key to hear its Morse code.</p></div>${characterReferenceMarkup({ keyboard: true })}</section>`;
  bindCharacterReferences(panel);
}

function customPracticePool() {
  return ({ letters: LETTERS, numbers: DIGITS, all: LETTERS + DIGITS })[practice.customPreset] ?? practice.custom;
}

function renderPracticeSetup() {
  const locked = practiceLocked();
  const disabled = locked ? 'disabled' : '';
  const custom = practice.category === 'custom';
  const grouped = ['words', 'real-words'].includes(practice.length);
  const real = practice.length === 'real-words';
  $('#setup-panel').innerHTML = `<div class="practice-card"><div class="practice-card-top"><section class="practice-setup-section"><h2 class="setup-section-heading">Mode</h2><div class="segmented practice-direction" role="group" aria-label="Practice direction">${[['receiving', 'Receiving', 'headphones', 'Listen & identify'], ['sending', 'Sending', 'keyboard', 'Write the signal']].map(([value, label, symbol, note]) => `<button type="button" data-direction="${value}" aria-pressed="${practice.direction === value}" class="${practice.direction === value ? 'active' : ''}" ${disabled}><span class="setup-choice-icon" aria-hidden="true">${icon(symbol)}</span><span class="setup-choice-copy"><span class="setup-choice-label">${label}</span><span class="setup-choice-note">${note}</span></span></button>`).join('')}</div></section><section class="practice-setup-section"><h2 class="setup-section-heading">Practice</h2><div class="segmented practice-category" role="group" aria-label="Practice characters">${[['letters', 'Letters', 'Aa'], ['numbers', 'Numbers', '09'], ['custom', 'Custom', icon('shuffle')]].map(([value, label, symbol]) => `<button type="button" data-category="${value}" aria-pressed="${practice.category === value}" class="${practice.category === value ? 'active' : ''}" ${disabled}><span class="setup-choice-icon" aria-hidden="true">${symbol}</span><span class="setup-choice-label">${label}</span></button>`).join('')}</div></section></div>
    <div class="practice-fields">${custom && !real ? `<div class="field"><label for="custom-characters">Your character selection</label><div class="custom-pool-presets segmented" role="group" aria-label="Character selection">${[['manual', 'Custom'], ['letters', 'All letters'], ['numbers', 'All numbers'], ['all', 'All']].map(([value, label]) => `<button type="button" data-custom-preset="${value}" class="${practice.customPreset === value ? 'active' : ''}" aria-pressed="${practice.customPreset === value}" ${disabled}>${label}</button>`).join('')}</div><input id="custom-characters" type="text" value="${escapeHTML(customPracticePool())}" maxlength="100" autocomplete="off" spellcheck="false" ${locked || practice.customPreset !== 'manual' ? 'disabled' : ''}><p>Practice only these letters and numbers.</p></div>` : ''}
    <div class="field session-length-field"><label for="session-length">Session length</label><select id="session-length" ${disabled}><option value="continuous" ${practice.length === 'continuous' ? 'selected' : ''}>Unlimited</option><option value="characters" ${practice.length === 'characters' ? 'selected' : ''}>Set number of characters</option>${custom ? `<option value="words" ${practice.length === 'words' ? 'selected' : ''}>Random word groups</option><option value="real-words" ${real ? 'selected' : ''}>Real word groups</option>` : ''}</select><div class="mobile-session-options ${custom ? 'custom-session-options' : ''}" role="group" aria-label="Session length">${[['continuous', 'Unlimited'], ['characters', custom ? 'Characters' : 'Set a limit'], ...(custom ? [['words', 'Random words'], ['real-words', 'Real words']] : [])].map(([value, label]) => `<button type="button" data-length="${value}" aria-pressed="${practice.length === value}" class="${practice.length === value ? 'active' : ''}" ${disabled}>${label}</button>`).join('')}</div></div>
    ${grouped ? `<div class="field practice-word-fields"><div class="double-fields"><div><label for="word-count">Words</label><input id="word-count" type="number" min="${real ? 2 : 1}" max="${real ? 50 : 2000}" step="1" value="${practice.words}" ${disabled}></div><div><label for="group-size">Letters per word</label><input id="group-size" type="number" min="${real ? 2 : 1}" max="${real ? 10 : 50}" step="1" value="${practice.groupSize}" ${disabled}></div></div><p>${real ? 'English words, including dictionary words. Character selection does not limit real words.' : `${practice.words * practice.groupSize} characters, with a gap between words.`}</p></div>` : practice.length === 'characters' ? `<div class="field practice-count-field"><label for="character-count">Characters</label><input id="character-count" type="number" min="1" max="10000" step="1" value="${practice.count}" ${disabled}></div>` : ''}</div>
    <section class="character-reference-panel practice-character-reference" aria-labelledby="characters-heading"><div class="reference-heading"><h2 id="characters-heading">Characters</h2><p>Click a character or press its key outside a text field to hear it.</p></div>${characterReferenceMarkup()}</section></div>`;
  const choose = () => { cancelAudio(); practice.session = null; practice.round = null; practice.phase = 'idle'; notify(); render(); };
  document.querySelectorAll('[data-direction]').forEach((element) => element.addEventListener('click', () => { practice.direction = element.dataset.direction; choose(); }));
  document.querySelectorAll('[data-category]').forEach((element) => element.addEventListener('click', () => { practice.category = element.dataset.category; if (practice.category !== 'custom' && grouped) practice.length = 'continuous'; choose(); }));
  const selectLength = (value) => { practice.length = value; if (practice.length === 'real-words') { practice.words = clamp(practice.words, 2, 50, 10); practice.groupSize = clamp(practice.groupSize, 2, 10, 5); } renderPracticeSetup(); };
  $('#session-length').addEventListener('change', (event) => selectLength(event.target.value));
  document.querySelectorAll('[data-length]').forEach((element) => element.addEventListener('click', () => selectLength(element.dataset.length)));
  document.querySelectorAll('[data-custom-preset]').forEach((element) => element.addEventListener('click', () => {
    practice.customPreset = element.dataset.customPreset === practice.customPreset ? 'manual' : element.dataset.customPreset;
    choose();
    if (practice.customPreset === 'manual') $('#custom-characters')?.focus({ preventScroll: true });
  }));
  $('#custom-characters')?.addEventListener('input', (event) => { practice.customPreset = 'manual'; practice.custom = event.target.value.toUpperCase(); });
  bindCharacterReferences($('#setup-panel'));
  for (const [id, key] of [['character-count', 'count'], ['word-count', 'words'], ['group-size', 'groupSize']]) {
    $(`#${id}`)?.addEventListener('input', (event) => { practice[key] = Number(event.target.value); });
    $(`#${id}`)?.addEventListener('change', () => renderPracticeSetup());
  }
}

function emptyAnswers(heading, description) {
  return `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">?</span><h3>${heading}</h3><p>${description}</p></div>`;
}

function copyCell(actual, status, index) {
  return `<span class="copy-cell ${status}" aria-label="Character ${index + 1}: ${escapeHTML(actual || 'missing')}, ${status}"><span class="cell-index">${index + 1}</span>${escapeHTML(actual || '·')}${status === 'correct' ? icon('check') : icon('close')}</span>`;
}

function morseDisplay(character) {
  return (MORSE[character] || '').replaceAll('-', '−').replaceAll('.', '·');
}

function morseWords(character) {
  return (MORSE[character] || '').split('').map((mark) => mark === '.' ? 'dit' : 'dah').join(' · ');
}

function answerCell(expected, status, index) {
  if (!MORSE[expected]) return `<span class="answer-cell ${status}" aria-label="Extra input, no received character"><span class="cell-index">${index + 1}</span>·</span>`;
  return `<button type="button" class="answer-cell has-morse ${status}" data-answer="${expected}" aria-label="Answer ${index + 1}: ${expected}, ${morseWords(expected)}. Click to listen." title="Listen to ${expected}"><span class="cell-index">${index + 1}</span><span class="answer-letter">${expected}</span><span class="answer-morse" aria-hidden="true">${morseDisplay(expected)}</span></button>`;
}

function stopAnswerAudio() {
  answerRunId += 1;
  answerPlayer.stop();
  answerBusy = '';
  document.querySelectorAll('[data-answer].playing,[data-reference].playing').forEach((cell) => cell.classList.remove('playing'));
}

async function playAnswerCharacter(character, cell) {
  if (!MORSE[character] || learn.playing || learn.countdown || tutorialBusy || toneBusy || (mode === 'practice' && practice.phase !== 'reviewed')) return;
  stopReplay();
  stopAnswerAudio();
  const token = answerRunId;
  answerBusy = character;
  cell.classList.add('playing');
  renderActions();
  updateTransport();
  try {
    await answerPlayer.playCharacter(character, { ...sound });
    if (token !== answerRunId) return;
    answerBusy = '';
    cell.classList.remove('playing');
    renderActions();
    updateTransport();
    if (mode === 'learn' && learn.phase === 'practice') $('#letter-entry')?.focus({ preventScroll: true });
  } catch (error) {
    if (token !== answerRunId) return;
    stopAnswerAudio();
    notify(error.message || 'This answer could not be replayed. Try again.');
    renderActions();
    updateTransport();
  }
}

async function playReferenceCharacter(character, cell) {
  if (!MORSE[character] || learn.playing || learn.countdown || tutorialBusy || toneBusy || replayPlayer.isPlaying || (mode === 'practice' && ['countdown', 'playing'].includes(practice.phase))) return;
  stopReplay();
  stopAnswerAudio();
  const token = answerRunId;
  answerBusy = character;
  cell.classList.add('playing');
  updateTransport();
  try {
    await answerPlayer.playCharacter(character, { ...sound });
    if (token !== answerRunId) return;
    answerBusy = '';
    cell.classList.remove('playing');
    updateTransport();
  } catch (error) {
    if (token !== answerRunId) return;
    stopAnswerAudio();
    notify(error.message || 'This character could not be played. Try again.');
    updateTransport();
  }
}

function stopReplay() {
  replayRunId += 1;
  replayPlayer.stop();
  replayViewing = false;
  replayScrubbing = false;
  renderAudioTimeline();
}

function audioTime(seconds) {
  const tenths = Math.max(0, Math.floor(seconds * 10));
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

function renderAudioTimeline() {
  const bar = $('#practice-audio-bar');
  if (!bar) return;
  bar.hidden = mode !== 'practice' || roundPractice();
  if (mode !== 'practice' || roundPractice()) return;
  if (!$('#audio-position')) {
    bar.innerHTML = `<div class="audio-bar-header"><label for="audio-position">Session audio</label><span id="replay-clock"></span></div><div class="audio-bar-controls">${button('toggle-replay', 'Replay', 'play', 'quiet audio-replay-button')}<input id="audio-position" type="range" min="0" max="0" step="0.01" value="0" aria-label="Replay received session audio"></div><p class="audio-bar-help"></p>`;
    $('#toggle-replay').addEventListener('click', toggleAudioReplay);
    $('#audio-position').addEventListener('pointerdown', () => { replayScrubbing = true; });
    $('#audio-position').addEventListener('pointerup', () => { replayScrubbing = false; });
    $('#audio-position').addEventListener('pointercancel', () => { replayScrubbing = false; renderAudioTimeline(); });
    $('#audio-position').addEventListener('input', (event) => {
      replayScrubbing = true;
      $('#replay-clock').textContent = `${audioTime(Number(event.target.value))} / ${audioTime(recording.duration)}`;
    });
    $('#audio-position').addEventListener('change', (event) => {
      replayScrubbing = false;
      startAudioReplay(Number(event.target.value));
    });
    $('#audio-position').addEventListener('blur', () => { replayScrubbing = false; renderAudioTimeline(); });
  }
  const position = replayViewing ? replayPlayer.position : recording.duration;
  const disabled = !recording.characterCount || toneBusy || Boolean(answerBusy) || practice.phase === 'countdown';
  const slider = $('#audio-position');
  slider.max = recording.duration;
  slider.disabled = disabled;
  if (!replayScrubbing) {
    slider.value = position;
    $('#replay-clock').textContent = `${audioTime(position)} / ${audioTime(recording.duration)}`;
  }
  slider.setAttribute('aria-valuetext', `${audioTime(Number(slider.value))} of ${audioTime(recording.duration)}`);
  const replayButton = $('#toggle-replay');
  replayButton.disabled = disabled;
  replayButton.innerHTML = `${icon(replayPlayer.isPlaying ? 'pause' : 'play')}${replayPlayer.isPlaying ? 'Pause replay' : replayPlayer.isPaused ? 'Resume replay' : 'Replay'}`;
  $('.audio-bar-help').textContent = !recording.characterCount
    ? 'Received audio will appear here after the first character.'
    : ['playing', 'paused'].includes(practice.phase)
      ? 'Drag to replay received audio. Resume continues the test from your saved place.'
      : 'Drag to any point to replay the audio from this session.';
}

async function startAudioReplay(offset = 0) {
  if (mode !== 'practice' || !recording.characterCount || practice.phase === 'countdown' || toneBusy || answerBusy) return;
  if (practice.phase === 'playing') {
    if (!player.pause()) return;
    practice.resumePhase = 'playing';
    practice.phase = 'paused';
    renderActions();
    syncMobileTrainingControls();
  }
  stopAnswerAudio();
  replayViewing = true;
  const token = ++replayRunId;
  try {
    const playback = replayPlayer.play(offset, { ...sound });
    updateTransport();
    await playback;
    if (token === replayRunId) updateTransport();
  } catch (error) {
    if (token !== replayRunId) return;
    stopReplay();
    notify(error.message || 'Session audio could not be replayed. Try again.');
    updateTransport();
  }
}

function previewPracticeKey(event) {
  if (mode !== 'practice' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return;
  const character = event.key.toUpperCase();
  if (!/^[A-Z0-9]$/.test(character)) return;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.isContentEditable || target?.closest('input,textarea,select,[role="textbox"]')) return;
  const cell = $('#setup-panel').querySelector(`[data-reference="${character}"]`);
  if (!cell) return;
  if (['countdown', 'playing'].includes(practice.phase)) {
    if (roundPractice()) pauseRoundPractice();
    else {
      if (!player.pause() && practice.phase !== 'countdown') return;
      practice.resumePhase = practice.phase;
      practice.phase = 'paused';
      renderActions();
    }
  }
  if (toneBusy) cancelAudio();
  if (replayPlayer.isPlaying) stopReplay();
  event.preventDefault();
  playReferenceCharacter(character, cell);
}

function toggleAudioReplay() {
  if (replayPlayer.isPlaying) {
    replayPlayer.pause();
    updateTransport();
  } else if (replayPlayer.isPaused) {
    replayPlayer.resume();
    updateTransport();
  } else {
    const offset = replayViewing && replayPlayer.position < recording.duration ? replayPlayer.position : 0;
    startAudioReplay(offset);
  }
}

$('#answer-panel').addEventListener('click', (event) => {
  const cell = event.target.closest('[data-answer]');
  if (cell && !cell.disabled) playAnswerCharacter(cell.dataset.answer, cell);
});

function renderWorkspace() {
  const feedback = $('#session-feedback');
  feedback.hidden = true;
  feedback.innerHTML = '';
  if (mode === 'learn') renderLearnWorkspace(); else renderPracticeWorkspace();
  renderActions();
}

function renderMobileTraining() {
  const active = mobileTrainingActive();
  mobileTrainingPanel.hidden = !active;
  document.body.dataset.trainingActive = String(Boolean(active));
  if (!active) { mobileTrainingPanel.innerHTML = ''; return; }
  const total = LEVELS[learn.level - 1].practiceCount;
  const last = learn.records.at(-1);
  mobileTrainingPanel.innerHTML = `<p class="mobile-training-status" role="status" aria-live="polite"></p><div class="mobile-entry-row"><input id="letter-entry" class="mobile-character-entry" type="text" readonly inputmode="none" autocomplete="off" aria-label="Your answer to the current signal" value="${escapeHTML(learn.input)}" placeholder="?"><button id="replay-letter" class="button entry-replay" aria-label="Replay the current signal">${icon('replay')}<span>Replay</span></button></div><p class="mobile-training-copy">Signal ${Math.min(learn.index + 1, total)} of ${total}<span>${learn.index} correct</span></p>${last ? `<p class="mobile-training-feedback ${last.correct ? 'correct' : 'incorrect'}"><span class="mobile-training-feedback-pattern" aria-label="Previous answer ${last.expected}: ${morseWords(last.expected)}">${last.expected} <span class="morse-pattern" aria-hidden="true">${morseDisplay(last.expected)}</span></span>${last.correct ? 'Correct. Listen to the next signal.' : 'Try the same signal again.'}</p>` : ''}${renderQwertyKeyboard()}`;
  $('#replay-letter').addEventListener('click', playLearnCharacter);
  mobileTrainingPanel.querySelectorAll('[data-training-key]').forEach((key) => key.addEventListener('click', () => submitMobileCharacter(key.dataset.trainingKey)));
  syncMobileTrainingControls();
}

function syncMobileTrainingControls() {
  if (!mobileTrainingPanel.hidden) {
    const waiting = learn.audible && !learn.playing && !learn.countdown && !answerBusy;
    mobileTrainingPanel.querySelectorAll('[data-training-key]').forEach((key) => { key.disabled = !waiting; });
    const replay = mobileTrainingPanel.querySelector('.entry-replay');
    if (replay) replay.disabled = learn.playing || learn.countdown || Boolean(answerBusy);
    mobileTrainingPanel.querySelector('.mobile-training-status').textContent = learn.countdown ? 'Get ready to listen.' : learn.playing ? 'Listen to the signal.' : waiting ? 'Tap the character you heard.' : 'Replay the signal to continue.';
  }
  syncPracticeRoundControls();
}

function submitMobileCharacter(character) {
  if (!mobileTrainingActive() || !/^[A-Z0-9]$/.test(character) || !learn.audible || learn.playing || learn.countdown || answerBusy) return;
  learn.input = character;
  checkLearn();
}

function renderLearnWorkspace() {
  const level = LEVELS[learn.level - 1];
  $('#keyboard-note').innerHTML = mobileViewport.matches ? '' : `Your shortcuts <kbd>Enter</kbd> check and continue <kbd>Alt + R</kbd> replay`;
  renderMobileTraining();
  if (!['practice', 'finished'].includes(learn.phase)) {
    $('#copy-panel').innerHTML = '';
    $('#answer-panel').innerHTML = '';
    return;
  }
  const copies = learn.records.map((record) => copyCell(record.actual, record.correct ? 'correct' : 'incorrect', record.position - 1)).join('');
  const answers = learn.records.map((record) => answerCell(record.expected, record.correct ? 'correct' : 'incorrect', record.position - 1)).join('');
  if (learn.phase === 'finished') {
    const accuracy = Math.round(level.practiceCount / learn.records.length * 100);
    $('#copy-panel').innerHTML = `<p class="review-label">Your submitted copy</p><div class="learn-copy-list">${copies}</div>`;
    $('#answer-panel').innerHTML = `<p class="review-label">Received characters</p><div class="learn-answer-list">${answers}</div><div class="answer-legend"><span>Correct</span><span>Retried</span></div>`;
    $('#session-feedback').hidden = false;
    $('#session-feedback').innerHTML = `<div class="completion-card"><span class="completion-icon">${icon('check')}</span><h3>Level ${level.number} complete</h3><p>Well done. You’ve received all ${level.practiceCount} signals correctly.<br>${level.number === 18 ? 'You’ve learned all 26 letters and 10 numbers.' : `Level ${level.number + 1} is now unlocked.`}</p><div class="score">${level.practiceCount} / ${level.practiceCount} passed · ${learn.records.length} attempts · ${accuracy}% accuracy</div></div>`;
    return;
  }
  const last = learn.records.at(-1);
  $('#copy-panel').innerHTML = mobileTrainingActive() ? `<div class="learn-copy-list">${copies}</div>` : `${copies ? `<div class="learn-copy-list">${copies}</div>` : ''}
    <div class="entry-row"><div class="letter-input-controls"><input id="letter-entry" class="letter-entry" type="text" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type the character you hear" value="${escapeHTML(learn.input)}"><button id="replay-letter" class="button entry-replay" aria-label="Replay the current signal" title="Replay the current signal">${icon('replay')}<span class="entry-replay-label">Replay</span></button></div><small>Listen to signal ${learn.index + 1} of ${level.practiceCount}.<br>Type one character, then press <kbd>Enter</kbd>.</small></div>`;
  $('#session-feedback').hidden = mobileTrainingActive();
  $('#session-feedback').innerHTML = `<p class="lesson-feedback ${last ? last.correct ? 'correct' : 'incorrect' : ''}">${last ? last.correct ? `Correct. Now receive signal ${learn.index + 1}.` : `You copied ${escapeHTML(last.actual)}. The signal was ${last.expected}. Signal ${last.position} will repeat until you get it right.` : 'Take your time. You can replay the signal.'}</p>`;
  $('#answer-panel').innerHTML = answers ? `<div class="learn-answer-list">${answers}</div><p class="review-label" style="margin-top:12px">Click a character to hear it again.</p><div class="answer-legend"><span>Correct</span><span>Retried</span></div>` : emptyAnswers('Listen first. Then check.', 'Press Enter after typing a character to reveal its letter and Morse symbols here.');
  const entry = $('#letter-entry');
  if (!mobileTrainingActive()) $('#replay-letter').addEventListener('click', playLearnCharacter);
  if (entry && !mobileTrainingActive()) {
    entry.addEventListener('input', (event) => { learn.input = event.target.value.toUpperCase(); });
    entry.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.isComposing) checkLearn(); } });
    entry.focus({ preventScroll: true });
  }
  for (const panel of document.querySelectorAll('.learn-copy-list,.learn-answer-list')) panel.scrollTop = panel.scrollHeight;
}

function renderPracticeWorkspace() {
  document.body.dataset.practiceRound = String(roundPractice());
  document.body.dataset.practiceCopy = String(!roundPractice());
  document.body.dataset.practiceReviewed = String(practice.phase === 'reviewed');
  if (roundPractice()) { renderPracticeRound(); return; }
  roundPanel.hidden = true;
  roundPanel.innerHTML = '';
  const reviewed = practice.phase === 'reviewed';
  const groupSize = practice.session?.groupSize || 0;
  $('#keyboard-note').innerHTML = mobileViewport.matches ? '' : `Your shortcuts <kbd>Alt + P</kbd> pause / resume <kbd>Ctrl + Enter</kbd> submit`;
  renderMobileTraining();
  if (reviewed) {
    const grade = practice.grading;
    $('#copy-panel').innerHTML = `<p class="review-label">Your submitted copy</p><div class="result-grid">${grade.rows.map((row, index) => `${groupSize && row.expectedIndex !== null && row.expectedIndex > 0 && row.expectedIndex % groupSize === 0 ? '<span class="result-word-break"></span>' : ''}${copyCell(row.actual, row.status, index)}`).join('')}</div><div class="answer-legend"><span>Correct</span><span>Wrong or missed</span><span>Extra input</span></div>`;
    $('#answer-panel').innerHTML = `<p class="review-label">Received characters</p><div class="result-grid">${grade.rows.map((row, index) => `${groupSize && row.expectedIndex !== null && row.expectedIndex > 0 && row.expectedIndex % groupSize === 0 ? '<span class="result-word-break"></span>' : ''}${answerCell(row.expected, row.status, index)}`).join('')}</div>`;
    $('#session-feedback').hidden = false;
    $('#session-feedback').innerHTML = `<div class="session-result"><strong class="session-result-score">${grade.total || grade.extra ? grade.accuracy : 0}%</strong><h3>Practice checked</h3><p>${grade.correct} of ${grade.total} received correctly</p><p class="session-result-details">${normalizeInput(practice.answer).length} typed · ${practice.played} received<br>${grade.incorrect} wrong · ${grade.missing} missed · ${grade.extra} extra</p>${grade.total === 0 ? '<p>No complete characters were played. Start again when you’re ready.</p>' : ''}</div>`;
    return;
  }
  $('#copy-panel').innerHTML = `<textarea id="practice-copy" class="practice-textarea" spellcheck="false" autocomplete="off" autocapitalize="characters" aria-label="Type the Morse characters you hear" ${practice.phase === 'idle' ? 'disabled' : ''} placeholder="${practice.phase === 'idle' ? 'Start a session below.\nYour listening practice begins here.' : groupSize ? `Keep typing. A space is added every ${groupSize} characters.` : 'Type what you hear. Spaces are optional.'}">${escapeHTML(practice.answer)}</textarea><div class="textarea-meta"><span id="typed-counter">${normalizeInput(practice.answer).length} typed</span><span>${groupSize ? `${groupSize} letters per word` : 'Spaces don’t affect your score'}</span></div>`;
  $('#answer-panel').innerHTML = emptyAnswers(practice.phase === 'ready' ? 'Ready to check your copy?' : practice.phase === 'paused' ? 'Take your time.' : 'Keep your ears on the signal.', practice.phase === 'ready' ? 'The audio is finished. Press Submit to reveal and compare your answers.' : 'Answers stay hidden until you submit a finished run or press Stop.');
  $('#practice-copy').addEventListener('input', (event) => {
    const input = event.target;
    if (groupSize) {
      const caret = input.selectionStart;
      const beforeCaret = normalizeInput(input.value.slice(0, caret)).length;
      let grouped = formatGroups(input.value, groupSize);
      if (normalizeInput(input.value).length > 0 && normalizeInput(input.value).length % groupSize === 0) grouped += ' ';
      input.value = grouped;
      const position = beforeCaret + Math.floor(beforeCaret / groupSize);
      input.setSelectionRange(position, position);
    }
    practice.answer = input.value;
    $('#typed-counter').textContent = `${normalizeInput(input.value).length} typed`;
  });
  $('#practice-copy').addEventListener('beforeinput', (event) => {
    if (!groupSize) return;
    const input = event.target;
    const caret = input.selectionStart;
    if (caret !== input.selectionEnd) return;
    // Delete a letter together with its automatic separator, so Backspace cannot
    // get stuck repeatedly removing a space that formatting immediately restores.
    if (event.inputType === 'deleteContentBackward' && caret > 1 && /\s/.test(input.value[caret - 1])) {
      event.preventDefault();
      input.value = input.value.slice(0, caret - 2) + input.value.slice(caret);
      input.setSelectionRange(caret - 2, caret - 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (event.inputType === 'deleteContentForward' && /\s/.test(input.value[caret] || '') && caret + 1 < input.value.length) {
      event.preventDefault();
      input.value = input.value.slice(0, caret) + input.value.slice(caret + 2);
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function renderActions() {
  renderAudioTimeline();
  $('#receiver-actions').hidden = mode === 'learn' && mobileTrainingActive();
  if (mode === 'practice' && roundPractice()) { renderRoundActions(); return; }
  if (mode === 'learn') {
    if (learn.phase === 'practice') {
      const busy = learn.playing || learn.countdown || Boolean(answerBusy);
      if ($('#replay-letter')) $('#replay-letter').disabled = busy;
      $('#receiver-actions').innerHTML = mobileTrainingActive() ? '<span class="action-help">Tap your answer. Mistakes repeat the same signal.</span>' : `<span class="action-help">Press <kbd>Enter</kbd> to check. The next signal plays automatically.</span>${button('check-letter', 'Check letter', 'check', 'primary', !learn.audible || busy)}`;
      $('#check-letter')?.addEventListener('click', checkLearn);
    } else if (learn.phase === 'finished') {
      $('#receiver-actions').innerHTML = `<div class="action-group">${button('retry-level', 'Practise this level again', 'replay')}</div><span class="action-help">${learn.level === 18 ? 'All 18 levels complete. Keep listening in Practice.' : 'Your progress has been saved.'}</span>${button('advance-level', learn.level === 18 ? 'Open Practice' : `Go to level ${learn.level + 1}`, 'arrow', 'primary')}`;
      $('#retry-level').addEventListener('click', startLearnPractice);
      $('#advance-level').addEventListener('click', () => {
        cancelAudio();
        if (learn.level === 18) { mode = 'practice'; render(); return; }
        learn.level += 1;
        learn.phase = 'intro';
        learn.records = [];
        learn.tutorialIndex = 0;
        learn.tutorialHeard = false;
        render();
      });
    } else $('#receiver-actions').innerHTML = '';
  } else {
    const active = ['countdown', 'playing', 'paused'].includes(practice.phase);
    const ready = practice.phase === 'ready';
    const interrupted = practice.phase === 'interrupted';
    $('#receiver-actions').innerHTML = active
      ? `<div class="action-group">${button('pause-practice', practice.phase === 'paused' ? 'Resume' : 'Pause', practice.phase === 'paused' ? 'play' : 'pause')}${button('stop-practice', 'Stop & check', 'stop', 'quiet stop')}</div><span class="action-help">${practice.phase === 'paused' ? 'Your place is saved. Answers are still hidden.' : practice.session?.mobile ? 'Copy what you hear.' : 'Copy continuously. Stop whenever you’re ready.'}</span>${button('submit-practice', 'Submit copy', 'check', 'primary', true)}`
      : ready || interrupted
        ? `<div class="action-group">${button('stop-practice', 'Stop & check', 'stop', 'quiet stop')}</div><span class="action-help">${ready ? 'Audio complete. You can finish typing before submitting.' : 'Audio stopped. Check the characters you heard.'}</span>${button('submit-practice', 'Submit copy', 'check', 'primary')}`
        : `<div class="action-group">${button('start-practice', practice.phase === 'reviewed' ? 'Start another session' : 'Start listening', 'play', 'primary')}</div><span class="action-help">${practice.phase === 'reviewed' ? 'A fresh sequence, a fresh start.' : 'Listen continuously. Check when you’re done.'}</span>`;
    $('#start-practice')?.addEventListener('click', startPractice);
    $('#pause-practice')?.addEventListener('click', pausePractice);
    $('#stop-practice')?.addEventListener('click', stopPractice);
    $('#submit-practice')?.addEventListener('click', submitPractice);
  }
}

function updateTransport() {
  document.body.dataset.practicePhase = practice.phase;
  let label = 'Ready when you are';
  let count = '';
  let percentage = 0;
  if (mode === 'learn') {
    const level = LEVELS[learn.level - 1];
    if (['intro', 'tutorial', 'lesson-complete'].includes(learn.phase)) label = tutorialBusy ? `Tutorial: listening to ${tutorialCharacter}` : 'Ready when you are';
    else if (learn.phase === 'finished') label = `Level ${level.number} results`;
    else label = learn.countdown ? `Starting in ${countdownValue}…` : learn.playing ? 'Listen to the signal…' : learn.audible ? 'Your turn to copy' : 'Replay the signal to continue';
    count = `${learn.index} / ${level.practiceCount} correct`;
    percentage = learn.index / level.practiceCount * 100;
  } else {
    label = ({ idle: 'Ready when you are', countdown: `Starting in ${countdownValue}…`, playing: 'Listening. Keep copying…', paused: 'Paused. Your place is saved.', ready: 'Audio complete. Submit when ready.', reviewed: 'Your copy has been checked.', interrupted: 'Playback interrupted.' })[practice.phase];
    count = practice.session ? practice.session.total ? `${practice.played} / ${practice.session.total} characters` : `${practice.played} characters received` : 'Your own pace';
    percentage = practice.session?.total ? practice.played / practice.session.total * 100 : practice.phase === 'reviewed' ? 100 : 0;
  }
  if (mode === 'practice' && roundPractice()) {
    label = practice.phase === 'countdown' ? `Starting in ${countdownValue}…` : practice.phase === 'paused' ? 'Paused' : practice.phase === 'reviewed' ? practice.round?.completed ? 'Session complete' : 'Session stopped' : practice.roundBusy ? 'Listen to the signal…' : practice.phase === 'playing' ? practice.session?.direction === 'sending' ? 'Your turn to send' : 'Choose your answer' : 'Ready';
    const total = practice.round?.total;
    const correct = practice.round?.index || 0;
    const unit = practice.session?.words ? 'words' : 'characters';
    count = total ? `${correct} / ${total} ${unit} correct` : `${correct} correct`;
    percentage = total ? correct / total * 100 : 0;
  }
  if (answerBusy) label = `Listening to character ${answerBusy}…`;
  if (replayPlayer.isPlaying) label = 'Replaying session audio…';
  if (toneBusy) label = 'Testing your sound…';
  $('#signal-label').textContent = label;
  $('#session-counter').textContent = count;
  $('#session-progress').style.width = `${percentage}%`;
  $('#session-countdown').hidden = countdownValue === 0;
  $('#countdown-number').textContent = countdownValue;
  const countdownPaused = mode === 'practice' && practice.phase === 'paused' && practice.resumePhase === 'countdown';
  $('#session-countdown').classList.toggle('is-paused', countdownPaused);
  $('#session-countdown .countdown-copy b').textContent = countdownPaused ? 'Countdown paused' : mode === 'practice' && practice.direction === 'sending' ? 'Get ready to send' : 'Get ready to receive';
  $('#test-tone').disabled = toneBusy || tutorialBusy || learn.playing || learn.countdown || Boolean(answerBusy) || replayPlayer.isPlaying || ['countdown', 'playing', 'paused'].includes(practice.phase);
  document.querySelectorAll('[data-answer]').forEach((cell) => { cell.disabled = learn.playing || learn.countdown || tutorialBusy || toneBusy || (mode === 'practice' && practice.phase !== 'reviewed'); });
  document.querySelectorAll('[data-reference]').forEach((cell) => { cell.disabled = learn.playing || learn.countdown || tutorialBusy || toneBusy || replayPlayer.isPlaying || (mode === 'practice' && ['countdown', 'playing'].includes(practice.phase)); });
  renderAudioTimeline();
  syncMobileTrainingControls();
}

function startLesson() {
  cancelAudio();
  Object.assign(learn, { phase: 'tutorial', tutorialIndex: 0, tutorialHeard: false, session: null, sequence: '', index: 0, records: [], input: '', audible: false });
  notify();
  render();
  playTutorialCharacter();
}

async function playTutorialCharacter() {
  if (mode !== 'learn' || tutorialBusy || !['tutorial', 'lesson-complete'].includes(learn.phase)) return;
  cancelAudio();
  const token = runId;
  tutorialBusy = true;
  tutorialCharacter = LEVELS[learn.level - 1].newCharacters[learn.tutorialIndex];
  notify();
  renderSetup();
  updateTransport();
  try {
    if (!await player.playCharacter(tutorialCharacter, { ...sound }) || token !== runId) return;
    tutorialBusy = false;
    learn.tutorialHeard = true;
    if (learn.tutorialIndex === 1) learn.phase = 'lesson-complete';
    tutorialCharacter = '';
    renderSetup();
    updateTransport();
  } catch (error) { if (token === runId) { handleAudioError(error); renderSetup(); } }
}

async function playCountdown(token) {
  for (let number = 5; number >= 1; number -= 1) {
    if (token !== runId) return false;
    countdownValue = number;
    updateTransport();
    const waiting = player.wait(1);
    if (mode === 'practice' && practice.phase === 'paused') practice.roundAudioPaused = player.pause();
    if (!await waiting || token !== runId) return false;
  }
  countdownValue = 0;
  updateTransport();
  return true;
}

async function startLearnPractice() {
  cancelAudio();
  const token = runId;
  const session = new LearnSession(generateLessonSequence(learn.level));
  Object.assign(learn, { phase: 'practice', sequence: session.sequence, session, index: 0, records: session.attempts, input: '', audible: false, playing: false, countdown: true });
  countdownValue = 5;
  notify();
  render();
  try {
    // Unlock within the Start click, before the five-second waiting period.
    await player.prepare();
    if (token !== runId || !await playCountdown(token)) return;
    learn.countdown = false;
    playLearnCharacter();
  } catch (error) { if (token === runId) handleAudioError(error); }
}

async function playLearnCharacter() {
  if (mode !== 'learn' || learn.phase !== 'practice' || learn.playing || learn.countdown) return;
  cancelAudio();
  const token = runId;
  learn.playing = true;
  learn.audible = false;
  renderActions();
  updateTransport();
  try {
    const completed = await player.playCharacter(learn.session.currentCharacter, { ...sound });
    if (!completed || token !== runId) return;
    learn.playing = false;
    learn.audible = true;
    renderActions();
    updateTransport();
    $('#letter-entry')?.focus({ preventScroll: true });
  } catch (error) { if (token === runId) handleAudioError(error); }
}

function checkLearn() {
  if (mode !== 'learn' || learn.phase !== 'practice' || learn.playing || learn.countdown || answerBusy || !learn.audible) return;
  const actual = normalizeInput(learn.input);
  if (!actual) { notify('Type the character you heard before checking.'); $('#letter-entry')?.focus(); return; }
  if (actual.length !== 1) { notify('Type exactly one character before checking.'); $('#letter-entry')?.focus(); return; }
  learn.session.submit(actual);
  learn.index = learn.session.index;
  learn.input = '';
  learn.audible = false;
  notify();
  if (learn.session.completed) {
    learn.phase = 'finished';
    if (!progress.completed.includes(learn.level)) progress.completed.push(learn.level);
    const score = Math.round(learn.records.filter((record) => record.correct).length / learn.records.length * 100);
    progress.best[learn.level] = Math.max(Number(progress.best[learn.level]) || 0, score);
    writeStorage(progressKey, progress);
    render();
    return;
  }
  renderWorkspace();
  updateTransport();
  playLearnCharacter();
}

function renderPracticeRound() {
  mobileTrainingPanel.hidden = true;
  document.body.dataset.trainingActive = String(mobileViewport.matches && ['countdown', 'playing', 'paused'].includes(practice.phase));
  $('#keyboard-note').innerHTML = '';
  $('#copy-panel').innerHTML = '';
  $('#answer-panel').innerHTML = '';
  roundPanel.hidden = false;
  const sending = (practice.session?.direction || practice.direction) === 'sending';
  const reviewed = practice.phase === 'reviewed';
  if (reviewed) {
    const session = practice.round;
    roundPanel.innerHTML = `<div class="practice-round-result"><span class="completion-icon">${icon('check')}</span><h2>${session?.completed ? 'Session complete' : 'Session stopped'}</h2><p>${session?.index || 0} correct · ${session?.attempts.length || 0} attempts</p>${session?.attempts.length ? `<strong class="session-result-score">${session.accuracy}%</strong>` : ''}</div>`;
    return;
  }
  const target = practice.round?.current || '';
  roundPanel.innerHTML = `<div class="practice-round-heading"><h2>${sending ? target.length > 1 ? 'Send the word' : 'Send the character' : 'Listen and choose'}</h2><p class="practice-round-status" role="status"></p></div>${sending ? `<div class="practice-target" aria-label="Character or word to send">${target || '?'}</div><textarea id="practice-morse-entry" class="practice-response practice-morse-entry" rows="2" readonly inputmode="none" autocomplete="off" aria-label="Your Morse answer" placeholder="Morse code">${escapeHTML(practice.morse)}</textarea><p class="practice-morse-help">${mobileViewport.matches ? 'Pause for letters. Space for words.' : '← Dit · → Dah · Space between words. Pause between letters.'}</p><div class="practice-morse-paddles"><button type="button" class="practice-morse-paddle dit" data-practice-morse="." aria-label="Dit"><strong>·</strong><span>Dit</span></button><button type="button" class="practice-morse-space" data-practice-morse="word" aria-label="Space between words">Space</button><button type="button" class="practice-morse-paddle dah" data-practice-morse="-" aria-label="Dah"><strong>−</strong><span>Dah</span></button></div><div class="practice-round-tools"><button id="undo-practice-morse" type="button" class="button quiet">Undo</button>${button('show-correct-answer', mobileViewport.matches ? 'Show answer' : 'Show correct answer', 'eye')}${button('check-practice-round', 'Check', 'check', 'primary')}</div>` : `<div class="practice-response" aria-label="Latest answer">${escapeHTML(practice.mobileInput || '?')}</div><div class="practice-round-tools">${button('replay-practice-round', 'Replay', 'replay')}${button('show-correct-answer', mobileViewport.matches ? 'Show answer' : 'Show correct answer', 'eye')}</div>${renderQwertyKeyboard({ attribute: 'data-round-key' })}`}<p class="practice-round-alert ${practice.roundCorrect === false ? 'incorrect' : practice.roundCorrect === true ? 'correct' : ''}" role="alert">${escapeHTML(practice.roundFeedback)}</p><div class="practice-correct-answer" ${practice.roundShown ? '' : 'hidden'}>${escapeHTML(target)} <span class="morse-pattern">${[...target].map(morseDisplay).join(' / ')}</span></div>`;
  roundPanel.querySelectorAll('[data-round-key]').forEach((key) => key.addEventListener('click', () => submitRoundAnswer(key.dataset.roundKey)));
  roundPanel.querySelectorAll('[data-practice-morse]').forEach((key) => key.addEventListener('click', () => enterPracticeMorse(key.dataset.practiceMorse)));
  $('#replay-practice-round')?.addEventListener('click', () => playPracticeRound());
  $('#show-correct-answer')?.addEventListener('click', () => { practice.roundShown = true; renderPracticeRound(); playPracticeRound(); });
  $('#check-practice-round')?.addEventListener('click', checkSendingRound);
  $('#undo-practice-morse')?.addEventListener('click', () => { if (practice.phase === 'playing' && practice.roundReady) sendingInput.backspace(); syncPracticeRoundControls(); });
  syncPracticeRoundControls();
}

function syncPracticeRoundControls() {
  if (roundPanel.hidden) return;
  const waiting = practice.phase === 'playing' && practice.roundReady && !practice.roundBusy;
  roundPanel.querySelectorAll('[data-round-key],[data-practice-morse],#undo-practice-morse,#show-correct-answer,#replay-practice-round').forEach((element) => { element.disabled = !waiting; });
  if ($('#check-practice-round')) $('#check-practice-round').disabled = !waiting || !practice.morse;
  const status = roundPanel.querySelector('.practice-round-status');
  if (status) status.textContent = practice.phase === 'idle' ? 'Choose a session and press Start.' : practice.phase === 'countdown' ? 'Get ready.' : practice.phase === 'paused' ? 'Paused' : practice.roundBusy ? 'Listen to the signal.' : practice.phase === 'interrupted' ? 'Audio stopped. Start again.' : (practice.session?.direction || practice.direction) === 'sending' ? 'Enter its Morse code, then check.' : mobileViewport.matches ? 'Tap the character you heard.' : 'Press the key for the character you heard.';
}

function renderRoundActions() {
  const active = ['countdown', 'playing', 'paused'].includes(practice.phase);
  $('#receiver-actions').innerHTML = practice.phase === 'interrupted' ? `<div class="action-group">${button('start-practice', 'Start again', 'play', 'primary')}${button('stop-practice', 'Stop', 'stop', 'quiet stop')}</div>` : active
    ? `<div class="action-group">${button('pause-practice', practice.phase === 'paused' ? 'Resume' : 'Pause', practice.phase === 'paused' ? 'play' : 'pause')}${button('stop-practice', 'Stop', 'stop', 'quiet stop')}</div>`
    : `<div class="action-group">${button('start-practice', practice.phase === 'reviewed' ? 'Start another session' : 'Start', 'play', 'primary')}</div>`;
  $('#start-practice')?.addEventListener('click', startPractice);
  $('#pause-practice')?.addEventListener('click', pauseRoundPractice);
  $('#stop-practice')?.addEventListener('click', finishRoundPractice);
}

async function startRoundPractice(session) {
  cancelAudio();
  recording.clear();
  sendingInput.replace('');
  const token = runId;
  const round = new PracticeRoundSession({ total: session.total, units: session.direction === 'sending' ? session.words : null, next: () => session.generator.next() });
  Object.assign(practice, { phase: 'countdown', resumePhase: 'countdown', session, round, sequence: '', played: 0, answer: '', grading: null, roundReady: false, roundBusy: false, roundShown: false, roundFeedback: '', roundCorrect: null, morse: '', mobileInput: '' });
  countdownValue = 5;
  notify();
  render();
  try {
    await player.prepare();
    if (token !== runId || !await playCountdown(token)) return;
    practice.phase = 'playing';
    practice.resumePhase = 'playing';
    beginPracticeRound();
  } catch (error) { if (token === runId) { handleAudioError(error); renderPracticeRound(); } }
}

function beginPracticeRound() {
  if (mode !== 'practice' || !practice.round || practice.phase !== 'playing') return;
  if (practice.round.completed) { finishRoundPractice(); return; }
  practice.round.begin();
  practice.roundShown = false;
  practice.mobileInput = '';
  practice.morse = '';
  sendingInput.replace('');
  practice.roundReady = practice.session.direction === 'sending';
  practice.roundBusy = false;
  renderPracticeRound();
  renderActions();
  updateTransport();
  if (practice.session.direction === 'receiving') playPracticeRound();
}

async function playPracticeRound() {
  if (practice.phase !== 'playing' || !practice.round?.current || practice.roundBusy || practice.session.direction !== 'receiving') return;
  const token = runId;
  practice.roundReady = false;
  practice.roundBusy = true;
  syncPracticeRoundControls();
  updateTransport();
  try {
    const completed = await player.playCharacter(practice.round.current, { ...sound });
    if (!completed || token !== runId) return;
    practice.roundBusy = false;
    practice.roundReady = true;
    updateTransport();
  } catch (error) { if (token === runId) { handleAudioError(error); renderPracticeRound(); } }
}

function submitRoundAnswer(answer) {
  if (practice.phase !== 'playing' || !practice.roundReady || practice.roundBusy || !practice.round?.current) return;
  const attempt = practice.round.submit(answer);
  practice.mobileInput = answer;
  practice.roundCorrect = attempt.correct;
  practice.roundFeedback = attempt.correct ? 'Correct.' : practice.session.direction === 'receiving' ? 'Incorrect. Listen again.' : `Incorrect. Try the same ${practice.round.current.length > 1 ? 'word' : 'character'} again.`;
  practice.played = practice.round.index;
  if (attempt.correct) {
    practice.sequence += attempt.expected;
    practice.answer += attempt.actual;
    beginPracticeRound();
  } else {
    if (practice.session.direction === 'sending') clearSendingEntry();
    renderPracticeRound();
    updateTransport();
    if (practice.session.direction === 'receiving') playPracticeRound();
  }
}

function clearSendingEntry() {
  sendingPlayer.stop();
  sendingInput.replace('');
}

function enterPracticeMorse(mark) {
  if (practice.phase !== 'playing' || !practice.roundReady || practice.roundBusy || practice.session.direction !== 'sending') return;
  try {
    if (mark === 'word') sendingInput.word();
    else {
      sendingInput.append(mark);
      sendingPlayer.playSymbol(mark, { ...sound }).catch((error) => { notify(error.message || 'The tone could not play.'); });
    }
    syncPracticeRoundControls();
  } catch (error) { notify(error.message); }
}

function checkSendingRound() {
  if (practice.phase !== 'playing' || !practice.roundReady || practice.session.direction !== 'sending' || !practice.morse) return;
  sendingInput.flush();
  let answer;
  try { answer = decodeMorse(practice.morse); }
  catch {
    practice.roundCorrect = false;
    practice.roundFeedback = 'That Morse code does not form a letter or number. Try again.';
    clearSendingEntry();
    renderPracticeRound();
    return;
  }
  sendingPlayer.stop();
  submitRoundAnswer(answer);
}

function pauseRoundPractice() {
  if (['countdown', 'playing'].includes(practice.phase)) {
    practice.roundAudioPaused = player.pause();
    sendingPlayer.stop();
    sendingInput.flush();
    practice.resumePhase = practice.phase;
    practice.phase = 'paused';
  } else if (practice.phase === 'paused') {
    stopAnswerAudio();
    if (practice.roundAudioPaused && !player.resume()) return;
    practice.phase = practice.resumePhase || 'playing';
  } else return;
  renderActions();
  updateTransport();
}

function finishRoundPractice() {
  if (!['countdown', 'playing', 'paused', 'interrupted'].includes(practice.phase)) return;
  cancelAudio();
  practice.roundBusy = false;
  practice.roundReady = false;
  practice.phase = 'reviewed';
  notify();
  renderPracticeSetup();
  renderWorkspace();
  updateTransport();
}

function getPracticeConfig() {
  const custom = practice.category === 'custom';
  const real = custom && practice.length === 'real-words';
  const pool = custom ? [...new Set(customPracticePool().toUpperCase().replace(/[^A-Z0-9]/g, ''))].join('') : practice.category === 'numbers' ? DIGITS : LETTERS;
  if (!pool && !real) throw new Error('Choose at least one letter or number for your custom practice.');
  let total = null;
  const groupSize = custom && ['words', 'real-words'].includes(practice.length) ? practice.groupSize : 0;
  let words = null;
  if (practice.length === 'characters') {
    if (!Number.isInteger(practice.count) || practice.count < 1 || practice.count > 10000) throw new Error('Choose a whole number of characters from 1 to 10,000.');
    total = practice.count;
  } else if (custom && ['words', 'real-words'].includes(practice.length)) {
    if (real) {
      words = generateRealWordGroups({ wordCount: practice.words, wordLength: groupSize });
    } else {
      if (!Number.isInteger(practice.words) || practice.words < 1 || practice.words > 2000) throw new Error('Choose a whole number of words from 1 to 2,000.');
      if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 50) throw new Error('Choose 1 to 50 letters per word.');
    }
    total = practice.words * groupSize;
    if (total > 10000) throw new Error('Keep a session to 10,000 characters or fewer.');
  }
  const generator = createPracticeGenerator(pool || LETTERS);
  const roundMode = practice.direction === 'sending' || !custom;
  if (practice.direction === 'sending' && groupSize && !words) words = Array.from({ length: practice.words }, () => Array.from({ length: groupSize }, () => generator.next()).join(''));
  return { pool, total, groupSize, generator, words, fixedSequence: real ? words.join('') : null, roundMode, direction: practice.direction, category: practice.category, mobile: false };
}

async function startPractice() {
  let session;
  try { session = getPracticeConfig(); } catch (error) { notify(error.message); return; }
  if (session.roundMode) { startRoundPractice(session); return; }
  cancelAudio();
  recording.clear();
  const token = runId;
  Object.assign(practice, { phase: 'countdown', resumePhase: 'countdown', sequence: '', played: 0, answer: '', grading: null, session, round: null, mobileInput: '' });
  countdownValue = 5;
  notify();
  render();
  $('#practice-copy').focus({ preventScroll: true });
  try {
    await player.prepare();
    if (token !== runId || !await playCountdown(token)) return;
    practice.phase = 'playing';
    practice.resumePhase = 'playing';
    renderActions();
    updateTransport();
    while (token === runId && (session.total === null || practice.played < session.total)) {
      const character = session.fixedSequence ? session.fixedSequence[practice.played] : session.generator.next();
      const config = { ...sound };
      if (!await player.playCharacter(character, config) || token !== runId) return;
      // Only complete characters enter the answer key. An interrupted mark is excluded.
      practice.sequence += character;
      practice.played += 1;
      recording.appendCharacter(character, config);
      updateTransport();
      if (session.total !== null && practice.played === session.total) break;
      const timing = getTiming(config);
      const gap = session.groupSize && practice.played % session.groupSize === 0 ? timing.wordGap : timing.characterGap;
      if (!await player.gap(gap) || token !== runId) return;
      recording.appendGap(gap);
      renderAudioTimeline();
    }
    if (token !== runId) return;
    practice.phase = 'ready';
    renderActions();
    updateTransport();
    $('#answer-panel').innerHTML = emptyAnswers('Ready to check your copy?', 'The audio is finished. Press Submit to reveal and compare your answers.');
    $('#practice-copy').focus({ preventScroll: true });
  } catch (error) { if (token === runId) handleAudioError(error); }
}

function pausePractice() {
  if (roundPractice()) { pauseRoundPractice(); return; }
  if (['countdown', 'playing'].includes(practice.phase)) {
    if (!player.pause() && practice.phase !== 'countdown') return;
    practice.resumePhase = practice.phase;
    practice.phase = 'paused';
  } else if (practice.phase === 'paused') {
    stopReplay();
    stopAnswerAudio();
    if (!player.resume() && practice.resumePhase !== 'countdown') return;
    practice.phase = practice.resumePhase || 'playing';
  } else return;
  renderActions();
  updateTransport();
  if (!practice.session?.mobile) $('#practice-copy')?.focus({ preventScroll: true });
}

function reviewPractice() {
  practice.grading = gradeInput(practice.answer, practice.sequence);
  practice.phase = 'reviewed';
  notify();
  renderPracticeSetup();
  renderWorkspace();
  updateTransport();
}

function stopPractice() {
  if (roundPractice()) { finishRoundPractice(); return; }
  if (!['countdown', 'playing', 'paused', 'ready', 'interrupted'].includes(practice.phase)) return;
  cancelAudio();
  reviewPractice();
}

function submitPractice() {
  if (!['ready', 'interrupted'].includes(practice.phase)) return;
  cancelAudio();
  reviewPractice();
}

document.addEventListener('keydown', (event) => {
  const keyTarget = event.target instanceof Element ? event.target : document.activeElement;
  const editingField = keyTarget?.isContentEditable || keyTarget?.closest('input:not([readonly]),textarea:not([readonly]),select,[role="textbox"],dialog[open]');
  if (mode === 'practice' && roundPractice() && practice.phase === 'playing' && !editingField && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing) {
    if (practice.session.direction === 'receiving' && /^[A-Za-z0-9]$/.test(event.key)) { event.preventDefault(); submitRoundAnswer(event.key.toUpperCase()); return; }
    if (practice.session.direction === 'sending') {
      const mark = ({ ArrowLeft: '.', ArrowRight: '-', '.': '.', '-': '-', ' ': 'word' })[event.key];
      if (mark) { event.preventDefault(); enterPracticeMorse(mark); return; }
      if (event.key === 'Backspace') { event.preventDefault(); if (practice.roundReady) sendingInput.backspace(); syncPracticeRoundControls(); return; }
      if (event.key === 'Enter') { event.preventDefault(); checkSendingRound(); return; }
    }
  }
  if (mobileTrainingActive() && !editingField && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing && /^[A-Za-z0-9]$/.test(event.key)) {
    event.preventDefault();
    submitMobileCharacter(event.key.toUpperCase());
    return;
  }
  if (event.altKey && event.key.toLowerCase() === 'r' && mode === 'learn' && learn.phase === 'practice') { event.preventDefault(); playLearnCharacter(); }
  if (event.altKey && event.key.toLowerCase() === 'p' && mode === 'practice') { event.preventDefault(); pausePractice(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && mode === 'practice') { event.preventDefault(); submitPractice(); }
  previewPracticeKey(event);
});

mobileViewport.addEventListener('change', () => {
  if (mode === 'chat') return;
  if (mode === 'characters') { renderCharacterPanel(); return; }
  renderWorkspace();
  updateTransport();
});

const chatRoom = createChatRoom({
  panel: $('#chat-panel'), bell: $('#chat-bell'), notifications: $('#chat-notifications'),
  accountToggle: $('#account-toggle'), accountMenu: $('#account-menu'),
  onEnter: () => setMode('chat'), onAudioStart: cancelAudio, getSound: activeSound,
});
const chatParameters = new URL(location.href).searchParams;
if (chatParameters.has('chat') || chatParameters.has('join')) mode = 'chat';
syncSound();
render();

function notifyNativeReady() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({
    type: 'morse-native-ready', theme: document.documentElement.dataset.theme, volume: sound.volume / 100,
  }));
}

window.addEventListener('morse-native-background', () => {
  if (mode === 'practice' && ['countdown', 'playing'].includes(practice.phase)) pausePractice();
  else {
    cancelAudio();
    if (mode === 'learn' && learn.phase === 'practice') {
      learn.audible = false;
      renderWorkspace();
    } else if (mode === 'learn') renderSetup();
    updateTransport();
  }
  chatRoom.stopAudio();
  stopAnswerAudio();
  stopReplay();
});
window.addEventListener('morse-native-auth-cleared', () => {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'morse-native-auth-cleared' }));
});
notifyNativeReady();
