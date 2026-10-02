import { MORSE, MorsePlayer, getTiming } from './audio.js';
import { LETTERS, DIGITS, LEVELS, generateSequence, createPracticeGenerator, generateLessonSequence, normalizeInput, formatGroups, gradeInput } from './trainer.js';
import { LearnSession } from './learn-session.js';

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (id, label, symbol, classes = '', disabled = false) => `<button id="${id}" class="button ${classes}" ${disabled ? 'disabled' : ''}>${symbol ? icon(symbol) : ''}${label}</button>`;
const clamp = (number, min, max, fallback) => Number.isFinite(Number(number)) ? Math.min(max, Math.max(min, Math.round(Number(number)))) : fallback;
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The trainer also works when storage is unavailable. */ } };
const savedSound = readStorage('morse-room-sound', {});
const sound = {
  wpm: clamp(savedSound.wpm, 5, 60, 20),
  farnsworth: clamp(savedSound.farnsworth, 1, 60, 10),
  frequency: clamp(savedSound.frequency, 200, 1200, 600),
  volume: clamp(savedSound.volume, 0, 100, 50),
};
sound.farnsworth = Math.min(sound.farnsworth, sound.wpm);
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
const learn = { level: Math.min(18, Math.max(0, ...progress.completed) + 1), phase: 'intro', sequence: '', session: null, index: 0, records: [], input: '', audible: false, playing: false, countdown: false, tutorialIndex: 0, tutorialHeard: false };
const practice = { source: 'random', filter: 'all', custom: 'QYFL', length: 'continuous', count: 50, words: 50, groupSize: 5, phase: 'idle', sequence: '', played: 0, answer: '', grading: null, session: null };

const signals = { main: false, answer: false };
function setSignal(source, active) {
  signals[source] = active;
  $('#signal-light').classList.toggle('on', signals.main || signals.answer);
  $('#waveform').classList.toggle('active', signals.main || signals.answer);
}
const player = new MorsePlayer({ onSignal: (active) => setSignal('main', active) });
const answerPlayer = new MorsePlayer({ onSignal: (active) => setSignal('answer', active) });
$('#waveform').innerHTML = Array.from({ length: 31 }, (_, index) => `<i style="--bar:${[5, 9, 14, 7, 19, 12, 23, 8, 16][index % 9]}px"></i>`).join('');

function notify(text = '', success = false) {
  $('#message').textContent = text;
  $('#message').classList.toggle('success', success);
}

