import { MorsePlayer, getTiming } from './audio.js';
import { TimedMorseInput } from './timed-morse.js';
import { bindPressControls } from './press-controls.js';
import { encodeRadioText, decodeRadioMorse, normalizeRadioMorse, radioTransmission, RadioReceivePipeline } from './radio-codec.js';
import { requestRadio, subscribeRadio } from './radio-client.js';

const STATION_KEY = 'morse-room-station-profile';
const CONTACTS_KEY = 'morse-room-radio-contacts';
const HARDWARE_KEY = 'morse-room-radio-hardware-ready';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const backspaceIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h11v14H9L3 12z"/><path d="m12 9 6 6m0-6-6 6"/></svg>';
const readStored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The current session still works without browser storage. */ } };
const station = () => readStored(STATION_KEY, { callsign: '', name: '', qth: '' });
const cleanCallsign = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 16);
const validCallsign = (value) => /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && value.length >= 3;
const codeString = (value) => typeof value === 'string' ? value : value?.morse ?? '';
const textString = (value) => typeof value === 'string' ? value : value?.text ?? '';
const isNative = () => document.documentElement.dataset.nativeApp === 'true';

async function playCode(player, raw, settings, isCurrent) {
  const timing = getTiming(settings);
  const words = normalizeRadioMorse(raw).split(' / ').filter(Boolean);
  await player.prepare();
  for (let wordIndex = 0; wordIndex < words.length && isCurrent(); wordIndex += 1) {
    const letters = words[wordIndex].split(' ').filter(Boolean);
    for (let letterIndex = 0; letterIndex < letters.length && isCurrent(); letterIndex += 1) {
      const marks = [...letters[letterIndex]].filter((mark) => mark === '.' || mark === '-');
      for (let index = 0; index < marks.length && isCurrent(); index += 1) {
        if (!await player.playSymbol(marks[index], settings) || !isCurrent()) return;
        if (index < marks.length - 1 && !await player.gap(timing.dit)) return;
      }
      if (letterIndex < letters.length - 1 && !await player.gap(timing.characterGap)) return;
    }
    if (wordIndex < words.length - 1 && !await player.gap(timing.wordGap)) return;
  }
}

