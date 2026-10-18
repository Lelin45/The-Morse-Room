import { MorsePlayer, getTiming } from './audio.js';
import { TimedMorseInput } from './timed-morse.js';
import { bindPressControls } from './press-controls.js';
import { morseText, decodeMorse, validateMessage, validateMorseMessage, validateUsername, MAX_MESSAGE_LENGTH, MAX_MORSE_LENGTH } from './chat-codec.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const action = (name, text, symbol, classes = '') => `<button type="button" class="button ${classes}" data-chat-action="${name}">${symbol ? icon(symbol) : ''}${text}</button>`;
const dateLabel = (value) => {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function createChatRoom({ panel, bell, notifications, accountToggle, accountMenu, onEnter, onAudioStart, getSound }) {
  const state = {
    active: false, ready: false, config: { available: false, providers: {} }, user: null,
    inbox: { friends: [], requests: [], groupRequests: [], conversations: [], unread: 0 }, conversation: null,
    members: [], messages: [], selected: null, view: 'list', draft: '', busy: false,
    revealed: new Set(), listening: null, audioToken: 0, loading: false, pollBusy: false,
    status: '', statusError: false, listKey: '', requestKey: '', messageKey: '', fetchId: 0,
    cursor: 0, readCursor: 0, nextInboxAt: 0, hasMore: false, joinConsumed: false, drafts: new Map(),
    retryAt: 0, failures: 0, composeMode: 'text', draftByMode: { text: '', morse: '' }, accountKey: '', pendingSends: new Map(),
  };
  const player = new MorsePlayer();
  const feedbackPlayer = new MorsePlayer();
  const mobile = matchMedia('(max-width: 760px)');
  const touchInput = matchMedia('(max-width: 760px), (pointer: coarse), (hover: none)');
  const pressControls = bindPressControls(panel, {
    selector: '[data-morse-key]',
    onPress: (control) => insertMorse(control.dataset.morseKey),
    repeats: (control) => control.dataset.morseKey === 'undo',
  });
  let composerResizeFrame = null;
  const morseInput = new TimedMorseInput({
    getLetterGap: () => Math.max(700, Math.min(1500, getTiming(getSound()).characterGap * 1000)),
    onChange(value) {
      const input = panel.querySelector('#chat-draft');
      if (state.composeMode !== 'morse' || !input) return;
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      updateDraft(); updateMorseBoundary();
    },
    onBoundary: () => updateMorseBoundary(),
    maxLength: MAX_MORSE_LENGTH,
  });
  const requestedJoin = new URL(location.href).searchParams.get('join');
  if (requestedJoin) {
    try { sessionStorage.setItem('morse-room-join', requestedJoin.slice(0, 80)); } catch { /* Joining also works by entering the code. */ }
  }
  const authError = new URL(location.href).searchParams.get('chat_error');
  if (authError) {
    state.status = 'Sign-in did not finish. Please try again.';
    state.statusError = true;
  }

  async function api(path, body) {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('Chat is not connected yet. You can still use every lesson and practice session.'); }
    if (!response.ok) {
      const error = new Error(result.error?.message || 'That did not work. Please try again.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function status(text = '', error = false) {
    state.status = text;
    state.statusError = error;
    const node = panel.querySelector('.chat-status');
    if (node) { node.textContent = text; node.classList.toggle('chat-error', error); node.hidden = !text; }
  }

  function avatar(username, classes = '') {
    return `<span class="chat-item-avatar ${classes}" aria-hidden="true">${escape((username || '?').slice(0, 2).toUpperCase())}</span>`;
  }

  function googleButton(available) {
    return `<a class="button chat-provider-button ${available ? '' : 'is-disabled'}" ${available ? 'href="/api/auth/google"' : 'aria-disabled="true"'}><span class="sr-only">Sign in with Google</span><img class="chat-google-light" src="google-signin-light.png" width="180" height="40" alt="" aria-hidden="true"><img class="chat-google-dark" src="google-signin-dark.png" width="180" height="40" alt="" aria-hidden="true"></a>`;
  }

  function renderAccount() {
    const key = JSON.stringify([state.ready, state.user, state.config]);
    if (key === state.accountKey) return;
    state.accountKey = key;
    const available = state.config.available && state.config.providers.google;
    if (state.ready && state.config.available) window.dispatchEvent(new CustomEvent('morse-native-chat-account', {
      detail: { userId: state.user?.username ? state.user.id : null, notificationsAvailable: state.config.notifications?.available === true },
    }));
    accountToggle.innerHTML = state.user ? `${state.user.username ? avatar(state.user.username) : icon('user')}<span class="account-name">${escape(state.user.username ? `@${state.user.username}` : 'Account')}</span>` : icon('user');
    accountToggle.setAttribute('aria-label', state.user ? `Account: ${state.user.username || 'choose a username'}` : 'Account: sign in');
    accountMenu.innerHTML = state.user
      ? `<div class="account-menu-heading"><strong>${escape(state.user.username ? `@${state.user.username}` : 'Your account')}</strong><small class="account-menu-meta">${state.user.isReviewer ? 'Review account · Test data' : 'Signed in with Google'}</small></div>${state.user.isReviewer ? '' : state.user.username ? action('profile', 'Edit username', 'user', 'quiet') : action('open-chat', 'Choose username', 'user', 'quiet')}${action('open-chat', 'Morse Chat Room', 'chat', 'quiet')}${document.documentElement.dataset.nativeApp === 'true' && state.config.notifications?.available ? action('notification-settings', 'Notifications', 'bell', 'quiet') : ''}${state.user.username ? action('blocked', 'Blocked people', '', 'quiet') : ''}${action('logout', 'Sign out', '', 'quiet')}${action('delete-account', 'Delete account', '', 'quiet chat-danger-action')}<p class="account-status chat-error" role="status" hidden></p><p class="chat-legal"><a href="privacy.html">Privacy Policy</a> · <a href="terms.html">Terms and Conditions</a></p>`
      : `<div class="account-menu-heading"><strong>Save lessons and chat</strong><small class="account-menu-meta">Learn and Practice need no account.</small></div>${googleButton(available)}${!state.ready ? '<p>Checking sign-in...</p>' : !available ? '<p>Chat sign-in is being connected.</p>' : ''}${action('review-access', 'Review access', '', 'quiet chat-review-access')}<p class="chat-legal">By signing in, you agree to the <a href="terms.html">chat terms</a> and <a href="privacy.html">privacy notice</a>.</p>`;
    if (state.user) {
      const sync = document.createElement('small'); sync.id = 'learning-sync-status'; sync.className = 'account-menu-meta';
      sync.textContent = 'Syncing lessons…'; accountMenu.querySelector('.account-menu-heading').append(sync);
    }
    if (state.ready && state.config.available) window.dispatchEvent(new CustomEvent('morse-account-changed', { detail: { userId: state.user?.id || null } }));
  }

  function closeAccount() { accountMenu.hidden = true; accountToggle.setAttribute('aria-expanded', 'false'); }

  function updateConversationLayout() {
    document.documentElement.classList.toggle('chat-conversation-open', Boolean(state.active && state.user && state.conversation && state.view === 'conversation'));
  }

  async function logout() {
    try {
      await api('/logout', {});
      stopAudio(); state.fetchId += 1;
      state.user = null; state.inbox = { friends: [], requests: [], conversations: [], unread: 0 };
      state.selected = null; state.conversation = null; state.messages = []; state.revealed.clear();
      state.draft = ''; state.draftByMode = { text: '', morse: '' }; state.drafts.clear(); state.pendingSends.clear();
      status(); closeAccount(); render(); updateBell();
      window.dispatchEvent(new CustomEvent('morse-native-auth-cleared'));
    } catch (error) {
      status(error.message, true);
      const node = accountMenu.querySelector('.account-status');
      if (node) { node.hidden = false; node.textContent = error.message; }
    }
  }

  function render() {
    pressControls.cancel();
    updateConversationLayout();
    if (!state.active) return;
    if (!state.ready) {
      panel.innerHTML = '<div class="chat-empty" role="status">Opening Morse Chat Room...</div>';
      return;
    }
    if (!state.user) { renderWelcome(); return; }
    if (!state.user.username) { renderProfile(); return; }
    panel.innerHTML = `<p class="chat-status ${state.statusError ? 'chat-error' : ''}" role="status" ${state.status ? '' : 'hidden'}>${escape(state.status)}</p>
      <div class="chat-shell" data-view="${state.view}">
        <aside class="chat-sidebar" aria-label="Your conversations">
          <div class="chat-toolbar">${action('friend', 'Add friend', 'user-plus')}${action('new-group', 'New group', 'users')}${action('join-group', 'Join by invite', 'link')}${action('public-groups', 'Find public groups', 'users')}</div>
          <div class="chat-list-heading"><strong>${state.user.isReviewer ? 'Test conversations' : 'Conversations'}</strong><span id="chat-conversation-count">${state.inbox.conversations.length}</span></div>
          <div class="chat-conversation-list"></div>
          <p class="chat-sidebar-note">Browse public groups or join a private group with an invite. Each group has room for 100 people.</p>
        </aside>
        <section class="chat-conversation" aria-label="Conversation"><div class="chat-empty"><span class="chat-empty-mark">${icon('chat')}</span><h2>Find your first signal</h2><p>Add a friend by username or email, or start a group and share its invite.</p></div></section>
      </div>`;
    state.listKey = '';
    renderList();
    if (state.conversation) renderConversation();
  }

  function renderWelcome() {
    const available = state.config.available && state.config.providers.google;
    panel.innerHTML = `<div class="chat-intro">
      <div class="chat-intro-copy"><h2>Chat in Morse with friends</h2><p>Write a message or send your own dits and dahs.</p>
      <ul class="chat-feature-list"><li>${icon('user-plus')}Find friends by username or email.</li><li>${icon('users')}Find a public group or invite friends to a private one.</li><li>${icon('volume')}Read the Morse, listen, or reveal the words.</li></ul>
      <div class="chat-auth-actions">${googleButton(available)}</div>
      ${action('review-access', 'Review access', '', 'quiet chat-review-access')}
      <p class="chat-form-help">${available ? 'Pick a username after signing in. Learn and Practice stay free, with no account needed.' : 'Chat is being connected. Every lesson and practice session is available now.'}</p>
      ${available ? '' : action('retry', 'Check again', 'replay', 'quiet')}
      <p class="chat-status ${state.statusError ? 'chat-error' : ''}" role="status" ${state.status ? '' : 'hidden'}>${escape(state.status)}</p>
      <p class="chat-legal">By using chat, you agree to the <a href="terms.html">chat terms</a>. Read our <a href="privacy.html">privacy notice</a>.</p></div>
      <div class="chat-demo"><span class="small-label">A LITTLE PREVIEW</span><div class="chat-message-row"><div class="chat-message"><div class="chat-message-meta"><strong>A friendly signal</strong><span>Example</span></div><div class="chat-message-content"><p class="chat-message-morse">.... . .-.. .-.. --- / ..-. .-. .. . -. -..</p><p class="chat-message-text is-concealed" id="chat-demo-text" aria-hidden="true">Hello friend</p></div></div><div class="chat-message-actions">${action('demo-reveal', 'Show text', 'eye')}${action('demo-listen', 'Listen', 'volume')}</div></div><p>Try listening first. Reveal the words whenever you like.</p><p class="chat-code-note">${icon('info')}<span>Morse code includes only letters and numbers. Show text displays your message exactly as typed.</span></p></div>
    </div>`;
  }

  function renderProfile() {
    panel.innerHTML = `<div class="chat-intro chat-profile-intro"><div class="chat-intro-copy"><div class="eyebrow">YOUR FIRST SIGNAL</div><h1>What should we call you?</h1><p>Choose a username so friends can find you. Your email stays out of your public profile.</p>
      <form class="chat-profile-form"><label class="chat-field">Username<input name="username" autocomplete="username" placeholder="e.g. user123" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required></label><p class="chat-form-help">3 to 24 letters, numbers, or underscores. Each username is unique.</p><p class="chat-status" role="status" hidden></p><button class="button primary" type="submit">Enter chat ${icon('arrow')}</button></form></div></div>`;
    panel.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy) return;
      const submit = event.target.querySelector('[type=submit]');
      try {
        const username = validateUsername(new FormData(event.target).get('username'));
        state.busy = true; submit.disabled = true;
        await api('/profile', { username });
        state.user = (await api('/me')).user;
        state.busy = false;
        status();
        await refreshInbox();
        render();
        await offerPendingJoin();
      } catch (error) { status(error.message, true); }
      finally { state.busy = false; submit.disabled = false; }
    });
  }

  function renderList() {
    const list = panel.querySelector('.chat-conversation-list');
    if (!list) return;
    const key = JSON.stringify([state.inbox.conversations, state.selected]);
    if (key === state.listKey) return;
    const focusedId = document.activeElement?.dataset?.conversation;
    state.listKey = key;
    const count = panel.querySelector('#chat-conversation-count');
    if (count) count.textContent = state.inbox.conversations.length;
    list.innerHTML = state.inbox.conversations.length ? state.inbox.conversations.map((item) => `<button type="button" class="chat-conversation-item ${String(item.id) === String(state.selected) ? 'active' : ''}" data-conversation="${escape(item.id)}" ${String(item.id) === String(state.selected) ? 'aria-current="true"' : ''}>${item.type === 'group' ? `<span class="chat-item-avatar">${icon('users')}</span>` : avatar(item.name)}<span class="chat-item-copy"><strong>${escape(item.type === 'direct' ? `@${item.name}` : item.name)}</strong><small>${item.type === 'group' ? `${item.visibility === 'public' ? 'Public' : 'Private'} group · ${item.memberCount || 0}/100` : 'Friend'}</small></span><span class="chat-item-meta">${item.unread ? `<b>${escape(item.unread)}</b><span class="sr-only">unread messages</span>` : icon('arrow')}</span></button>`).join('') : '<div class="chat-empty chat-list-empty"><p>No conversations yet.</p><small>A friend request is a good first step.</small></div>';
    if (focusedId) [...list.querySelectorAll('[data-conversation]')].find((button) => button.dataset.conversation === focusedId)?.focus({ preventScroll: true });
  }

  function renderConversation() {
    pressControls.cancel();
    updateConversationLayout();
    const room = state.conversation;
    const view = panel.querySelector('.chat-conversation');
    if (!view || !room) return;
    view.innerHTML = `<header class="chat-conversation-header">${action('back', 'Back', 'back', 'quiet chat-mobile-back')}<div class="chat-room-identity">${avatar(room.name, 'chat-room-avatar')}<div class="chat-item-copy"><h2 title="${escape(room.name)}">${escape(room.type === 'direct' ? `@${room.name}` : room.name)}</h2><small class="chat-member-summary">${room.type === 'group' ? `${room.visibility === 'public' ? 'Public' : 'Private'} · ${state.members.length}/100 members` : 'Morse messages between friends'}</small></div></div><div class="chat-room-actions"><button type="button" class="button quiet chat-audio-button" data-open-audio aria-label="Audio settings" title="Audio settings">${icon('volume')}</button>${room.type === 'group' ? `${action('members', 'Members', 'users', 'quiet')}${room.code ? action('invite', 'Invite', 'link', 'quiet') : ''}` : room.peer?.id ? action('block', 'Block', '', 'quiet chat-block-button') : ''}</div></header>
      ${room.type === 'group' ? '<div class="chat-invite-details" hidden></div>' : ''}
      <div class="chat-history-actions" ${state.hasMore ? '' : 'hidden'}>${action('earlier', 'Load earlier signals', 'replay')}</div>
      <div class="chat-message-list" aria-label="Messages"></div>
      <p class="chat-new-signal" role="status" aria-live="polite" hidden></p>
      <form class="chat-compose">
        <div class="chat-compose-heading"><div class="chat-compose-label"><span>Message</span><details class="chat-code-info"><summary aria-label="About Morse messages">${icon('info')}</summary><p id="chat-code-note">Morse code includes only letters and numbers. Show text displays your original message, including punctuation, or decodes your Morse.</p></details><small id="chat-draft-count"></small></div><div class="chat-send-mode segmented" aria-label="Message input mode"><button type="button" data-send-mode="text" aria-label="Send text">Text</button><button type="button" data-send-mode="morse" aria-label="Send Morse code">Morse</button></div></div>
        <label for="chat-draft" class="sr-only">Message to send as Morse code</label><div class="chat-compose-input-row"><textarea id="chat-draft" name="text" rows="1" aria-describedby="chat-code-note chat-morse-help" required></textarea><button type="submit" class="button primary chat-send-button" aria-label="Send signal"><span>Send signal</span>${icon('send')}</button></div>
        <div class="chat-morse-help" id="chat-morse-help" hidden><p><span class="chat-desktop-morse-help"><kbd>←</kbd> dit <span>·</span> <kbd>→</kbd> dah <span>·</span> </span>Pause between letters. Space between words. <span id="chat-morse-boundary" aria-live="off"></span></p><div class="morse-paddles"><button type="button" class="morse-paddle dit" data-morse-key="." aria-label="Dit"><strong>.</strong><span>Dit</span></button><button type="button" class="morse-space" data-morse-key="word" aria-label="Space between words">Space</button><button type="button" class="morse-paddle dah" data-morse-key="-" aria-label="Dah"><strong>-</strong><span>Dah</span></button></div><button type="button" class="button quiet chat-morse-undo" data-morse-key="undo" aria-label="Backspace" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 5h11v14H9L3 12z"/><path d="m12 9 6 6m0-6-6 6"/></svg></button></div>
      </form>`;
    state.messageKey = '';
    renderMessages(true);
    const draft = view.querySelector('#chat-draft');
    draft.value = state.draft;
    updateComposer();
    draft.addEventListener('input', () => {
      if (state.composeMode === 'morse') morseInput.replace(draft.value);
      else updateDraft();
    });
    draft.addEventListener('keydown', (event) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || state.busy) return;
      if (state.composeMode === 'morse' && ['ArrowLeft', 'ArrowRight', ' ', '.', '-'].includes(event.key)) {
        event.preventDefault();
        if (!event.repeat) insertMorse(event.key === 'ArrowLeft' ? '.' : event.key === 'ArrowRight' ? '-' : event.key === ' ' ? 'word' : event.key);
        return;
      }
      if (state.composeMode === 'morse' && event.key === 'Backspace' && draft.selectionStart === draft.value.length && draft.selectionEnd === draft.value.length) {
        event.preventDefault(); insertMorse('undo'); return;
      }
      if (event.key === 'Enter' && !touchInput.matches && !event.shiftKey && !event.repeat) {
        event.preventDefault(); view.querySelector('.chat-compose').requestSubmit();
      }
    });
    view.querySelector('.chat-compose').addEventListener('submit', sendMessage);
  }

  function updateDraft() {
    const input = panel.querySelector('#chat-draft');
    if (!input) return;
    state.draft = input.value;
    state.draftByMode[state.composeMode] = input.value;
    if (state.selected) state.drafts.set(String(state.selected), { ...state.draftByMode, mode: state.composeMode });
    const maximum = state.composeMode === 'morse' ? MAX_MORSE_LENGTH : MAX_MESSAGE_LENGTH;
    panel.querySelector('#chat-draft-count').textContent = `${input.value.length.toLocaleString()} / ${maximum.toLocaleString()}`;
    growComposer(input);
  }

  function growComposer(input) {
    if (composerResizeFrame !== null) cancelAnimationFrame(composerResizeFrame);
    // Reading scrollHeight can force layout. Batch it outside the tap handler.
    composerResizeFrame = requestAnimationFrame(() => {
      composerResizeFrame = null;
      if (!panel.contains(input)) return;
      const maximum = state.composeMode === 'morse' ? 92 : 114;
      input.style.height = 'auto';
      input.style.height = `${Math.max(48, Math.min(maximum, input.scrollHeight + 2))}px`;
    });
  }

  function updateComposer() {
    pressControls.cancel();
    const input = panel.querySelector('#chat-draft');
    if (!input) return;
    const morse = state.composeMode === 'morse';
    input.value = state.draftByMode[state.composeMode];
    input.maxLength = morse ? MAX_MORSE_LENGTH : MAX_MESSAGE_LENGTH;
    input.placeholder = morse ? 'Morse code' : 'Message';
    input.classList.toggle('is-morse', morse);
    input.readOnly = state.busy || (morse && touchInput.matches);
    input.setAttribute('inputmode', morse && touchInput.matches ? 'none' : 'text');
    if (morse) morseInput.replace(input.value);
    else morseInput.stop();
    input.spellcheck = !morse;
    input.setAttribute('autocapitalize', morse ? 'off' : 'sentences');
    panel.querySelector('#chat-morse-help').hidden = !morse;
    panel.querySelector('.chat-morse-undo').hidden = !morse;
    panel.querySelectorAll('[data-send-mode]').forEach((button) => {
      const selected = button.dataset.sendMode === state.composeMode;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
      button.disabled = state.busy;
    });
    panel.querySelectorAll('.chat-compose [data-morse-key], .chat-compose [type=submit]').forEach((button) => { button.disabled = state.busy; });
    updateDraft();
  }

  function updateMorseBoundary() {
    const label = panel.querySelector('#chat-morse-boundary');
    if (!label) return;
    label.textContent = morseInput.letterPending ? 'Letter in progress' : morseInput.value ? 'Next letter ready' : '';
    label.dataset.pending = String(morseInput.letterPending);
  }

  function focusComposer() {
    const input = panel.querySelector('#chat-draft');
    if (!state.active || !input || touchInput.matches) return;
    input.focus({ preventScroll: true });
  }

  function insertMorse(symbol) {
    const input = panel.querySelector('#chat-draft');
    if (!input || state.composeMode !== 'morse' || state.busy) return;
    try {
      if (symbol === 'word') morseInput.word();
      else if (symbol === 'undo') morseInput.backspace();
      else if (symbol === '.' || symbol === '-') {
        if (state.listening) stopAudio();
        morseInput.append(symbol); playFeedback(symbol);
      }
      focusComposer();
    } catch (error) { status(error.message, true); }
  }

  function playFeedback(symbol) {
    onAudioStart();
    void feedbackPlayer.playSymbol(symbol, getSound()).catch((error) => status(error.message || 'Audio could not play.', true));
  }

  function renderMessages(scrollToEnd = false) {
    const list = panel.querySelector('.chat-message-list');
    if (!list) return;
    const key = JSON.stringify([state.messages.map((item) => item.id), [...state.revealed], state.listening]);
    if (!scrollToEnd && key === state.messageKey) return;
    state.messageKey = key;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const previousTop = list.scrollTop;
    const focused = document.activeElement;
    const focusedListen = focused?.dataset?.listen;
    const focusedReveal = focused?.dataset?.reveal;
    list.innerHTML = state.messages.length ? state.messages.map((item) => {
      const mine = String(item.senderId) === String(state.user.id);
      const listening = state.listening === String(item.id);
      const shown = state.revealed.has(String(item.id));
      return `<div class="chat-message-row ${mine ? 'mine' : ''}" data-message="${escape(item.id)}"><article class="chat-message ${mine ? 'mine' : ''} ${listening ? 'listening' : ''}"><div class="chat-message-meta"><strong>@${escape(item.username)}</strong><time>${escape(dateLabel(item.createdAt))}</time></div><div class="chat-message-content ${shown ? 'is-revealed' : ''}"><p class="chat-message-morse" aria-label="Morse code message" aria-hidden="${shown}">${escape(item.morse)}</p><p class="chat-message-text ${shown ? '' : 'is-concealed'}" aria-hidden="${!shown}">${escape(item.text)}</p></div></article><div class="chat-message-actions"><button type="button" class="button quiet" data-reveal="${escape(item.id)}" aria-expanded="${shown}">${icon('eye')}${shown ? 'Hide text' : 'Show text'}</button><button type="button" class="button quiet" data-listen="${escape(item.id)}" aria-pressed="${listening}">${icon(listening ? 'stop' : 'volume')}${listening ? 'Stop audio' : 'Listen'}</button>${mine ? '' : `<button type="button" class="button quiet chat-report-button" data-report="${escape(item.id)}" aria-label="Report message from ${escape(item.username)}">Report</button>`}</div></div>`;
    }).join('') : '<div class="chat-empty"><h3>You found each other.</h3><p>Send a hello in Morse. The words stay hidden until revealed.</p></div>';
    if (scrollToEnd || nearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = previousTop;
    if (focusedListen) [...list.querySelectorAll('[data-listen]')].find((button) => button.dataset.listen === focusedListen)?.focus({ preventScroll: true });
    else if (focusedReveal) [...list.querySelectorAll('[data-reveal]')].find((button) => button.dataset.reveal === focusedReveal)?.focus({ preventScroll: true });
  }

  function updateBell() {
    renderAccount();
    const count = state.user?.username ? state.inbox.requests.length + (state.inbox.groupRequests || []).length + state.inbox.unread : 0;
    const badge = bell.querySelector('.chat-notification-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = !count;
    bell.setAttribute('aria-label', count ? `Notifications, ${count} new` : 'Notifications');
    if (!notifications.hidden) renderNotifications();
  }

  function renderNotifications() {
    const key = JSON.stringify([state.user, state.inbox.requests, state.inbox.groupRequests, state.inbox.unread]);
    if (key === state.requestKey && notifications.childElementCount) return;
    state.requestKey = key;
    const groupItems = state.inbox.groupRequests || [];
    const friendItems = state.inbox.requests.map((item) => `<div class="chat-request"><p><strong>@${escape(item.username)}</strong> wants to be your friend.</p><div class="chat-request-actions"><button type="button" class="button primary" data-request="${escape(item.id)}" data-accept="true">Accept</button><button type="button" class="button" data-request="${escape(item.id)}" data-accept="false">Decline</button></div></div>`).join('');
    const joinItems = groupItems.map((item) => `<div class="chat-request"><p><strong>@${escape(item.username)}</strong> wants to join <strong>${escape(item.groupName)}</strong>.</p><div class="chat-request-actions"><button type="button" class="button primary" data-group-request="${escape(item.id)}" data-accept="true">Accept</button><button type="button" class="button" data-group-request="${escape(item.id)}" data-accept="false">Decline</button></div></div>`).join('');
    notifications.innerHTML = `<div class="chat-notification-heading"><strong>Notifications</strong><button type="button" class="button quiet" data-notify-close aria-label="Close notifications">${icon('close')}</button></div>${!state.user?.username ? '<p>Sign in to chat for friend requests and messages.</p><button type="button" class="button primary" data-notify-chat>Open chat</button>' : `${friendItems}${joinItems}${state.inbox.unread ? `<p>${escape(state.inbox.unread)} unread ${state.inbox.unread === 1 ? 'signal' : 'signals'} waiting.</p><button type="button" class="button" data-notify-chat>Open conversations</button>` : ''}${!state.inbox.requests.length && !groupItems.length && !state.inbox.unread ? '<p>You are all caught up.</p>' : ''}`}`;
  }

  async function refreshInbox() {
    if (!state.user?.username) return;
    state.inbox = await api('/inbox');
    state.nextInboxAt = Date.now() + (state.active ? 30000 : 60000);
    state.inbox.friends ||= []; state.inbox.requests ||= []; state.inbox.groupRequests ||= []; state.inbox.conversations ||= []; state.inbox.unread ||= 0;
    renderList(); updateBell();
  }

  async function selectConversation(id) {
    saveDraft();
    stopAudio();
    const fetchId = ++state.fetchId;
    state.selected = String(id); state.conversation = null; state.draft = ''; state.view = 'conversation'; updateConversationLayout();
    panel.querySelector('.chat-shell')?.setAttribute('data-view', 'conversation');
    renderList();
    const view = panel.querySelector('.chat-conversation');
    if (view) view.innerHTML = '<div class="chat-empty" role="status">Receiving this conversation...</div>';
    try {
      const data = await api(`/conversations/${encodeURIComponent(id)}`);
      if (fetchId !== state.fetchId || !state.active) return;
      state.conversation = data.conversation; state.members = data.members || []; state.messages = data.messages || [];
      state.cursor = state.messages.at(-1)?.id || 0; state.readCursor = 0; state.hasMore = Boolean(data.hasMore);
      const savedDraft = state.drafts.get(String(id));
      state.composeMode = savedDraft?.mode || state.composeMode;
      state.draftByMode = { text: savedDraft?.text || '', morse: savedDraft?.morse || '' };
      state.draft = state.draftByMode[state.composeMode];
      renderConversation();
      if (state.cursor) {
        const through = state.cursor;
        await api(`/conversations/${encodeURIComponent(id)}/read`, { through });
        if (fetchId !== state.fetchId || !state.active) return;
        state.readCursor = through;
      }
      await refreshInbox();
      status();
      focusComposer();
    } catch (error) {
      if (fetchId !== state.fetchId) return;
      state.selected = null; state.conversation = null; state.view = 'list'; render(); status(error.message, true);
    }
  }

  function saveDraft() {
    updateDraft();
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.busy || !state.selected) return;
    const input = event.target.querySelector('textarea');
    const submit = event.target.querySelector('[type=submit]');
    const id = state.selected;
    const kind = state.composeMode;
    if (kind === 'morse') morseInput.flush();
    const submitted = input.value;
    try {
      const payload = kind === 'morse' ? { kind, morse: submitted } : { kind, text: validateMessage(submitted) };
      if (kind === 'morse') validateMorseMessage(submitted);
      state.busy = true; submit.disabled = true; input.readOnly = true;
      panel.querySelectorAll('.chat-compose [data-morse-key], [data-send-mode]').forEach((button) => { button.disabled = true; });
      // Keep the same id for retries, so a lost response cannot create a second message.
      const pendingMessage = JSON.stringify(payload);
      const pendingKey = `${id}:${kind}`;
      const pending = state.pendingSends.get(pendingKey);
      const clientId = pending?.message === pendingMessage ? pending.clientId : crypto.randomUUID();
      state.pendingSends.set(pendingKey, { message: pendingMessage, clientId });
      const data = await api(`/conversations/${encodeURIComponent(id)}/messages`, { ...payload, clientId });
      state.pendingSends.delete(pendingKey);
      const storedDraft = state.drafts.get(String(id));
      if (storedDraft?.[kind] === submitted) {
        storedDraft[kind] = '';
        if (!storedDraft.text && !storedDraft.morse) state.drafts.delete(String(id));
      }
      if (String(id) === String(state.selected)) {
        if (!state.messages.some((item) => String(item.id) === String(data.message.id))) state.messages.push(data.message);
        state.messages.sort((first, second) => Number(first.id) - Number(second.id));
        state.draftByMode[kind] = '';
        const currentInput = panel.querySelector('#chat-draft');
        if (state.composeMode === kind && currentInput) {
          currentInput.value = ''; state.draft = '';
          if (kind === 'morse') morseInput.replace('');
          updateDraft();
        }
        renderMessages(true); status(); focusComposer();
      }
      await refreshInbox();
    } catch (error) { status(error.message, true); }
    finally {
      state.busy = false; submit.disabled = false;
      const currentInput = panel.querySelector('#chat-draft');
      if (currentInput) currentInput.readOnly = state.composeMode === 'morse' && touchInput.matches;
      panel.querySelectorAll('.chat-compose [data-morse-key], .chat-compose [type=submit], [data-send-mode]').forEach((button) => { button.disabled = false; });
    }
  }

  function stopAudio() {
    morseInput.flush();
    state.audioToken += 1; player.stop(); feedbackPlayer.stop(); state.listening = null;
    renderMessages();
    const preview = panel.querySelector('[data-chat-action=demo-listen]');
    if (preview) preview.innerHTML = `${icon('volume')}Listen`;
  }

  async function listen(text, id) {
    if (state.listening === id) { stopAudio(); return; }
    stopAudio(); onAudioStart();
    state.listening = id;
    const token = state.audioToken;
    renderMessages();
    const preview = panel.querySelector('[data-chat-action=demo-listen]');
    if (id === 'demo' && preview) preview.innerHTML = `${icon('stop')}Stop audio`;
    try {
      const settings = getSound();
      await player.prepare();
      const words = morseText(text).split(' ');
      for (let word = 0; word < words.length; word += 1) {
        for (let letter = 0; letter < words[word].length; letter += 1) {
          if (token !== state.audioToken || !state.active) return;
          if (!await player.playCharacter(words[word][letter], settings)) return;
          const isLast = word === words.length - 1 && letter === words[word].length - 1;
          if (!isLast && !await player.gap(letter === words[word].length - 1 ? getTiming(settings).wordGap : getTiming(settings).characterGap)) return;
        }
      }
    } catch (error) { if (token === state.audioToken) status(error.message || 'Audio could not play. Try Listen again.', true); }
    finally { if (token === state.audioToken) stopAudio(); }
  }

  function safetyDialog(title, body, submitLabel, onSubmit) {
    const previousDialog = document.querySelector('.chat-dialog');
    previousDialog?.close(); previousDialog?.remove();
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    let submitting = false;
    dialog.className = 'chat-dialog chat-safety-dialog';
    dialog.setAttribute('aria-labelledby', 'chat-safety-title');
    dialog.innerHTML = `<form><div class="chat-dialog-header"><h2 id="chat-safety-title">${escape(title)}</h2><button type="button" class="button quiet" data-dialog-close aria-label="Close">${icon('close')}</button></div><div class="chat-dialog-body">${body}<p class="chat-form-help chat-dialog-status" role="status" hidden></p></div><div class="chat-dialog-actions"><button type="button" class="button" data-dialog-close>${submitLabel ? 'Cancel' : 'Close'}</button>${submitLabel ? `<button type="submit" class="button primary">${escape(submitLabel)}</button>` : ''}</div></form>`;
    document.body.append(dialog);
    dialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => { dialog.remove(); if (!document.querySelector('.chat-dialog[open]') && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); });
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = dialog.querySelector('[type=submit]');
      if (!submit || submit.disabled || submitting || !onSubmit) return;
      submitting = true;
      submit.disabled = true;
      try { await onSubmit(new FormData(event.target), dialog); }
      catch (error) {
        const feedback = dialog.querySelector('.chat-dialog-status');
        feedback.hidden = false; feedback.textContent = error.message; feedback.classList.add('chat-error');
      } finally { submitting = false; if (dialog.isConnected) submit.disabled = false; }
    });
    dialog.showModal();
    return dialog;
  }

  function showDeleteAccount() {
    if (!state.user) return;
    const dialog = safetyDialog('Delete your account', `<p class="chat-form-help" id="chat-delete-impact">This permanently removes your chat account, your messages, friendships, and direct conversations. Groups with other members remain. You cannot undo this.</p><p class="chat-form-help">Your Google account and saved training progress on this device stay as they are. <a href="privacy.html#deletion">Read the deletion details</a>.</p><label class="chat-field">Type DELETE to confirm<input name="confirmation" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="6" pattern="DELETE" aria-describedby="chat-delete-impact" required></label>`, 'Delete account', async (data, currentDialog) => {
      if (data.get('confirmation') !== 'DELETE') throw new Error('Type DELETE to confirm.');
      await api('/account/delete', { confirmation: 'DELETE' });
      stopAudio(); state.fetchId += 1; state.user = null;
      state.inbox = { friends: [], requests: [], conversations: [], unread: 0 };
      state.selected = null; state.conversation = null; state.messages = []; state.members = []; state.revealed.clear();
      state.draft = ''; state.draftByMode = { text: '', morse: '' }; state.drafts.clear(); state.pendingSends.clear();
      currentDialog.close(); closeAccount();
      status('Your chat account was deleted. Your saved training progress is still on this device.');
      render(); updateBell();
      window.dispatchEvent(new CustomEvent('morse-native-auth-cleared'));
    });
    const input = dialog.querySelector('[name=confirmation]');
    const submit = dialog.querySelector('[type=submit]');
    submit.classList.add('chat-danger-action'); submit.disabled = true;
    input.addEventListener('input', () => { submit.disabled = input.value !== 'DELETE'; });
    input.focus();
  }

  function showReviewAccess() {
    if (state.user) return;
    safetyDialog('Review access', `<p class="chat-form-help">For app review only. This account uses test conversations and cannot contact ordinary chat accounts.</p><label class="chat-field">Email<input name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required></label><label class="chat-field">Password<input name="password" type="password" autocomplete="current-password" required></label>`, 'Sign in', async (data, dialog) => {
      await api('/auth/reviewer', { email: String(data.get('email')).trim(), password: String(data.get('password')) });
      dialog.close(); closeAccount(); state.ready = false;
      await boot(); status('Review account: conversations use test data.');
    });
  }

  function showBlockPerson(person) {
    if (!state.user?.username || !person?.id || String(person.id) === String(state.user.id)) return;
    const username = person.username || 'this person';
    safetyDialog(`Block @${username}?`, `<p class="chat-form-help">They will not be able to send you direct messages or friend requests. Their messages in shared groups will be hidden from you.</p><p class="chat-form-help">You can unblock them later from your account menu. Unblocking does not restore a friendship automatically.</p>`, 'Block person', async (_data, dialog) => {
      const selected = state.selected;
      const isDirect = state.conversation?.type === 'direct';
      await api('/blocks', { userId: String(person.id) });
      saveDraft(); stopAudio(); state.fetchId += 1;
      state.messages = state.messages.filter((message) => String(message.senderId) !== String(person.id));
      if (isDirect) {
        state.drafts.delete(String(selected)); state.pendingSends.delete(String(selected));
        state.selected = null; state.conversation = null; state.messages = []; state.members = []; state.view = 'list';
        state.draft = ''; state.draftByMode = { text: '', morse: '' }; render();
      }
      dialog.close(); await refreshInbox();
      if (!isDirect && selected && state.active) await selectConversation(selected);
      status(`@${username} is blocked.`);
    });
  }

  async function showBlockedPeople() {
    if (!state.user?.username) return;
    const dialog = safetyDialog('Blocked people', '<p class="chat-form-help">Unblocking lets someone send you a new friend request.</p><div class="chat-blocked-list" role="status">Loading...</div>', '', null);
    const list = dialog.querySelector('.chat-blocked-list');
    async function refresh() {
      const data = await api('/blocks');
      if (!dialog.isConnected) return;
      list.innerHTML = data.blocks?.length ? data.blocks.map((person) => `<div class="chat-blocked-person"><strong>@${escape(person.username)}</strong><button type="button" class="button" data-unblock="${escape(person.id)}">Unblock</button></div>`).join('') : '<p class="chat-form-help">You have not blocked anyone.</p>';
    }
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-unblock]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try { await api('/blocks/remove', { userId: button.dataset.unblock }); await refresh(); await refreshInbox(); }
      catch (error) {
        const feedback = dialog.querySelector('.chat-dialog-status');
        feedback.hidden = false; feedback.textContent = error.message; feedback.classList.add('chat-error');
        button.disabled = false;
      }
    });
    try { await refresh(); }
    catch (error) { if (dialog.isConnected) { list.textContent = error.message; list.classList.add('chat-error'); } }
  }

  function showReport(message) {
    if (!message || String(message.senderId) === String(state.user?.id)) return;
    const dialog = safetyDialog('Report a message', `<p class="chat-form-help">The message and your reason will be sent to the developer for review. The other person will not see your report.</p><label class="chat-field">Reason<select name="reason" required><option value="spam">Spam</option><option value="harassment">Harassment or bullying</option><option value="hate">Hate or discrimination</option><option value="sexual_content">Sexual content</option><option value="threats">Threats or danger</option><option value="other">Something else</option></select></label><label class="chat-field">Details (optional)<textarea name="details" rows="3" maxlength="1000" placeholder="What happened?"></textarea></label><button type="button" class="button quiet" data-report-block>Block @${escape(message.username)}</button>`, 'Send report', async (data, currentDialog) => {
      await api('/reports', { messageId: Number(message.id), reason: String(data.get('reason')), details: String(data.get('details') || '').trim() });
      currentDialog.close(); status('Report received. The developer will review it.');
    });
    dialog.querySelector('[data-report-block]').addEventListener('click', () => { dialog.close(); showBlockPerson({ id: message.senderId, username: message.username }); });
  }

  function showDialog(kind, initialCode = '') {
    document.querySelector('.chat-dialog')?.remove();
    const settings = {
      friend: { title: 'Add a friend', label: 'Username or email', name: 'target', placeholder: 'user123 or friend@example.com', help: 'Your friend needs a chat account. They accept your request before you can message each other.', submit: 'Send request' },
      profile: { title: 'Edit username', label: 'Username', name: 'username', placeholder: 'user123', help: 'Use 3 to 24 letters, numbers, or underscores. Your friends will see your new username.', submit: 'Save username' },
      'new-group': { title: 'Create a group', label: 'Group name', name: 'name', placeholder: 'The evening signals', help: 'Up to 100 members. As creator, you approve public join requests and can remove members.', submit: 'Create group' },
      'join-group': { title: 'Join a group', label: 'Invite code or link', name: 'code', placeholder: 'Paste a code or invite link', help: 'Ask a group member for their code or invite link.', submit: 'Join group' },
    }[kind];
    if (!settings || !state.user?.username) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'chat-dialog';
    dialog.innerHTML = `<form><div class="chat-dialog-header"><h2>${settings.title}</h2><button type="button" class="button quiet" data-dialog-close aria-label="Close">${icon('close')}</button></div><div class="chat-dialog-body"><label class="chat-field">${settings.label}<input name="${settings.name}" placeholder="${settings.placeholder}" value="${escape(initialCode)}" maxlength="${kind === 'new-group' ? 60 : 254}" required ${kind === 'new-group' ? 'minlength="2"' : ''}></label>${kind === 'new-group' ? '<label class="chat-field">Who can find this group?<select name="visibility"><option value="private">Private: join with a code or link</option><option value="public">Public: discover and request to join</option></select></label>' : ''}<p class="chat-form-help">${settings.help}</p><p class="chat-form-help chat-dialog-status" role="status" hidden></p></div><div class="chat-dialog-actions"><button type="button" class="button" data-dialog-close>Cancel</button><button type="submit" class="button primary">${settings.submit}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (kind === 'join-group' && initialCode) {
        state.joinConsumed = true;
        try { sessionStorage.removeItem('morse-room-join'); } catch { /* Cancel also dismisses the current invite. */ }
        const url = new URL(location.href); url.searchParams.delete('join'); history.replaceState(null, '', url);
      }
    });
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = event.target.querySelector('[type=submit]');
      if (submit.disabled) return;
      submit.disabled = true;
      const feedback = dialog.querySelector('.chat-dialog-status');
      try {
        let value = String(new FormData(event.target).get(settings.name)).trim();
        if (kind === 'profile') {
          await api('/profile', { username: validateUsername(value) });
          state.user = (await api('/me')).user;
          dialog.close(); await refreshInbox(); render(); renderAccount();
        } else if (kind === 'friend') {
          await api('/friends/request', { target: value.replace(/^@/, '') });
          dialog.close(); status('Request sent. Your friend can accept it from the notification bell.');
        } else {
          if (kind === 'join-group' && /^https?:\/\//i.test(value)) value = new URL(value).searchParams.get('join') || '';
          const data = await api(kind === 'new-group' ? '/groups' : '/groups/join', kind === 'new-group' ? { name: value, visibility: new FormData(event.target).get('visibility') } : { code: value });
          try { sessionStorage.removeItem('morse-room-join'); } catch { /* No saved invite remains. */ }
          state.joinConsumed = true;
          const url = new URL(location.href); url.searchParams.delete('join'); history.replaceState(null, '', url);
          dialog.close(); await refreshInbox();
          if (data.requested) { status('Join request sent. The group creator will accept or decline it.'); return; }
          await selectConversation(data.conversation.id);
          if (kind === 'new-group') showInvite();
        }
      } catch (error) { feedback.hidden = false; feedback.textContent = error.message; feedback.classList.add('chat-error'); }
      finally { submit.disabled = false; }
    });
  }

  async function showPublicGroups() {
    const dialog = safetyDialog('Find public groups', '<label class="chat-field">Search by group name<input name="group-search" type="search" placeholder="Find a listening group" maxlength="60" autocomplete="off"></label><p class="chat-form-help">The creator approves join requests. Private groups never appear here.</p><div class="chat-public-groups" role="status">Loading groups...</div>', '', null);
    const list = dialog.querySelector('.chat-public-groups');
    const input = dialog.querySelector('[name=group-search]');
    let searchToken = 0;
    let searchTimer;
    async function load() {
      const token = ++searchToken;
      try {
        const data = await api(`/groups/public?q=${encodeURIComponent(input.value.trim())}`);
        if (!dialog.isConnected || token !== searchToken) return;
        list.innerHTML = data.groups.length ? data.groups.map((group) => `<div class="chat-public-group"><div class="chat-item-copy"><strong>${escape(group.name)}</strong><small>${group.memberCount}/100 members</small></div><button type="button" class="button ${group.joined ? '' : 'primary'}" data-public-group="${escape(group.id)}" data-joined="${group.joined}" ${group.requested || (!group.joined && group.memberCount >= 100) ? 'disabled' : ''}>${group.joined ? 'Open' : group.requested ? 'Requested' : group.memberCount >= 100 ? 'Full' : 'Request to join'}</button></div>`).join('') : '<p>No public groups found. Try another name or create one.</p>';
      } catch (error) { if (dialog.isConnected && token === searchToken) list.textContent = error.message; }
    }
    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void load(); }, 250); });
    dialog.addEventListener('close', () => { searchToken += 1; clearTimeout(searchTimer); });
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-public-group]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        if (button.dataset.joined === 'true') { dialog.close(); await selectConversation(button.dataset.publicGroup); return; }
        const result = await api('/groups/request', { groupId: button.dataset.publicGroup });
        if (result.joined) { dialog.close(); await refreshInbox(); await selectConversation(result.conversation.id); return; }
        button.textContent = 'Requested';
        status('Join request sent. The group creator will review it.');
      } catch (error) {
        const feedback = dialog.querySelector('.chat-dialog-status');
        feedback.hidden = false; feedback.textContent = error.message; feedback.classList.add('chat-error'); button.disabled = false;
      }
    });
    await load();
  }

  function showGroupMembers() {
    const room = state.conversation;
    if (!room || room.type !== 'group') return;
    const owner = room.ownerId === state.user.id;
    const dialog = safetyDialog(`${room.name}: ${state.members.length}/100`, `<div class="chat-group-members">${state.members.map((member) => `<div class="chat-public-group"><div class="chat-item-copy"><strong>@${escape(member.username)}</strong><small>${member.id === room.ownerId ? 'Creator' : 'Member'}</small></div>${owner && member.id !== state.user.id ? `<button type="button" class="button quiet chat-danger-action" data-remove-member="${escape(member.id)}">Remove</button>` : ''}</div>`).join('')}</div>${owner ? '<p class="chat-form-help">Removed members lose access and cannot rejoin with an old invite.</p>' : ''}`, '', null);
    dialog.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-member]');
      if (!remove || remove.disabled) return;
      const member = state.members.find((item) => item.id === remove.dataset.removeMember);
      if (!member) return;
      dialog.close();
      safetyDialog(`Remove @${member.username}?`, `<p class="chat-form-help">They will lose access to ${escape(room.name)} and will not be able to rejoin with the current invite.</p>`, 'Remove member', async (_form, confirmation) => {
        await api('/groups/kick', { groupId: room.id, userId: member.id });
        confirmation.close(); await refreshInbox();
        if (state.selected === room.id && state.active) await selectConversation(room.id);
      });
    });
  }

  function showInvite() {
    const node = panel.querySelector('.chat-invite-details');
    if (!node || !state.conversation?.code) return;
    const code = state.conversation.code;
    const link = `${location.origin}/?join=${encodeURIComponent(code)}`;
    node.innerHTML = `<div><span class="small-label">${state.conversation.visibility === 'public' ? 'PUBLIC GROUP INVITE' : 'PRIVATE GROUP INVITE'}</span><strong class="chat-invite-code">${escape(code)}</strong><small>${state.conversation.visibility === 'public' ? 'People can request to join. The creator approves each request.' : 'Share this only with people you want in the group.'}</small></div><div class="chat-invite-actions">${action('copy-code', 'Copy code', 'copy')}${action('copy-link', 'Copy link', 'link')}</div>`;
    node.hidden = !node.hidden;
    node.dataset.code = code; node.dataset.link = link;
  }

  async function offerPendingJoin() {
    if (state.joinConsumed) return;
    let code = requestedJoin;
    try { code = sessionStorage.getItem('morse-room-join') || code; } catch { /* Use the current invite URL. */ }
    if (state.active && state.user?.username && code) showDialog('join-group', code);
  }

  async function poll() {
    if (!state.ready || !state.user?.username || state.pollBusy || document.hidden || Date.now() < state.retryAt) return;
    state.pollBusy = true;
    try {
      if (Date.now() >= state.nextInboxAt) await refreshInbox();
      if (state.active && state.view === 'conversation' && state.selected && state.conversation) {
        const id = state.selected;
        const after = state.cursor;
        const data = await api(`/conversations/${encodeURIComponent(id)}?after=${encodeURIComponent(after)}`);
        if (String(id) === String(state.selected) && state.active && state.view === 'conversation') {
          const newMessages = (data.messages || []).filter((item) => !state.messages.some((existing) => String(item.id) === String(existing.id)));
          if (data.messages?.length) state.cursor = data.messages.at(-1).id;
          if (newMessages.length) {
            state.messages.push(...newMessages);
            state.messages.sort((first, second) => Number(first.id) - Number(second.id));
            renderMessages();
            const live = panel.querySelector('.chat-new-signal');
            if (live) { live.hidden = false; live.textContent = `${newMessages.length} new ${newMessages.length === 1 ? 'signal' : 'signals'} received.`; }
          }
          state.members = data.members || state.members;
          state.conversation = data.conversation || state.conversation;
          const summary = panel.querySelector('.chat-member-summary');
          if (summary && state.conversation.type === 'group') summary.textContent = `${state.conversation.visibility === 'public' ? 'Public' : 'Private'} · ${state.members.length}/100 members`;
          if (state.cursor > state.readCursor) {
            const through = state.cursor;
            await api(`/conversations/${encodeURIComponent(id)}/read`, { through });
            if (String(id) !== String(state.selected) || !state.active) return;
            state.readCursor = through;
            // Keep the bell in step with messages just received, without a second inbox request.
            const room = state.inbox.conversations.find((item) => String(item.id) === String(id));
            if (room?.unread) { state.inbox.unread = Math.max(0, state.inbox.unread - room.unread); room.unread = 0; renderList(); updateBell(); }
          }
        }
      }
      if (state.statusError && state.status.startsWith('Connection')) status();
      state.failures = 0; state.retryAt = 0;
    } catch (error) {
      if (error.status === 401) {
        state.user = null; state.inbox = { friends: [], requests: [], conversations: [], unread: 0 };
        stopAudio(); render(); updateBell(); status('Your session ended. Sign in again to continue.', true);
      } else if (error.status === 404 && state.selected && state.conversation?.type === 'group') {
        saveDraft(); stopAudio(); state.fetchId += 1;
        state.selected = null; state.conversation = null; state.messages = []; state.members = []; state.view = 'list';
        await refreshInbox().catch(() => {}); render(); status('This group is no longer available to you.', true);
      } else {
        state.failures += 1;
        state.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(4, state.failures));
        if (state.active) status('Connection interrupted. We will try again. Your typed message is still here.', true);
      }
    } finally { state.pollBusy = false; }
  }

  panel.addEventListener('click', async (event) => {
    const sendMode = event.target.closest('[data-send-mode]');
    if (sendMode) {
      const nextMode = sendMode.dataset.sendMode;
      if (!state.busy && ['text', 'morse'].includes(nextMode) && nextMode !== state.composeMode) {
        if (state.composeMode === 'morse') morseInput.flush();
        saveDraft();
        if (state.composeMode === 'morse' && nextMode === 'text' && state.draft.trim()) {
          try { state.draftByMode.text = decodeMorse(state.draft); }
          catch (error) { status(error.message, true); return; }
        }
        stopAudio(); state.composeMode = nextMode; status();
        if (touchInput.matches) panel.querySelector('#chat-draft')?.blur();
        updateComposer(); focusComposer();
      }
      return;
    }
    const conversation = event.target.closest('[data-conversation]');
    if (conversation) { await selectConversation(conversation.dataset.conversation); return; }
    const reveal = event.target.closest('[data-reveal]');
    if (reveal) {
      const id = reveal.dataset.reveal;
      if (state.revealed.has(id)) state.revealed.delete(id); else state.revealed.add(id);
      // Update in place so keyboard focus stays on the button.
      const text = reveal.closest('.chat-message-row').querySelector('.chat-message-text');
      const shown = state.revealed.has(id);
      text.classList.toggle('is-concealed', !shown); text.setAttribute('aria-hidden', String(!shown));
      text.parentElement.classList.toggle('is-revealed', shown);
      text.parentElement.querySelector('.chat-message-morse')?.setAttribute('aria-hidden', String(shown));
      reveal.setAttribute('aria-expanded', String(shown));
      reveal.innerHTML = `${icon('eye')}${shown ? 'Hide text' : 'Show text'}`;
      return;
    }
    const audio = event.target.closest('[data-listen]');
    if (audio) { const item = state.messages.find((item) => String(item.id) === audio.dataset.listen); if (item) await listen(item.text, String(item.id)); return; }
    const report = event.target.closest('[data-report]');
    if (report) { showReport(state.messages.find((item) => String(item.id) === report.dataset.report)); return; }
    const button = event.target.closest('[data-chat-action]');
    if (!button) return;
    switch (button.dataset.chatAction) {
      case 'retry':
        state.ready = false; render(); await boot(); break;
      case 'friend': case 'new-group': case 'join-group': showDialog(button.dataset.chatAction); break;
      case 'public-groups': await showPublicGroups(); break;
      case 'members': showGroupMembers(); break;
      case 'block': showBlockPerson(state.conversation?.peer); break;
      case 'review-access': showReviewAccess(); break;
      case 'earlier': {
        if (!state.selected || button.disabled) break;
        const id = state.selected;
        button.disabled = true;
        try {
          const list = panel.querySelector('.chat-message-list');
          const height = list.scrollHeight; const top = list.scrollTop;
          const data = await api(`/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(state.messages[0]?.id || 0)}`);
          if (String(id) !== String(state.selected)) break;
          state.messages.unshift(...(data.messages || []).filter((item) => !state.messages.some((existing) => String(item.id) === String(existing.id))));
          state.hasMore = Boolean(data.hasMore);
          renderMessages();
          list.scrollTop = top + list.scrollHeight - height;
          panel.querySelector('.chat-history-actions').hidden = !state.hasMore;
        } catch (error) { status(error.message, true); }
        finally { button.disabled = false; }
        break;
      }
      case 'back': saveDraft(); state.view = 'list'; panel.querySelector('.chat-shell').dataset.view = 'list'; updateConversationLayout(); break;
      case 'invite': showInvite(); break;
      case 'copy-code': case 'copy-link': {
        const value = panel.querySelector('.chat-invite-details')?.dataset[button.dataset.chatAction === 'copy-code' ? 'code' : 'link'];
        try { await navigator.clipboard.writeText(value); status(button.dataset.chatAction === 'copy-code' ? 'Invite code copied.' : 'Invite link copied.'); }
        catch { status(`Copy this invite: ${value}`); }
        break;
      }
      case 'logout':
        await logout();
        break;
      case 'demo-reveal': {
        const text = panel.querySelector('#chat-demo-text');
        const shown = text.classList.contains('is-concealed');
        text.classList.toggle('is-concealed', !shown); text.setAttribute('aria-hidden', String(!shown));
        text.parentElement.classList.toggle('is-revealed', shown);
        text.parentElement.querySelector('.chat-message-morse')?.setAttribute('aria-hidden', String(shown));
        button.innerHTML = `${icon('eye')}${shown ? 'Hide text' : 'Show text'}`; button.setAttribute('aria-expanded', String(shown));
        break;
      }
      case 'demo-listen': await listen('Hello friend', 'demo'); break;
    }
  });

  bell.addEventListener('click', () => {
    closeAccount();
    notifications.hidden = !notifications.hidden;
    bell.setAttribute('aria-expanded', String(!notifications.hidden));
    if (!notifications.hidden) {
      renderNotifications(); notifications.querySelector('button')?.focus();
      if (state.user?.username) void refreshInbox().catch(() => {});
    }
  });
  function closeNotifications() { notifications.hidden = true; bell.setAttribute('aria-expanded', 'false'); }
  accountToggle.addEventListener('click', () => {
    closeNotifications();
    accountMenu.hidden = !accountMenu.hidden;
    accountToggle.setAttribute('aria-expanded', String(!accountMenu.hidden));
    if (!accountMenu.hidden) accountMenu.querySelector('button,a[href]')?.focus();
  });
  accountMenu.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-chat-action]');
    if (!button || button.disabled) return;
    if (button.dataset.chatAction === 'logout') {
      button.disabled = true; await logout(); button.disabled = false;
    } else if (button.dataset.chatAction === 'open-chat') {
      closeAccount(); onEnter();
    } else if (button.dataset.chatAction === 'profile') {
      closeAccount(); showDialog('profile', state.user.username);
    } else if (button.dataset.chatAction === 'delete-account') {
      closeAccount(); showDeleteAccount();
    } else if (button.dataset.chatAction === 'blocked') {
      closeAccount(); await showBlockedPeople();
    } else if (button.dataset.chatAction === 'review-access') {
      closeAccount(); showReviewAccess();
    } else if (button.dataset.chatAction === 'notification-settings') {
      closeAccount(); window.dispatchEvent(new CustomEvent('morse-native-notification-settings'));
    }
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.account-control')) closeAccount(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !accountMenu.hidden) { closeAccount(); accountToggle.focus(); } });
  document.addEventListener('click', (event) => { if (!event.target.closest('.chat-notification-wrap')) closeNotifications(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !notifications.hidden) { closeNotifications(); bell.focus(); } });
  notifications.addEventListener('click', async (event) => {
    if (event.target.closest('[data-notify-close]')) { closeNotifications(); bell.focus(); return; }
    if (event.target.closest('[data-notify-chat]')) { closeNotifications(); onEnter(); return; }
    const request = event.target.closest('[data-request], [data-group-request]');
    if (!request) return;
    request.disabled = true;
    try {
      await api(request.dataset.groupRequest ? '/groups/respond' : '/friends/respond', { id: request.dataset.groupRequest || request.dataset.request, accept: request.dataset.accept === 'true' });
      await refreshInbox();
    } catch (error) {
      const node = document.createElement('p'); node.className = 'chat-error'; node.textContent = error.message; request.closest('.chat-request').append(node);
      request.disabled = false;
    }
  });

  async function boot() {
    try {
      state.config = await api('/config');
      state.user = state.config.available ? (await api('/me')).user : null;
      if (state.user?.username) await refreshInbox();
    } catch { state.config = { available: false, providers: {} }; }
    finally { state.ready = true; render(); updateBell(); await offerPendingJoin(); }
    if (authError) {
      const url = new URL(location.href); url.searchParams.delete('chat_error'); history.replaceState(null, '', url);
    }
  }
  function updateInputMode() {
    if (state.active && panel.querySelector('#chat-draft')) {
      saveDraft(); morseInput.flush(); updateComposer();
      if (state.composeMode === 'morse' && touchInput.matches) panel.querySelector('#chat-draft').blur();
    }
  }
  mobile.addEventListener('change', updateInputMode);
  touchInput.addEventListener('change', updateInputMode);
  let nativeAuthRefreshing = false;
  window.addEventListener('morse-native-open-conversation', async ({ detail = {} }) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(detail.conversationId || '')) return;
    if (!state.ready) await boot();
    closeAccount(); closeNotifications(); onEnter();
    if (state.user?.username) await selectConversation(detail.conversationId);
    else status('Sign in to open this conversation.');
  });
  window.addEventListener('morse-native-auth-complete', () => {
    if (nativeAuthRefreshing) return;
    nativeAuthRefreshing = true;
    saveDraft(); stopAudio(); state.fetchId += 1;
    state.ready = false; state.user = null;
    state.selected = null; state.conversation = null; state.messages = []; state.members = []; state.revealed.clear();
    state.draft = ''; state.draftByMode = { text: '', morse: '' }; state.drafts.clear(); state.pendingSends.clear();
    state.inbox = { friends: [], requests: [], conversations: [], unread: 0 };
    render();
    void boot().finally(() => { nativeAuthRefreshing = false; });
  });
  window.addEventListener('resize', () => {
    const input = panel.querySelector('#chat-draft');
    if (state.active && input) growComposer(input);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.chat-code-info')) {
      const note = panel.querySelector('.chat-code-info');
      if (note) note.open = false;
    }
  });
  void boot();
  let timer = setInterval(() => { void poll(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('pagehide', () => { stopAudio(); clearInterval(timer); });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { timer = setInterval(() => { void poll(); }, 5000); void poll(); }
  });
  return {
    open() { state.active = true; render(); if (state.ready) { void poll(); void offerPendingJoin(); } },
    close() { pressControls.cancel(); saveDraft(); state.active = false; updateConversationLayout(); stopAudio(); closeNotifications(); document.querySelector('.chat-dialog')?.close(); },
    stopAudio,
  };
}