function cancelAudio() {
  runId += 1;
  player.stop();
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
  for (const [key, value] of Object.entries(sound)) {
    const range = $(`#${key}-range`);
    const number = $(`#${key}-number`);
    if (key === 'farnsworth') { range.max = sound.wpm; number.max = sound.wpm; }
    range.value = value;
    number.value = value;
    const percent = (value - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100;
    range.style.background = `linear-gradient(to right, #729364 ${percent}%, #d6ddcc ${percent}%)`;
  }
  writeStorage('morse-room-sound', sound);
}

for (const key of Object.keys(sound)) {
  const update = (event) => {
    const input = event.target;
    if (input.value === '') { if (event.type === 'change') syncSound(); return; }
    sound[key] = clamp(input.value, Number(input.min), Number(input.max), sound[key]);
    sound.farnsworth = Math.min(sound.farnsworth, sound.wpm);
    syncSound();
  };
  $(`#${key}-range`).addEventListener('input', update);
  $(`#${key}-number`).addEventListener('change', update);
}

$('#test-tone').addEventListener('click', async () => {
  if (learn.playing || learn.countdown || tutorialBusy || answerBusy || ['countdown', 'playing', 'paused'].includes(practice.phase)) return;
  cancelAudio();
  const token = runId;
  toneBusy = true;
  $('#test-tone').disabled = true;
  updateTransport();
  try {
    await player.playCharacter('V', { ...sound });
    if (token !== runId) return;
    toneBusy = false;
    $('#test-tone').disabled = false;
    updateTransport();
  } catch (error) { handleAudioError(error); }
});

document.querySelectorAll('[data-mode]').forEach((element) => element.addEventListener('click', () => {
  if (mode === element.dataset.mode) return;
  if (mode === 'practice' && ['countdown', 'playing', 'paused', 'interrupted'].includes(practice.phase)) stopPractice();
  cancelAudio();
  if (mode === 'learn' && learn.phase === 'practice') learn.audible = false;
  mode = element.dataset.mode;
  notify();
  render();
}));

function render() {
  document.querySelectorAll('[data-mode]').forEach((element) => {
    const selected = element.dataset.mode === mode;
    element.classList.toggle('active', selected);
    element.setAttribute('aria-current', selected ? 'page' : 'false');
  });
  $('#breadcrumb').innerHTML = `Your workspace <span>/</span> ${mode === 'learn' ? 'Learn' : 'Practice'}`;
  const receiving = mode === 'practice' || ['practice', 'finished'].includes(learn.phase);
  $('.receiver').hidden = !receiving;
  $('.bottom-note').hidden = !receiving;
  renderHeading();
  renderSetup();
  renderWorkspace();
  updateTransport();
}

function renderHeading() {
  $('#view-heading').hidden = mode === 'learn';
  $('#view-heading').innerHTML = mode === 'learn' ? '' : `<div><div class="eyebrow">TIME TO FIND YOUR RHYTHM</div><h1>Just you and the signal.</h1><p>Listen, keep typing, and check your copy when you’re done.</p></div><span class="heading-badge">${icon('headphones')}Receiving practice</span>`;
}

function renderSetup() {
  if (mode === 'practice') { renderPracticeSetup(); return; }
  const level = LEVELS[learn.level - 1];
  const unlocked = Math.min(18, Math.max(0, ...progress.completed) + 1);
  const character = level.newCharacters[learn.tutorialIndex];
  let stage;
  if (learn.phase === 'intro') {
    stage = `<div class="lesson-stage"><h1 class="lesson-stage-eyebrow">Level ${level.number}</h1><div class="lesson-stage-characters" aria-label="${level.newCharacters.split('').join(' and ')}">${[...level.newCharacters].map((item) => `<span class="lesson-stage-letter">${item}</span>`).join('')}</div><p class="lesson-stage-description">Learn these two characters, one at a time.<br>Then receive ${level.practiceCount} signals using everything you’ve learned.</p><div class="lesson-stage-actions">${button('start-lesson', `Start lesson ${level.number}`, 'play', 'primary')}</div></div>`;
  } else if (['tutorial', 'lesson-complete'].includes(learn.phase)) {
    const completed = learn.phase === 'lesson-complete';
    stage = `<div class="lesson-stage ${tutorialBusy ? 'is-listening' : ''}"><h1 class="lesson-stage-eyebrow">Level ${level.number} · Character ${learn.tutorialIndex + 1} of 2</h1><div class="tutorial-letter"><span class="lesson-stage-letter">${character}</span></div><div class="tutorial-pattern morse-pattern" aria-label="${morseWords(character)}">${morseDisplay(character)}</div><p class="tutorial-sounds">${morseWords(character)}</p><p class="lesson-stage-description" role="status">${tutorialBusy ? 'Listen to the character.' : completed ? 'You’ve heard both characters. Replay the lesson or start practice.' : learn.tutorialHeard ? 'Replay as often as you like, then listen to the next character.' : 'Play the character to continue.'}</p><div class="lesson-stage-actions">${button('replay-tutorial', tutorialBusy ? 'Playing…' : `Replay ${character}`, 'replay', '', tutorialBusy)}${completed ? `${button('replay-lesson', 'Replay lesson', 'replay', '', tutorialBusy)}${button('start-learn-practice', 'Start practice', 'arrow', 'primary', tutorialBusy)}` : button('next-tutorial', `Next: ${level.newCharacters[1]}`, 'arrow', 'primary', tutorialBusy || !learn.tutorialHeard)}</div></div>`;
  } else {
    stage = `<div class="lesson-stage lesson-stage-compact"><h1>Level ${level.number}${learn.phase === 'finished' ? ' complete' : ' practice'}</h1><p class="lesson-stage-description">${learn.phase === 'finished' ? 'Every signal received correctly. Your next level is unlocked.' : `${level.practiceCount} correct answers to complete this level. A mistake repeats the same signal.`}</p></div>`;
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

function renderPracticeSetup() {
  const locked = practiceLocked();
  const disabled = locked ? 'disabled' : '';
  const grouped = practice.length === 'words';
  $('#setup-panel').innerHTML = `<div class="practice-card"><div class="practice-card-top"><span class="small-label">MAKE IT YOUR PRACTICE</span><div class="segmented" aria-label="Practice type"><button data-source="random" class="${practice.source === 'random' ? 'active' : ''}" ${disabled}>Random practice</button><button data-source="custom" class="${practice.source === 'custom' ? 'active' : ''}" ${disabled}>Custom practice</button></div></div>
    <div class="practice-fields"><div class="field">${practice.source === 'random' ? `<span class="field-label" id="pool-label">What would you like to hear?</span><div class="segmented" aria-labelledby="pool-label">${[['all', 'Letters + numbers'], ['letters', 'Letters'], ['numbers', 'Numbers']].map(([value, label]) => `<button data-filter="${value}" class="${practice.filter === value ? 'active' : ''}" ${disabled}>${label}</button>`).join('')}</div>` : `<label for="custom-characters">Your character selection</label><input id="custom-characters" type="text" value="${escapeHTML(practice.custom)}" maxlength="100" autocomplete="off" spellcheck="false" ${disabled}><p>Only these letters and numbers will be played. Each round includes every choice once.</p>`}</div>
    <div class="field"><label for="session-length">Session length</label><select id="session-length" ${disabled}><option value="continuous" ${practice.length === 'continuous' ? 'selected' : ''}>Continuous, until I stop</option><option value="characters" ${practice.length === 'characters' ? 'selected' : ''}>A set number of characters</option><option value="words" ${grouped ? 'selected' : ''}>Random word groups</option></select></div>
    <div class="field">${practice.length === 'continuous' ? `<span class="field-label">No finish line</span><p style="margin:0;line-height:1.9">Pause to take a breath.<br>Stop to check what you heard.</p>` : grouped ? `<div class="double-fields"><div><label for="word-count">Words</label><input id="word-count" type="number" min="1" max="2000" step="1" value="${practice.words}" ${disabled}></div><div><label for="group-size">Letters / word</label><input id="group-size" type="number" min="1" max="50" step="1" value="${practice.groupSize}" ${disabled}></div></div><p>${practice.words * practice.groupSize} characters, with a gap between words.</p>` : `<label for="character-count">Characters to receive</label><input id="character-count" type="number" min="1" max="10000" step="1" value="${practice.count}" ${disabled}><p>Spaces in your copy are optional.</p>`}</div></div>
    ${practice.source === 'custom' ? `<details class="character-picker"><summary>Choose individual characters</summary><div class="character-grid">${[...LETTERS + DIGITS].map((character) => `<button data-pick="${character}" class="${practice.custom.toUpperCase().includes(character) ? 'selected' : ''}" aria-label="${character}" aria-pressed="${practice.custom.toUpperCase().includes(character)}" ${disabled}>${character}</button>`).join('')}</div></details>` : ''}</div>`;
  document.querySelectorAll('[data-source]').forEach((element) => element.addEventListener('click', () => { practice.source = element.dataset.source; renderPracticeSetup(); }));
  document.querySelectorAll('[data-filter]').forEach((element) => element.addEventListener('click', () => { practice.filter = element.dataset.filter; renderPracticeSetup(); }));
  $('#session-length').addEventListener('change', (event) => { practice.length = event.target.value; renderPracticeSetup(); });
  $('#custom-characters')?.addEventListener('input', (event) => {
    practice.custom = event.target.value.toUpperCase();
    document.querySelectorAll('[data-pick]').forEach((element) => {
      const selected = practice.custom.includes(element.dataset.pick);
      element.classList.toggle('selected', selected);
      element.setAttribute('aria-pressed', selected);
    });
  });
  document.querySelectorAll('[data-pick]').forEach((element) => element.addEventListener('click', () => {
    const character = element.dataset.pick;
    const pool = [...new Set(practice.custom.toUpperCase().replace(/[^A-Z0-9]/g, ''))];
    practice.custom = pool.includes(character) ? pool.filter((item) => item !== character).join('') : pool.join('') + character;
    $('#custom-characters').value = practice.custom;
    element.classList.toggle('selected', practice.custom.includes(character));
    element.setAttribute('aria-pressed', practice.custom.includes(character));
  }));
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
  document.querySelectorAll('[data-answer].playing').forEach((cell) => cell.classList.remove('playing'));
}

async function playAnswerCharacter(character, cell) {
  if (!MORSE[character] || learn.playing || learn.countdown || tutorialBusy || toneBusy || (mode === 'practice' && practice.phase !== 'reviewed')) return;
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

$('#answer-panel').addEventListener('click', (event) => {
  const cell = event.target.closest('[data-answer]');
  if (cell && !cell.disabled) playAnswerCharacter(cell.dataset.answer, cell);
});

function renderWorkspace() {
  if (mode === 'learn') renderLearnWorkspace(); else renderPracticeWorkspace();
  renderActions();
}

function renderLearnWorkspace() {
  const level = LEVELS[learn.level - 1];
  $('#keyboard-note').innerHTML = `Your shortcuts <kbd>Enter</kbd> check and continue <kbd>Alt + R</kbd> replay`;
  if (!['practice', 'finished'].includes(learn.phase)) {
    $('#copy-panel').innerHTML = '';
    $('#answer-panel').innerHTML = '';
    return;
  }
  const copies = learn.records.map((record) => copyCell(record.actual, record.correct ? 'correct' : 'incorrect', record.position - 1)).join('');
  const answers = learn.records.map((record) => answerCell(record.expected, record.correct ? 'correct' : 'incorrect', record.position - 1)).join('');
  if (learn.phase === 'finished') {
    const accuracy = Math.round(level.practiceCount / learn.records.length * 100);
    $('#copy-panel').innerHTML = `<div class="completion-card"><span class="completion-icon">${icon('check')}</span><h3>Every signal, understood.</h3><p>You’ve received all ${level.practiceCount} signals correctly.<br>${level.number === 18 ? 'You’ve learned all 26 letters and 10 numbers.' : `Level ${level.number + 1} is now unlocked.`}</p><div class="score">${level.practiceCount} / ${level.practiceCount} passed · ${learn.records.length} attempts · ${accuracy}% accuracy</div></div><div class="learn-copy-list">${copies}</div>`;
    $('#answer-panel').innerHTML = `<p class="review-label">Your answers, in order. Click a character to hear it.</p><div class="learn-answer-list">${answers}</div><div class="answer-legend"><span>Correct</span><span>Retried</span></div>`;
    return;
  }
  const last = learn.records.at(-1);
  $('#copy-panel').innerHTML = `${copies ? `<div class="learn-copy-list">${copies}</div>` : ''}
    <div class="entry-row"><div class="letter-input-controls"><input id="letter-entry" class="letter-entry" type="text" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type the character you hear" value="${escapeHTML(learn.input)}"><button id="replay-letter" class="button entry-replay" aria-label="Replay the current signal" title="Replay the current signal">${icon('replay')}<span class="entry-replay-label">Replay</span></button></div><small>Listen to signal ${learn.index + 1} of ${level.practiceCount}.<br>Type one character, then press <kbd>Enter</kbd>.</small></div>
    <div class="lesson-feedback ${last ? last.correct ? 'correct' : 'incorrect' : ''}" role="status">${last ? last.correct ? `Correct. Now receive signal ${learn.index + 1}.` : `You copied ${escapeHTML(last.actual)}. The signal was ${last.expected}. Signal ${last.position} will repeat until you get it right.` : 'Take your time. You can replay the signal.'}</div>`;
  $('#answer-panel').innerHTML = answers ? `<div class="learn-answer-list">${answers}</div><p class="review-label" style="margin-top:12px">Click a character to hear it again.</p><div class="answer-legend"><span>Correct</span><span>Retried</span></div>` : emptyAnswers('Listen first. Then check.', 'Press Enter after typing a character to reveal its letter and Morse symbols here.');
  const entry = $('#letter-entry');
  $('#replay-letter').addEventListener('click', playLearnCharacter);
  if (entry) {
    entry.addEventListener('input', (event) => { learn.input = event.target.value.toUpperCase(); });
    entry.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.isComposing) checkLearn(); } });
    entry.focus({ preventScroll: true });
  }
  for (const panel of document.querySelectorAll('.learn-copy-list,.learn-answer-list')) panel.scrollTop = panel.scrollHeight;
}