export function createRadioRoom({ panel, getSound, onAudioStart = () => {} }) {
  const state = {
    active: false, ready: false, receiving: false, transmitting: false, starting: false, wantsReceive: false,
    keyer: null, inputs: [], keyers: [], inputId: '', composeMode: 'text', draft: '',
    transcript: '', receivedMorse: '', wpm: 0, tone: 600, level: 0, progress: '',
    status: '', error: false, epoch: 0, capabilities: {}, hardwareReady: readStored(HARDWARE_KEY, false) === true,
  };
  const player = new MorsePlayer();
  let audioEpoch = 0;
  let pipeline = null;
  let receiveEpoch = 0;
  let receiveFrame = null;
  const morseInput = new TimedMorseInput({
    getLetterGap: () => Math.max(500, Math.min(1500, getTiming(getSound()).characterGap * 1000)),
    maxLength: 3000,
    onChange(value) {
      state.draft = value;
      const input = panel.querySelector('#radio-draft');
      if (input && state.composeMode === 'morse') input.value = value;
      updateDraft();
    },
    onBoundary() { updateDraft(); },
  });
  const pressControls = bindPressControls(panel, {
    selector: '[data-radio-key]',
    onPress(control) { insertMorse(control.dataset.radioKey); },
    repeats: (control) => control.dataset.radioKey === 'backspace',
  });

  function status(message = '', error = false) {
    state.status = message;
    state.error = error;
    const node = panel.querySelector('#radio-status');
    if (node) { node.textContent = message; node.classList.toggle('is-error', error); node.hidden = !message; }
  }

  function stopAudio() { audioEpoch += 1; player.stop(); }

  function readiness() {
    const profile = station();
    if (!isNative()) return 'Android app required';
    if (!state.keyer) return 'Keying interface not connected';
    if (!validCallsign(profile.callsign)) return 'Set your station callsign';
    if (!state.hardwareReady) return 'Complete the connection setup';
    return 'Ready to transmit';
  }

  function canTransmit() {
    let validMessage = false;
    try { validMessage = Boolean(radioTransmission(messageCode(), getSound()).morse); } catch { /* Incomplete letters remain editable before transmission. */ }
    return state.active && isNative() && Boolean(state.keyer) && state.hardwareReady
      && validCallsign(station().callsign) && !state.transmitting && !state.starting
      && validMessage;
  }

  function messageCode() {
    try { return state.composeMode === 'morse' ? normalizeRadioMorse(state.draft, { composer: true }) : encodeRadioText(state.draft); }
    catch { return ''; }
  }

  function render() {
    panel.classList.add('radio-panel');
    panel.innerHTML = `<div class="radio-workspace">
      <header class="radio-station-bar"><div class="radio-station-identity"><span class="radio-radio-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 9h18v12H3zM5 9l13-6M7 13h5M7 17h5"/><circle cx="17" cy="15" r="2"/></svg></span><div><strong>S-Pixie <span>CW</span></strong><small>7.023 MHz · 40 m</small></div></div><button type="button" class="button quiet" data-radio-action="setup">Connection setup ${icon('arrow')}</button></header>
      <section class="radio-receiver" aria-labelledby="radio-receive-title"><div class="radio-section-heading"><h2 id="radio-receive-title">Receive</h2><span id="radio-rx-state" class="radio-state"><i></i>Standby</span></div>
      <div class="radio-receive-meta"><span id="radio-input-label">${isNative() ? 'Phone microphone or audio input' : 'Radio connections are available in the Android app.'}</span><span class="radio-receive-readout"><span id="radio-input-level" class="radio-input-level" role="meter" aria-label="Received audio level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span><span id="radio-decode-speed">Auto speed</span></span></div>
      <div id="radio-copy" class="radio-copy" role="log" aria-live="polite" aria-label="Received Morse text"><p class="radio-copy-placeholder">Received text will appear here.</p></div>
      <div id="radio-received-morse" class="radio-received-morse" aria-label="Received Morse code" hidden></div>
      <div class="radio-receive-controls"><button class="button primary" type="button" data-radio-action="receive" ${isNative() ? '' : 'disabled'}>${icon('play')}<span>Start receiving</span></button><div class="radio-copy-actions"><button class="button quiet" type="button" data-radio-action="copy" aria-label="Copy received text" disabled>${icon('copy')}</button><button class="button quiet" type="button" data-radio-action="clear" disabled>Clear</button></div></div>
      <p class="radio-decoder-note">Live decoding stays on your device. A ? can mean an uncertain character.</p></section>
      <section class="radio-transmitter" aria-labelledby="radio-transmit-title"><div class="radio-section-heading"><h2 id="radio-transmit-title">Transmit</h2><div class="segmented radio-composer-mode" role="group" aria-label="Radio message format"><button type="button" data-radio-mode="text" class="active" aria-pressed="true">Text</button><button type="button" data-radio-mode="morse" aria-pressed="false">Morse</button></div></div>
      <div class="radio-compose-row"><textarea id="radio-draft" rows="2" maxlength="500" spellcheck="false" autocomplete="off" aria-label="Message to transmit" placeholder="Type a radio message"></textarea><button type="button" class="button primary radio-transmit-button" data-radio-action="transmit" aria-label="Transmit message" disabled>${icon('send')}<span>Transmit</span></button></div>
      <div id="radio-draft-preview" class="radio-draft-preview" aria-label="Message preview" hidden></div>
      <div id="radio-morse-controls" class="radio-morse-controls" hidden><p>Pause between letters. Space between words. <span class="radio-desktop-hint">← dit · → dah</span></p><div class="radio-paddles"><button class="radio-paddle" type="button" data-radio-key="." aria-label="Dit"><strong>.</strong><span>Dit</span></button><button class="radio-paddle" type="button" data-radio-key="-" aria-label="Dah"><strong>−</strong><span>Dah</span></button><button type="button" class="radio-word-space" data-radio-key="word">Space</button><button type="button" class="radio-backspace" data-radio-key="backspace" aria-label="Backspace">${backspaceIcon}</button></div></div>
      <div class="radio-transmit-footer"><span id="radio-tx-readiness">${escape(readiness())}</span><div><button type="button" class="button quiet" data-radio-action="preview" disabled>${icon('volume')}Preview</button><button type="button" class="button stop" data-radio-action="stop" hidden>${icon('stop')}Stop transmitting</button></div></div>
      <p class="radio-operation-note">Transmitted means sent over your radio. Reception must be confirmed by the other station.</p></section>
      <p id="radio-status" class="radio-status" role="status" hidden></p>
    </div><dialog class="radio-dialog" aria-labelledby="radio-setup-title"><form method="dialog" class="radio-dialog-heading"><h2 id="radio-setup-title">Connection setup</h2><button type="submit" class="button quiet" aria-label="Close connection setup">${icon('close')}</button></form><div class="radio-dialog-body"></div></dialog>`;
    panel.querySelector('#radio-draft').value = state.draft;
    updateMode(); updateState(); updateTranscript();
  }

  function updateState() {
    if (!state.active) return;
    const rx = panel.querySelector('#radio-rx-state');
    rx.classList.toggle('is-live', state.receiving);
    if (!state.receiving) rx.classList.remove('has-signal');
    rx.innerHTML = `<i></i>${state.starting ? 'Opening audio input' : state.transmitting ? 'Transmitting' : state.receiving ? 'Listening' : 'Standby'}`;
    const receive = panel.querySelector('[data-radio-action="receive"]');
    receive.disabled = !isNative() || state.starting || state.transmitting;
    receive.innerHTML = `${icon(state.receiving ? 'stop' : 'play')}<span>${state.receiving ? 'Stop receiving' : 'Start receiving'}</span>`;
    const input = panel.querySelector('#radio-draft');
    input.disabled = state.transmitting;
    panel.querySelectorAll('[data-radio-mode], [data-radio-key]').forEach((node) => { node.disabled = state.transmitting; });
    panel.querySelector('[data-radio-action="stop"]').hidden = !state.transmitting;
    panel.querySelector('#radio-tx-readiness').textContent = state.transmitting ? state.progress || 'Transmitting' : readiness();
    updateDraft();
  }

  function updateMode() {
    const input = panel.querySelector('#radio-draft');
    const morse = state.composeMode === 'morse';
    input.readOnly = morse;
    input.inputMode = morse ? 'none' : 'text';
    input.maxLength = morse ? 3000 : 500;
    input.classList.toggle('is-morse', morse);
    input.placeholder = morse ? 'Tap dit and dah below' : 'Type a radio message';
    input.value = state.draft;
    panel.querySelector('#radio-morse-controls').hidden = !morse;
    panel.querySelectorAll('[data-radio-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.radioMode === state.composeMode);
      button.setAttribute('aria-pressed', String(button.dataset.radioMode === state.composeMode));
    });
    updateDraft();
  }

  function updateDraft() {
    if (!state.active) return;
    const preview = panel.querySelector('#radio-draft-preview');
    let value = '';
    let invalid = false;
    try { value = state.composeMode === 'morse' ? decodeRadioMorse(state.draft, { composer: true }) : encodeRadioText(state.draft); }
    catch (error) { value = error.message; invalid = true; }
    if (!invalid && state.composeMode === 'morse' && state.draft && !morseInput.letterPending) {
      try { radioTransmission(messageCode(), getSound()); }
      catch (error) { value = `${value}\n${error.message}`; invalid = true; }
    }
    preview.textContent = value;
    preview.hidden = !value;
    preview.classList.toggle('is-morse', state.composeMode !== 'morse');
    preview.classList.toggle('is-error', invalid);
    panel.querySelector('[data-radio-action="transmit"]').disabled = !canTransmit();
    panel.querySelector('[data-radio-action="preview"]').disabled = !value || invalid || state.receiving || state.starting || state.transmitting;
  }

  function updateTranscript() {
    if (!state.active) return;
    const copy = panel.querySelector('#radio-copy');
    const nearBottom = copy.scrollHeight - copy.scrollTop - copy.clientHeight < 64;
    if (state.transcript) copy.textContent = state.transcript;
    else copy.innerHTML = '<p class="radio-copy-placeholder">Received text will appear here.</p>';
    if (nearBottom) copy.scrollTop = copy.scrollHeight;
    const morse = panel.querySelector('#radio-received-morse');
    morse.textContent = state.receivedMorse.slice(-150);
    morse.hidden = !state.receivedMorse;
    panel.querySelector('#radio-decode-speed').textContent = state.wpm > 0 ? `${Math.round(state.wpm)} WPM` : 'Auto speed';
    const level = panel.querySelector('#radio-input-level');
    level.setAttribute('aria-valuenow', String(Math.round(state.level * 100)));
    level.querySelector('i').style.transform = `scaleX(${state.level})`;
    panel.querySelectorAll('[data-radio-action="copy"], [data-radio-action="clear"]').forEach((button) => { button.disabled = !state.transcript && !state.receivedMorse; });
  }

  function decodeUpdate(update) {
    if (!state.active || !state.receiving) return;
    if (typeof update?.text === 'string') state.transcript = update.text.slice(-15000);
    if (typeof update?.morse === 'string') state.receivedMorse = update.morse;
    if (Number.isFinite(update?.wpm) && (update.morse || update.pending)) state.wpm = update.wpm;
    if (Number.isFinite(update?.signal)) state.level = Math.max(0, Math.min(1, update.signal));
    panel.querySelector('#radio-rx-state')?.classList.toggle('has-signal', update.active === true);
    if (receiveFrame === null) receiveFrame = requestAnimationFrame(() => { receiveFrame = null; updateTranscript(); });
  }

  async function startReceive() {
    if (!isNative()) { status('Radio connections are available in the Android app.', true); return; }
    if (state.starting || state.transmitting || state.receiving) return;
    const current = ++receiveEpoch;
    stopAudio(); onAudioStart();
    state.starting = true; state.wantsReceive = true; status(); updateState();
    panel.querySelector('#radio-input-label').textContent = 'Opening audio input';
    try {
      const frequency = Math.max(200, Math.min(1200, state.tone || getSound().frequency || 600));
      pipeline = new RadioReceivePipeline({ ...getSound(), frequency, onUpdate: decodeUpdate });
      state.transcript = ''; state.receivedMorse = ''; state.wpm = 0;
      updateTranscript();
      const result = await requestRadio('startReceive', { ...(state.inputId !== '' ? { deviceId: Number(state.inputId) } : {}), frequency, sampleRate: 16000 });
      if (!state.active || current !== receiveEpoch) { await requestRadio('stopReceive').catch(() => {}); return; }
      if (result?.inputName) panel.querySelector('#radio-input-label').textContent = result.inputName;
      updateTranscript();
    } catch (error) { if (current === receiveEpoch) { state.receiving = false; state.starting = false; state.wantsReceive = false; pipeline = null; status(error.message || 'Audio input could not start.', true); } }
    finally { if (current === receiveEpoch) updateState(); }
  }

  async function stopReceive() {
    receiveEpoch += 1;
    const wasRunning = state.receiving || state.starting;
    pipeline?.flush?.();
    state.starting = false; state.receiving = false; state.wantsReceive = false; state.level = 0; pipeline = null;
    if (wasRunning) await requestRadio('stopReceive').catch((error) => { if (state.active) status(error.message, true); });
    updateState(); updateTranscript();
  }

  function insertMorse(symbol) {
    if (!state.active || state.composeMode !== 'morse' || state.transmitting) return;
    try {
      if (symbol === 'word') morseInput.word();
      else if (symbol === 'backspace') morseInput.backspace();
      else {
        morseInput.append(symbol);
        if (!state.receiving && !state.starting) { onAudioStart(); player.playSymbol(symbol, getSound()).catch((error) => status(error.message, true)); }
      }
    } catch (error) { status(error.message, true); }
  }

  async function transmit() {
    if (!canTransmit()) { status(readiness(), true); return; }
    morseInput.flush();
    const morse = messageCode();
    if (!morse.trim()) { status('Finish or correct the Morse characters before transmitting.', true); return; }
    const current = ++state.epoch;
    stopAudio(); onAudioStart(); state.transmitting = true; state.progress = 'Preparing transmission'; status(); updateState();
    try {
      await stopReceive();
      if (!state.active || current !== state.epoch) return;
      const result = await requestRadio('transmit', { morse, ...getSound(), callsign: station().callsign, hardwareReady: state.hardwareReady });
      if (state.active && current === state.epoch) {
        state.progress = result?.state === 'queued' ? 'Transmission queued' : 'Transmitting';
        updateState();
      }
    } catch (error) {
      if (state.active && current === state.epoch) { state.transmitting = false; state.progress = ''; status(error.message || 'Transmission stopped.', true); updateState(); }
    }
  }

  async function stopTransmit() {
    state.epoch += 1; state.transmitting = false; state.progress = ''; stopAudio();
    await requestRadio('stopTransmit').catch(() => {});
    if (state.active) { status('Transmission stopped.'); updateState(); }
  }

  function setupBody() {
    const profile = station();
    const inputs = state.inputs.map((input) => `<option value="${escape(input.id)}" ${String(input.id) === String(state.inputId) ? 'selected' : ''}>${escape(input.name)}</option>`).join('');
    const keyers = state.keyers.map((keyer) => `<option value="${escape(keyer.id)}">${escape(keyer.name)}</option>`).join('');
    return `<div class="radio-setup-note">${icon('info')}<p>The S-Pixie has no USB or Bluetooth connection. A USB cable and wireless earphones alone cannot connect it to the app.</p></div>
      <ol class="radio-wiring-list"><li><strong>Receive</strong><span>Receiver headphone output → suitable level matching and isolation → USB-C audio-input adapter → phone. Choose an adapter with a microphone or line input; output-only headphone dongles cannot receive audio.</span></li><li><strong>Transmit</strong><span>Phone → supported USB serial controller with the Morse Room keyer firmware → isolated key output → Pixie KEY socket.</span></li></ol>
      <p class="radio-setup-help">For USB-C phones, including the OnePlus Nord 2T, use a compatible USB-C hub to connect the audio-input adapter and keyer together. The phone microphone can also listen to audible receiver audio. Do not connect a phone or USB power cable directly to the KEY socket. <a href="https://github.com/Lelin45/The-Morse-Room/tree/main/hardware/pixie-keyer" target="_blank" rel="noopener">Hardware guide and keyer firmware</a>.</p>
      <div class="radio-setup-section"><h3>Receive audio</h3><label for="radio-input">Input</label><div class="radio-input-row"><select id="radio-input" ${state.receiving ? 'disabled' : ''}><option value="">Phone microphone / system default</option>${inputs}</select><button type="button" class="button quiet" data-radio-action="refresh" ${isNative() ? '' : 'disabled'} aria-label="Refresh audio inputs and keying interfaces">${icon('replay')}</button></div><label for="radio-tone">Target tone <span>Hz</span></label><input id="radio-tone" type="number" min="200" max="1200" step="10" value="${escape(state.tone)}" ${state.receiving ? 'disabled' : ''}><small>Set this to the audio pitch heard from the radio, not its 7.023 MHz radio frequency.</small></div>
      <div class="radio-setup-section"><h3>Keying interface</h3><div class="radio-input-row"><select id="radio-keyer" ${state.keyer ? 'disabled' : ''}><option value="">${state.keyers.length ? 'Select a connected interface' : 'No supported USB interface found'}</option>${keyers}</select><button id="radio-keyer-connect" type="button" class="button" data-radio-action="${state.keyer ? 'disconnect' : 'connect'}" ${!isNative() || !state.keyer && !state.keyers.length ? 'disabled' : ''}>${state.keyer ? 'Disconnect' : 'Connect'}</button></div><small id="radio-keyer-label">${state.keyer ? `Connected: ${escape(state.keyer.name || 'Morse Room keyer')}` : 'A bare USB cable is not a keying interface. Bluetooth keyers are not supported in this version.'}</small></div>
      <div class="radio-setup-section"><h3>Your station</h3><label for="radio-callsign">Licensed callsign</label><input id="radio-callsign" type="text" autocomplete="off" autocapitalize="characters" maxlength="16" value="${escape(profile.callsign)}" placeholder="Your callsign"><label class="radio-confirm-hardware"><input id="radio-hardware-ready" type="checkbox" ${state.hardwareReady ? 'checked' : ''}><span>I have checked the isolated keying interface, antenna and licence conditions for this frequency.</span></label></div>
      <p class="radio-setup-help">Your callsign and connection preferences are stored on this device. Callsigns also has your station profile and saved contacts.</p>
      <button type="button" class="button primary radio-save-setup" data-radio-action="save-setup">Save settings</button><p id="radio-setup-status" class="radio-status" role="status" hidden></p>`;
  }

  async function refreshConnections() {
    if (!isNative()) return;
    const [inputs, keyers] = await Promise.allSettled([requestRadio('getAudioInputs'), requestRadio('listKeyers')]);
    if (inputs.status === 'fulfilled') state.inputs = Array.isArray(inputs.value) ? inputs.value : inputs.value?.inputs || [];
    if (keyers.status === 'fulfilled') state.keyers = (Array.isArray(keyers.value) ? keyers.value : keyers.value?.keyers || []).filter((item) => item.eligible !== false);
    if (inputs.status === 'rejected' && keyers.status === 'rejected') throw inputs.reason;
  }

  async function showSetup() {
    const dialog = panel.querySelector('.radio-dialog');
    dialog.querySelector('.radio-dialog-body').innerHTML = setupBody();
    if (!dialog.open) dialog.showModal();
    if (isNative()) {
      try { await refreshConnections(); if (dialog.open) updateSetupConnections(); }
      catch (error) { setupStatus(error.message); }
    }
  }

  function setupStatus(message) { const node = panel.querySelector('#radio-setup-status'); if (node) { node.textContent = message; node.hidden = !message; } }

  function updateSetupConnections() {
    const input = panel.querySelector('#radio-input');
    const keyer = panel.querySelector('#radio-keyer');
    if (!input || !keyer) return;
    const inputValue = input.value || state.inputId;
    const keyerValue = keyer.value;
    input.innerHTML = '<option value="">Phone microphone / system default</option>' + state.inputs.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
    input.value = inputValue;
    keyer.innerHTML = `<option value="">${state.keyers.length ? 'Select a connected interface' : 'No supported USB interface found'}</option>` + state.keyers.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
    keyer.value = state.keyer?.id ?? keyerValue;
    keyer.disabled = Boolean(state.keyer);
    const button = panel.querySelector('#radio-keyer-connect');
    button.dataset.radioAction = state.keyer ? 'disconnect' : 'connect';
    button.textContent = state.keyer ? 'Disconnect' : 'Connect';
    button.disabled = !isNative() || !state.keyer && !state.keyers.length;
    panel.querySelector('#radio-keyer-label').textContent = state.keyer ? `Connected: ${state.keyer.name || 'Morse Room keyer'}` : 'A bare USB cable is not a keying interface. Bluetooth keyers are not supported in this version.';
  }

  function saveSetup() {
    const callsign = cleanCallsign(panel.querySelector('#radio-callsign').value);
    if (callsign && !validCallsign(callsign)) { setupStatus('Enter your station callsign using letters, numbers and /, or leave it empty for receiving only.'); return; }
    const tone = Number(panel.querySelector('#radio-tone').value);
    if (!Number.isFinite(tone) || tone < 200 || tone > 1200) { setupStatus('Choose a target tone from 200 to 1,200 Hz.'); return; }
    state.inputId = panel.querySelector('#radio-input').value;
    state.tone = tone;
    state.hardwareReady = panel.querySelector('#radio-hardware-ready').checked;
    saveStored(STATION_KEY, { ...station(), callsign });
    saveStored(HARDWARE_KEY, state.hardwareReady);
    saveStored('morse-room-radio-preferences', { inputId: state.inputId, tone: state.tone });
    panel.querySelector('.radio-dialog').close();
    updateState();
  }

  async function handleAction(action) {
    if (action === 'setup') return showSetup();
    if (action === 'save-setup') return saveSetup();
    if (action === 'receive') return state.receiving ? stopReceive() : startReceive();
    if (action === 'transmit') return transmit();
    if (action === 'stop') return stopTransmit();
    if (action === 'clear') { pipeline?.reset?.(); state.transcript = ''; state.receivedMorse = ''; state.wpm = 0; updateTranscript(); return; }
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.transcript); status('Received text copied.'); }
      catch { status('Copy is unavailable on this device. You can select the received text.', true); }
      return;
    }
    if (action === 'refresh') { await refreshConnections(); updateSetupConnections(); return; }
    if (action === 'connect') {
      const id = panel.querySelector('#radio-keyer').value;
      if (!id) { setupStatus('Choose a keying interface first.'); return; }
      setupStatus('Connecting. Accept the USB permission prompt if it appears.');
      const connected = await requestRadio('connectKeyer', { deviceId: Number(id) });
      state.keyer = connected?.keyer || state.keyers.find((keyer) => String(keyer.id) === String(id)) || { id, name: 'Morse Room keyer' };
      updateSetupConnections(); setupStatus(''); updateState(); return;
    }
    if (action === 'disconnect') { await stopTransmit(); await requestRadio('disconnectKeyer'); state.keyer = null; updateSetupConnections(); updateState(); return; }
    if (action === 'preview') {
      stopAudio(); onAudioStart();
      const current = ++audioEpoch;
      const raw = messageCode();
      await playCode(player, raw, getSound(), () => state.active && current === audioEpoch);
    }
  }

  panel.addEventListener('click', (event) => {
    const mode = event.target.closest('[data-radio-mode]');
    if (mode && mode.dataset.radioMode !== state.composeMode && !state.transmitting) {
      morseInput.flush(); stopAudio();
      try { state.draft = mode.dataset.radioMode === 'morse' ? encodeRadioText(state.draft).split(' / ').map((word) => word.split(' ').join('/')).join('//') : decodeRadioMorse(state.draft, { composer: true }); }
      catch (error) { status(error.message, true); return; }
      state.composeMode = mode.dataset.radioMode;
      if (state.composeMode === 'morse') morseInput.replace(state.draft);
      else morseInput.stop();
      updateMode(); return;
    }
    const button = event.target.closest('[data-radio-action]');
    if (!button || button.disabled) return;
    handleAction(button.dataset.radioAction).catch((error) => { if (panel.querySelector('.radio-dialog')?.open) setupStatus(error.message); else status(error.message, true); });
  });
  panel.addEventListener('input', (event) => { if (event.target.id === 'radio-draft' && state.composeMode === 'text') { state.draft = event.target.value; updateDraft(); } });
  panel.addEventListener('keydown', (event) => {
    if (event.target.id !== 'radio-draft' || state.composeMode !== 'morse') return;
    const symbol = ({ ArrowLeft: '.', ArrowRight: '-', ' ': 'word', Backspace: 'backspace' })[event.key];
    if (symbol) { event.preventDefault(); if (!event.repeat || symbol === 'backspace') insertMorse(symbol); }
  });

  const unsubscribe = subscribeRadio((event) => {
    if (event.kind === 'audio' && state.receiving && pipeline) {
      try { pipeline.push(event.samples, event.sampleRate); } catch (error) { status(error.message || 'The audio stream could not be decoded.', true); }
    } else if (event.kind === 'keyer') {
      if (event.state === 'disconnected' || event.state === 'error') { state.keyer = null; state.transmitting = false; state.epoch += 1; if (state.active) status(event.message || 'Keying interface disconnected.', true); }
      else if (event.state === 'transmitting') { state.transmitting = true; state.progress = event.total ? `Transmitting ${event.progress || 0} / ${event.total}` : 'Transmitting'; }
      else if (event.state === 'stopped') { state.transmitting = false; state.progress = ''; if (state.active) status('Transmission stopped.'); }
      else if (event.state === 'done') { state.transmitting = false; state.progress = ''; if (state.active) status('Transmitted. Wait for the other station to confirm reception.'); }
      updateState();
    } else if (event.kind === 'status' && state.active) {
      if (event.state === 'receiving') {
        if (!state.wantsReceive) return;
        state.receiving = true; state.starting = false;
        const input = panel.querySelector('#radio-input-label');
        if (input) input.textContent = event.device?.name || event.deviceName || 'Phone microphone';
        status('Listening. Match the target tone to the tone heard from your receiver.');
        updateState();
      }
      if (event.message) status(event.message, event.state === 'error' || event.error === true);
      if (event.state === 'stopped' || event.state === 'error') { pipeline?.flush?.(); state.receiving = false; state.starting = false; state.wantsReceive = false; state.level = 0; pipeline = null; updateState(); updateTranscript(); }
    }
  });

  window.addEventListener('morse-native-background', () => { stopAudio(); morseInput.stop(); pressControls.cancel(); if (state.receiving) stopReceive(); if (state.transmitting) stopTransmit(); });

  return {
    async open() {
      state.active = true;
      const preferences = readStored('morse-room-radio-preferences', {});
      state.inputId = preferences.inputId ?? '';
      state.tone = preferences.tone || getSound().frequency || 600;
      render();
      if (isNative()) { try { state.capabilities = await requestRadio('getCapabilities'); state.ready = true; } catch (error) { if (state.active) status(error.message, true); } }
    },
    close() {
      state.active = false; state.epoch += 1; stopAudio(); morseInput.stop(); pressControls.cancel();
      panel.querySelector('.radio-dialog')?.close();
      if (receiveFrame !== null) { cancelAnimationFrame(receiveFrame); receiveFrame = null; }
      stopReceive(); stopTransmit();
    },
    stopAudio,
    stopReceiving: stopReceive,
    destroy() { this.close(); unsubscribe(); pressControls.destroy(); },
  };
}

export function createCallsigns({ panel, getSound, onAudioStart = () => {} }) {
  let active = false;
  let playing = null;
  let generation = 0;
  const player = new MorsePlayer();
  const contacts = () => {
    const saved = readStored(CONTACTS_KEY, []);
    return Array.isArray(saved) ? saved.filter((contact) => validCallsign(contact.callsign)).slice(0, 200) : [];
  };
  const status = (message, error = false) => {
    const node = panel.querySelector('#callsigns-status');
    if (node) { node.textContent = message; node.hidden = !message; node.classList.toggle('is-error', error); }
  };

  function render() {
    const profile = station();
    const saved = contacts();
    panel.classList.add('radio-panel');
    panel.innerHTML = `<div class="callsigns-workspace"><section class="callsigns-station" aria-labelledby="callsigns-station-title"><div class="radio-section-heading"><h2 id="callsigns-station-title">Your station</h2><button class="button quiet" type="button" data-callsign-action="edit">${profile.callsign ? 'Edit' : 'Set callsign'}</button></div>${profile.callsign ? `<div class="callsigns-station-profile"><strong>${escape(profile.callsign)}</strong><span>${escape([profile.name, profile.qth].filter(Boolean).join(' · '))}</span><button type="button" class="button quiet" data-callsign-play="${escape(profile.callsign)}" aria-label="Listen to your callsign">${icon('volume')}</button></div>` : '<p class="callsigns-empty-profile">Add your licensed callsign to identify your station when transmitting.</p>'}</section>
      <section class="callsigns-contacts" aria-labelledby="callsigns-contacts-title"><div class="radio-section-heading"><h2 id="callsigns-contacts-title">Saved stations <span>${saved.length}</span></h2><button type="button" class="button" data-callsign-action="add">${icon('user-plus')}Add station</button></div><div class="callsigns-contact-list">${saved.length ? saved.map((contact) => `<article class="callsigns-contact"><div><strong>${escape(contact.callsign)}</strong><span>${escape([contact.name, contact.qth].filter(Boolean).join(' · ')) || 'Saved station'}</span></div><button class="button quiet" type="button" data-callsign-play="${escape(contact.callsign)}" aria-label="Listen to ${escape(contact.callsign)}">${icon('volume')}</button><button class="button quiet" type="button" data-callsign-remove="${escape(contact.callsign)}" aria-label="Remove ${escape(contact.callsign)}">${icon('close')}</button></article>`).join('') : `<div class="callsigns-empty">${icon('users')}<p>Keep the callsigns of stations you hear or contact.</p><span>Tap a saved station’s sound button to practise listening.</span></div>`}</div></section><p class="callsigns-local-note">Saved on this device. This is your station notebook, not an online callsign directory.</p><p id="callsigns-status" class="radio-status" role="status" hidden></p></div>
      <dialog class="radio-dialog callsigns-dialog" aria-labelledby="callsigns-dialog-title"><form method="dialog" class="radio-dialog-heading"><h2 id="callsigns-dialog-title">Your station</h2><button type="submit" class="button quiet" aria-label="Close">${icon('close')}</button></form><form id="callsigns-profile-form" class="radio-dialog-body"><label for="station-callsign">Callsign</label><input id="station-callsign" name="callsign" type="text" autocomplete="off" autocapitalize="characters" maxlength="16" value="${escape(profile.callsign)}" placeholder="Your callsign" required><label for="station-name">Name <span>Optional</span></label><input id="station-name" name="name" type="text" autocomplete="name" maxlength="60" value="${escape(profile.name)}"><label for="station-qth">Location / QTH <span>Optional</span></label><input id="station-qth" name="qth" type="text" maxlength="80" value="${escape(profile.qth)}"><p class="radio-setup-help">Only use a callsign assigned to you for your station identity. Saved contacts can be other stations.</p><p class="radio-status" id="callsigns-form-status" role="status" hidden></p><button type="submit" class="button primary">Save station</button></form></dialog>`;
  }

  function showEditor(ownStation) {
    const dialog = panel.querySelector('dialog');
    dialog.dataset.ownStation = String(ownStation);
    const profile = ownStation ? station() : { callsign: '', name: '', qth: '' };
    dialog.querySelector('#callsigns-dialog-title').textContent = ownStation ? 'Your station' : 'Add station';
    for (const field of ['callsign', 'name', 'qth']) dialog.querySelector(`[name="${field}"]`).value = profile[field] || '';
    dialog.querySelector('#callsigns-form-status').hidden = true;
    dialog.showModal();
  }

  panel.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-callsign-action]');
    if (action) { showEditor(action.dataset.callsignAction === 'edit'); return; }
    const remove = event.target.closest('[data-callsign-remove]');
    if (remove) { saveStored(CONTACTS_KEY, contacts().filter((contact) => contact.callsign !== remove.dataset.callsignRemove)); render(); return; }
    const play = event.target.closest('[data-callsign-play]');
    if (!play) return;
    stopAudio(); onAudioStart();
    const current = ++generation;
    playing = play.dataset.callsignPlay;
    play.classList.add('is-playing');
    status(`Listening to ${playing}`);
    try { await playCode(player, codeString(encodeRadioText(playing)), getSound(), () => active && current === generation); if (current === generation) status(''); }
    catch (error) { status(error.message, true); }
    finally { if (current === generation) { playing = null; play.classList.remove('is-playing'); } }
  });
  panel.addEventListener('submit', (event) => {
    if (event.target.id !== 'callsigns-profile-form') return;
    event.preventDefault();
    const form = event.target;
    const callsign = cleanCallsign(form.elements.callsign.value);
    if (!validCallsign(callsign)) {
      const node = form.querySelector('#callsigns-form-status');
      node.textContent = 'Enter a callsign with letters and numbers. Portable suffixes using / are supported.'; node.hidden = false; return;
    }
    const profile = { callsign, name: form.elements.name.value.trim().slice(0, 60), qth: form.elements.qth.value.trim().slice(0, 80) };
    const ownStation = panel.querySelector('dialog').dataset.ownStation === 'true';
    if (ownStation) saveStored(STATION_KEY, profile);
    else saveStored(CONTACTS_KEY, [...contacts().filter((contact) => contact.callsign !== callsign), profile].sort((a, b) => a.callsign.localeCompare(b.callsign)).slice(0, 200));
    panel.querySelector('dialog').close(); render(); status(ownStation ? 'Station profile saved.' : 'Station added.');
  });

  function stopAudio() { generation += 1; player.stop(); playing = null; panel.querySelectorAll('.is-playing').forEach((node) => node.classList.remove('is-playing')); }
  return {
    open() { active = true; render(); },
    close() { active = false; stopAudio(); panel.querySelector('dialog')?.close(); },
    stopAudio,
  };
}