function renderPracticeWorkspace() {
  const reviewed = practice.phase === 'reviewed';
  const groupSize = practice.session?.groupSize || 0;
  $('#keyboard-note').innerHTML = `Your shortcuts <kbd>Alt + P</kbd> pause / resume <kbd>Ctrl + Enter</kbd> submit`;
  if (reviewed) {
    const grade = practice.grading;
    $('#copy-panel').innerHTML = `<div class="results-summary"><span><b>Your submitted copy</b><br>${normalizeInput(practice.answer).length} typed · ${practice.played} received</span></div><div class="result-grid">${grade.rows.map((row, index) => `${groupSize && row.expectedIndex !== null && row.expectedIndex > 0 && row.expectedIndex % groupSize === 0 ? '<span class="result-word-break"></span>' : ''}${copyCell(row.actual, row.status, index)}`).join('')}</div><div class="answer-legend"><span>Correct</span><span>Wrong or missed</span><span>Extra input</span></div>`;
    $('#answer-panel').innerHTML = `<div class="results-summary"><strong>${grade.total || grade.extra ? `${grade.accuracy}%` : '0'}</strong><span><b>${grade.correct} of ${grade.total} received correctly</b><br>${grade.incorrect} wrong · ${grade.missing} missed · ${grade.extra} extra</span></div>${grade.rows.length ? `<div class="result-grid">${grade.rows.map((row, index) => `${groupSize && row.expectedIndex !== null && row.expectedIndex > 0 && row.expectedIndex % groupSize === 0 ? '<span class="result-word-break"></span>' : ''}${answerCell(row.expected, row.status, index)}`).join('')}</div>` : '<p class="review-label">No complete characters were played. Start again when you’re ready.</p>'}`;
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
  if (mode === 'learn') {
    if (learn.phase === 'practice') {
      const busy = learn.playing || learn.countdown || Boolean(answerBusy);
      if ($('#replay-letter')) $('#replay-letter').disabled = busy;
      $('#receiver-actions').innerHTML = `<span class="action-help">Press <kbd>Enter</kbd> to check. The next signal plays automatically.</span>${button('check-letter', 'Check letter', 'check', 'primary', !learn.audible || busy)}`;
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
      ? `<div class="action-group">${button('pause-practice', practice.phase === 'paused' ? 'Resume' : 'Pause', practice.phase === 'paused' ? 'play' : 'pause')}${button('stop-practice', 'Stop & check', 'stop', 'quiet stop')}</div><span class="action-help">${practice.phase === 'paused' ? 'Your place is saved. Answers are still hidden.' : 'Copy continuously. Stop whenever you’re ready.'}</span>${button('submit-practice', 'Submit copy', 'check', 'primary', true)}`
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
  let label = 'Ready when you are';
  let count = '';
  let percentage = 0;
  if (mode === 'learn') {
    const level = LEVELS[learn.level - 1];
    if (['intro', 'tutorial', 'lesson-complete'].includes(learn.phase)) label = tutorialBusy ? `Tutorial: listening to ${tutorialCharacter}` : 'Ready when you are';
    else if (learn.phase === 'finished') label = 'Level complete. Nicely received.';
    else label = learn.countdown ? `Starting in ${countdownValue}…` : learn.playing ? 'Listen to the signal…' : learn.audible ? 'Your turn to copy' : 'Replay the signal to continue';
    count = `${learn.index} / ${level.practiceCount} correct`;
    percentage = learn.index / level.practiceCount * 100;
  } else {
    label = ({ idle: 'Ready when you are', countdown: `Starting in ${countdownValue}…`, playing: 'Listening. Keep copying…', paused: 'Paused. Your place is saved.', ready: 'Audio complete. Submit when ready.', reviewed: 'Your copy has been checked.', interrupted: 'Playback interrupted.' })[practice.phase];
    count = practice.session ? practice.session.total ? `${practice.played} / ${practice.session.total} characters` : `${practice.played} characters received` : 'Your own pace';
    percentage = practice.session?.total ? practice.played / practice.session.total * 100 : practice.phase === 'reviewed' ? 100 : 0;
  }
  if (answerBusy) label = `Listening to answer ${answerBusy}…`;
  if (toneBusy) label = 'Testing your sound…';
  $('#signal-label').textContent = label;
  $('#session-counter').textContent = count;
  $('#session-progress').style.width = `${percentage}%`;
  $('#session-countdown').hidden = countdownValue === 0;
  $('#countdown-number').textContent = countdownValue;
  const countdownPaused = mode === 'practice' && practice.phase === 'paused' && practice.resumePhase === 'countdown';
  $('#session-countdown').classList.toggle('is-paused', countdownPaused);
  $('#session-countdown .countdown-copy b').textContent = countdownPaused ? 'Countdown paused' : 'Get ready to receive';
  $('#test-tone').disabled = toneBusy || tutorialBusy || learn.playing || learn.countdown || Boolean(answerBusy) || ['countdown', 'playing', 'paused'].includes(practice.phase);
  document.querySelectorAll('[data-answer]').forEach((cell) => { cell.disabled = learn.playing || learn.countdown || tutorialBusy || toneBusy || (mode === 'practice' && practice.phase !== 'reviewed'); });
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
    if (!await player.wait(1) || token !== runId) return false;
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

function getPracticeConfig() {
  const pool = practice.source === 'random' ? practice.filter === 'letters' ? LETTERS : practice.filter === 'numbers' ? DIGITS : LETTERS + DIGITS : [...new Set(practice.custom.toUpperCase().replace(/[^A-Z0-9]/g, ''))].join('');
  if (!pool) throw new Error('Choose at least one letter or number for your custom practice.');
  let total = null;
  const groupSize = practice.length === 'words' ? practice.groupSize : 0;
  if (practice.length === 'characters') {
    if (!Number.isInteger(practice.count) || practice.count < 1 || practice.count > 10000) throw new Error('Choose a whole number of characters from 1 to 10,000.');
    total = practice.count;
  } else if (practice.length === 'words') {
    if (!Number.isInteger(practice.words) || practice.words < 1 || practice.words > 2000) throw new Error('Choose a whole number of words from 1 to 2,000.');
    if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 50) throw new Error('Choose 1 to 50 letters per word.');
    total = practice.words * groupSize;
    if (total > 10000) throw new Error('Keep a session to 10,000 characters or fewer. Reduce the words or letters per word.');
  }
  const generator = practice.source === 'custom' ? createPracticeGenerator(pool) : null;
  return { pool, total, groupSize, generator };
}

async function startPractice() {
  let session;
  try { session = getPracticeConfig(); } catch (error) { notify(error.message); return; }
  cancelAudio();
  const token = runId;
  Object.assign(practice, { phase: 'countdown', resumePhase: 'countdown', sequence: '', played: 0, answer: '', grading: null, session });
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
      const character = session.generator ? session.generator.next() : generateSequence(session.pool, 1);
      const config = { ...sound };
      if (!await player.playCharacter(character, config) || token !== runId) return;
      // Only complete characters enter the answer key. An interrupted mark is excluded.
      practice.sequence += character;
      practice.played += 1;
      updateTransport();
      if (session.total !== null && practice.played === session.total) break;
      const timing = getTiming(config);
      const gap = session.groupSize && practice.played % session.groupSize === 0 ? timing.wordGap : timing.characterGap;
      if (!await player.gap(gap) || token !== runId) return;
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
  if (['countdown', 'playing'].includes(practice.phase)) {
    if (!player.pause()) return;
    practice.resumePhase = practice.phase;
    practice.phase = 'paused';
  } else if (practice.phase === 'paused') {
    if (!player.resume()) return;
    practice.phase = practice.resumePhase || 'playing';
  } else return;
  renderActions();
  updateTransport();
  $('#practice-copy')?.focus({ preventScroll: true });
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
  if (event.altKey && event.key.toLowerCase() === 'r' && mode === 'learn' && learn.phase === 'practice') { event.preventDefault(); playLearnCharacter(); }
  if (event.altKey && event.key.toLowerCase() === 'p' && mode === 'practice') { event.preventDefault(); pausePractice(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && mode === 'practice') { event.preventDefault(); submitPractice(); }
});

syncSound();
render();
