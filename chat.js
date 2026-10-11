import { MorsePlayer, getTiming } from './audio.js';
import { morseText, validateMessage, validateUsername, MAX_MESSAGE_LENGTH } from './chat-codec.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const action = (name, text, symbol, classes = '') => `<button type="button" class="button ${classes}" data-chat-action="${name}">${symbol ? icon(symbol) : ''}${text}</button>`;
const dateLabel = (value) => {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function createChatRoom({ panel, bell, notifications, onEnter, onAudioStart, getVolume }) {
  const state = {
    active: false, ready: false, config: { available: false, providers: {} }, user: null,
    inbox: { friends: [], requests: [], conversations: [], unread: 0 }, conversation: null,
    members: [], messages: [], selected: null, view: 'list', draft: '', busy: false,
    revealed: new Set(), listening: null, audioToken: 0, loading: false, pollBusy: false,
    status: '', statusError: false, listKey: '', requestKey: '', messageKey: '', fetchId: 0,
    cursor: 0, readCursor: 0, nextInboxAt: 0, hasMore: false, joinConsumed: false, drafts: new Map(),
    retryAt: 0, failures: 0,
  };
  const player = new MorsePlayer();
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

  function render() {
    if (!state.active) return;
    if (!state.ready) {
      panel.innerHTML = '<div class="chat-empty" role="status">Opening Morse Chat Room...</div>';
      return;
    }
    if (!state.user) { renderWelcome(); return; }
    if (!state.user.username) { renderProfile(); return; }
    panel.innerHTML = `<div class="chat-page-heading"><div><div class="eyebrow">A CONVERSATION WORTH LISTENING TO</div><h1>Morse Chat Room</h1><p>Send a thought. Receive a signal.</p></div></div>
      <p class="chat-status ${state.statusError ? 'chat-error' : ''}" role="status" ${state.status ? '' : 'hidden'}>${escape(state.status)}</p>
      <div class="chat-shell" data-view="${state.view}">
        <aside class="chat-sidebar" aria-label="Your conversations">
          <div class="chat-profile">${avatar(state.user.username)}<div class="chat-item-copy"><strong>@${escape(state.user.username)}</strong><small>Your listening circle</small></div>${action('logout', 'Sign out', '', 'quiet chat-signout')}</div>
          <div class="chat-toolbar">${action('friend', 'Add friend', 'user-plus')}${action('new-group', 'New group', 'users')}${action('join-group', 'Join group', 'link')}</div>
          <div class="chat-list-heading"><strong>Conversations</strong><span id="chat-conversation-count">${state.inbox.conversations.length}</span></div>
          <div class="chat-conversation-list"></div>
          <p class="chat-sidebar-note">Friends accept your request before you can chat. Groups are invite only.</p>
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
      <div class="chat-intro-copy"><div class="eyebrow">FROM ONE EAR TO ANOTHER</div><h1>Morse Chat Room</h1><p>A real conversation. A little code. A better ear.</p>
      <ul class="chat-feature-list"><li>${icon('user-plus')}Find friends by username or email.</li><li>${icon('users')}Make a private group. Invite by code or link.</li><li>${icon('volume')}Read the Morse, listen, or reveal the words.</li></ul>
      <div class="chat-auth-actions"><a class="button chat-provider-button ${available ? '' : 'is-disabled'}" ${available ? 'href="/api/auth/google"' : 'aria-disabled="true"'}><span class="sr-only">Sign in with Google</span><img class="chat-google-light" src="google-signin-light.png" width="180" height="40" alt="" aria-hidden="true"><img class="chat-google-dark" src="google-signin-dark.png" width="180" height="40" alt="" aria-hidden="true"></a></div>
      <p class="chat-form-help">${available ? 'Pick a username after signing in. Learn and Practice stay free, with no account needed.' : 'Chat is being connected. Every lesson and practice session is available now.'}</p>
      ${available ? '' : action('retry', 'Check again', 'replay', 'quiet')}
      <p class="chat-status ${state.statusError ? 'chat-error' : ''}" role="status" ${state.status ? '' : 'hidden'}>${escape(state.status)}</p>
      <p class="chat-legal">By using chat, you agree to the <a href="terms.html">chat terms</a>. Read our <a href="privacy.html">privacy notice</a>.</p></div>
      <div class="chat-demo"><span class="small-label">A LITTLE PREVIEW</span><div class="chat-message"><div class="chat-message-meta"><strong>A friendly signal</strong><span>Example</span></div><p class="chat-message-morse">.... .. / -- -.-- / -. .- -- . / .. ... / .-.. . .-.. .. -.</p><p class="chat-message-text" id="chat-demo-text" hidden>Hi my name is Lelin</p><div class="chat-message-actions">${action('demo-reveal', 'Show text', 'eye')}${action('demo-listen', 'Listen', 'volume')}</div></div><p>Try listening first. Reveal the words whenever you like.</p><p class="chat-code-note">${icon('info')}<span>Morse code includes only letters and numbers. Show text displays your message exactly as typed.</span></p></div>
    </div>`;
  }

  function renderProfile() {
    panel.innerHTML = `<div class="chat-intro chat-profile-intro"><div class="chat-intro-copy"><div class="eyebrow">YOUR FIRST SIGNAL</div><h1>What should we call you?</h1><p>Choose a username so friends can find you. Your email stays out of your public profile.</p>
      <form class="chat-profile-form"><label class="chat-field">Username<input name="username" autocomplete="username" placeholder="e.g. lelin" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required></label><p class="chat-form-help">3 to 24 letters, numbers, or underscores. Each username is unique.</p><p class="chat-status" role="status" hidden></p><button class="button primary" type="submit">Enter chat ${icon('arrow')}</button> ${action('logout', 'Sign out', '', 'quiet')}</form></div></div>`;
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
    list.innerHTML = state.inbox.conversations.length ? state.inbox.conversations.map((item) => `<button type="button" class="chat-conversation-item ${String(item.id) === String(state.selected) ? 'active' : ''}" data-conversation="${escape(item.id)}" ${String(item.id) === String(state.selected) ? 'aria-current="true"' : ''}>${item.type === 'group' ? `<span class="chat-item-avatar">${icon('users')}</span>` : avatar(item.name)}<span class="chat-item-copy"><strong>${escape(item.type === 'direct' ? `@${item.name}` : item.name)}</strong><small>${item.type === 'group' ? 'Private group' : 'Friend'}</small></span><span class="chat-item-meta">${item.unread ? `<b>${escape(item.unread)}</b><span class="sr-only">unread messages</span>` : icon('arrow')}</span></button>`).join('') : '<div class="chat-empty chat-list-empty"><p>No conversations yet.</p><small>A friend request is a good first step.</small></div>';
    if (focusedId) [...list.querySelectorAll('[data-conversation]')].find((button) => button.dataset.conversation === focusedId)?.focus({ preventScroll: true });
  }

  function renderConversation() {
    const room = state.conversation;
    const view = panel.querySelector('.chat-conversation');
    if (!view || !room) return;
    view.innerHTML = `<header class="chat-conversation-header">${action('back', 'Back', 'back', 'quiet chat-mobile-back')}<div class="chat-item-copy"><h2 title="${escape(room.name)}">${escape(room.type === 'direct' ? `@${room.name}` : room.name)}</h2><small class="chat-member-summary">${room.type === 'group' ? `${state.members.length} members` : 'Morse messages between friends'}</small></div>${room.type === 'group' ? action('invite', 'Invite', 'link') : ''}</header>
      ${room.type === 'group' ? '<div class="chat-invite-details" hidden></div>' : ''}
      <div class="chat-history-actions" ${state.hasMore ? '' : 'hidden'}>${action('earlier', 'Load earlier signals', 'replay')}</div>
      <div class="chat-message-list" aria-label="Messages"></div>
      <p class="chat-new-signal" role="status" aria-live="polite" hidden></p>
      <form class="chat-compose"><label for="chat-draft" class="sr-only">Message to send as Morse code</label><textarea id="chat-draft" name="text" rows="2" maxlength="${MAX_MESSAGE_LENGTH}" placeholder="Type a message. We send it as Morse." aria-describedby="chat-code-note" required></textarea><div class="chat-compose-meta"><span>Enter to send · Shift + Enter for a new line</span><span id="chat-draft-count">0 / 1,000</span></div><p class="chat-code-note" id="chat-code-note">${icon('info')}<span>Morse code includes only letters and numbers. Show text displays your message exactly as typed.</span></p><div class="chat-compose-footer"><span>Audio: 18 WPM · 600 Hz</span><button type="submit" class="button primary">Send signal ${icon('send')}</button></div></form>`;
    state.messageKey = '';
    renderMessages(true);
    const draft = view.querySelector('#chat-draft');
    draft.value = state.draft;
    const update = () => { state.draft = draft.value; view.querySelector('#chat-draft-count').textContent = `${draft.value.length} / 1,000`; };
    update();
    draft.addEventListener('input', update);
    draft.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.repeat) {
        event.preventDefault(); view.querySelector('.chat-compose').requestSubmit();
      }
    });
    view.querySelector('.chat-compose').addEventListener('submit', sendMessage);
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
    list.innerHTML = state.messages.length ? state.messages.map((item) => `<article class="chat-message ${String(item.senderId) === String(state.user.id) ? 'mine' : ''}" data-message="${escape(item.id)}"><div class="chat-message-meta"><strong>@${escape(item.username)}</strong><time>${escape(dateLabel(item.createdAt))}</time></div><p class="chat-message-morse" aria-label="Morse code message">${escape(item.morse)}</p><p class="chat-message-text" ${state.revealed.has(String(item.id)) ? '' : 'hidden'}>${escape(item.text)}</p><div class="chat-message-actions"><button type="button" class="button quiet" data-reveal="${escape(item.id)}" aria-expanded="${state.revealed.has(String(item.id))}">${icon('eye')}${state.revealed.has(String(item.id)) ? 'Hide text' : 'Show text'}</button><button type="button" class="button quiet" data-listen="${escape(item.id)}" aria-pressed="${state.listening === String(item.id)}">${icon(state.listening === String(item.id) ? 'stop' : 'volume')}${state.listening === String(item.id) ? 'Stop audio' : 'Listen'}</button></div></article>`).join('') : '<div class="chat-empty"><h3>You found each other.</h3><p>Send a hello in Morse. The words stay hidden until revealed.</p></div>';
    if (scrollToEnd || nearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = previousTop;
    if (focusedListen) [...list.querySelectorAll('[data-listen]')].find((button) => button.dataset.listen === focusedListen)?.focus({ preventScroll: true });
    else if (focusedReveal) [...list.querySelectorAll('[data-reveal]')].find((button) => button.dataset.reveal === focusedReveal)?.focus({ preventScroll: true });
  }

  function updateBell() {
    const count = state.user?.username ? state.inbox.requests.length + state.inbox.unread : 0;
    const badge = bell.querySelector('.chat-notification-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = !count;
    bell.setAttribute('aria-label', count ? `Notifications, ${count} new` : 'Notifications');
    if (!notifications.hidden) renderNotifications();
  }

  function renderNotifications() {
    const key = JSON.stringify([state.user, state.inbox.requests, state.inbox.unread]);
    if (key === state.requestKey && notifications.childElementCount) return;
    state.requestKey = key;
    notifications.innerHTML = `<div class="chat-notification-heading"><strong>Notifications</strong><button type="button" class="button quiet" data-notify-close aria-label="Close notifications">${icon('close')}</button></div>${!state.user?.username ? '<p>Sign in to chat for friend requests and messages.</p><button type="button" class="button primary" data-notify-chat>Open chat</button>' : `${state.inbox.requests.map((item) => `<div class="chat-request"><p><strong>@${escape(item.username)}</strong> wants to be your friend.</p><div class="chat-request-actions"><button type="button" class="button primary" data-request="${escape(item.id)}" data-accept="true">Accept</button><button type="button" class="button" data-request="${escape(item.id)}" data-accept="false">Decline</button></div></div>`).join('')}${state.inbox.unread ? `<p>${escape(state.inbox.unread)} unread ${state.inbox.unread === 1 ? 'signal' : 'signals'} waiting.</p><button type="button" class="button" data-notify-chat>Open conversations</button>` : ''}${!state.inbox.requests.length && !state.inbox.unread ? '<p>You are all caught up.</p>' : ''}`}`;
  }

  async function refreshInbox() {
    if (!state.user?.username) return;
    state.inbox = await api('/inbox');
    state.nextInboxAt = Date.now() + (state.active ? 30000 : 60000);
    state.inbox.friends ||= []; state.inbox.requests ||= []; state.inbox.conversations ||= []; state.inbox.unread ||= 0;
    renderList(); updateBell();
  }

  async function selectConversation(id) {
    saveDraft();
    stopAudio();
    const fetchId = ++state.fetchId;
    state.selected = String(id); state.draft = ''; state.view = 'conversation';
    panel.querySelector('.chat-shell')?.setAttribute('data-view', 'conversation');
    renderList();
    const view = panel.querySelector('.chat-conversation');
    if (view) view.innerHTML = '<div class="chat-empty" role="status">Receiving this conversation...</div>';
    try {
      const data = await api(`/conversations/${encodeURIComponent(id)}`);
      if (fetchId !== state.fetchId || !state.active) return;
      state.conversation = data.conversation; state.members = data.members || []; state.messages = data.messages || [];
      state.cursor = state.messages.at(-1)?.id || 0; state.readCursor = 0; state.hasMore = Boolean(data.hasMore);
      state.draft = state.drafts.get(String(id)) || '';
      renderConversation();
      if (state.cursor) {
        const through = state.cursor;
        await api(`/conversations/${encodeURIComponent(id)}/read`, { through });
        if (fetchId !== state.fetchId || !state.active) return;
        state.readCursor = through;
      }
      await refreshInbox();
      status();
      panel.querySelector('#chat-draft')?.focus({ preventScroll: true });
    } catch (error) {
      if (fetchId !== state.fetchId) return;
      state.selected = null; state.conversation = null; state.view = 'list'; render(); status(error.message, true);
    }
  }

  function saveDraft() {
    const input = panel.querySelector('#chat-draft');
    if (input) { state.draft = input.value; if (state.selected) state.drafts.set(String(state.selected), input.value); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.busy || !state.selected) return;
    const input = event.target.querySelector('textarea');
    const submit = event.target.querySelector('[type=submit]');
    const id = state.selected;
    try {
      const text = validateMessage(input.value);
      state.busy = true; submit.disabled = true;
      // Keep the same id for retries, so a lost response cannot create a second message.
      const clientId = event.target.dataset.pendingText === text ? event.target.dataset.clientId : crypto.randomUUID();
      event.target.dataset.pendingText = text; event.target.dataset.clientId = clientId;
      const data = await api(`/conversations/${encodeURIComponent(id)}/messages`, { text, clientId });
      if (String(id) === String(state.selected)) {
        if (!state.messages.some((item) => String(item.id) === String(data.message.id))) state.messages.push(data.message);
        state.messages.sort((first, second) => Number(first.id) - Number(second.id));
        input.value = ''; state.draft = '';
        state.drafts.delete(String(id));
        event.target.querySelector('#chat-draft-count').textContent = '0 / 1,000';
        delete event.target.dataset.pendingText; delete event.target.dataset.clientId;
        renderMessages(true); status(); input.focus({ preventScroll: true });
      }
      await refreshInbox();
    } catch (error) { status(error.message, true); }
    finally { state.busy = false; submit.disabled = false; }
  }

  function stopAudio() {
    state.audioToken += 1; player.stop(); state.listening = null;
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
      const settings = { wpm: 18, farnsworth: 12, frequency: 600, volume: getVolume() };
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

  function showDialog(kind, initialCode = '') {
    document.querySelector('.chat-dialog')?.remove();
    const settings = {
      friend: { title: 'Add a friend', label: 'Username or email', name: 'target', placeholder: 'lelin or friend@example.com', help: 'Your friend needs a chat account. They accept your request before you can message each other.', submit: 'Send request' },
      'new-group': { title: 'Start a private group', label: 'Group name', name: 'name', placeholder: 'The evening signals', help: 'Only people with your invite code or link can join.', submit: 'Create group' },
      'join-group': { title: 'Join a group', label: 'Invite code or link', name: 'code', placeholder: 'Paste a code or invite link', help: 'Ask a group member for their code or invite link.', submit: 'Join group' },
    }[kind];
    if (!settings || !state.user?.username) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'chat-dialog';
    dialog.innerHTML = `<form><div class="chat-dialog-header"><h2>${settings.title}</h2><button type="button" class="button quiet" data-dialog-close aria-label="Close">${icon('close')}</button></div><div class="chat-dialog-body"><label class="chat-field">${settings.label}<input name="${settings.name}" placeholder="${settings.placeholder}" value="${escape(initialCode)}" maxlength="${kind === 'new-group' ? 60 : 254}" required ${kind === 'new-group' ? 'minlength="2"' : ''}></label><p class="chat-form-help">${settings.help}</p><p class="chat-form-help chat-dialog-status" role="status" hidden></p></div><div class="chat-dialog-actions"><button type="button" class="button" data-dialog-close>Cancel</button><button type="submit" class="button primary">${settings.submit}</button></div></form>`;
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
        if (kind === 'friend') {
          await api('/friends/request', { target: value.replace(/^@/, '') });
          dialog.close(); status('Request sent. Your friend can accept it from the notification bell.');
        } else {
          if (kind === 'join-group' && /^https?:\/\//i.test(value)) value = new URL(value).searchParams.get('join') || '';
          const data = await api(kind === 'new-group' ? '/groups' : '/groups/join', kind === 'new-group' ? { name: value } : { code: value });
          try { sessionStorage.removeItem('morse-room-join'); } catch { /* No saved invite remains. */ }
          state.joinConsumed = true;
          const url = new URL(location.href); url.searchParams.delete('join'); history.replaceState(null, '', url);
          dialog.close(); await refreshInbox(); await selectConversation(data.conversation.id);
          if (kind === 'new-group') showInvite();
        }
      } catch (error) { feedback.hidden = false; feedback.textContent = error.message; feedback.classList.add('chat-error'); }
      finally { submit.disabled = false; }
    });
  }

  function showInvite() {
    const node = panel.querySelector('.chat-invite-details');
    if (!node || !state.conversation?.code) return;
    const code = state.conversation.code;
    const link = `${location.origin}/?join=${encodeURIComponent(code)}`;
    node.innerHTML = `<div><span class="small-label">PRIVATE GROUP INVITE</span><strong class="chat-invite-code">${escape(code)}</strong><small>Share this only with people you want in the group.</small></div><div class="chat-invite-actions">${action('copy-code', 'Copy code', 'copy')}${action('copy-link', 'Copy link', 'link')}</div>`;
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
      if (state.active && state.selected && state.conversation) {
        const id = state.selected;
        const after = state.cursor;
        const data = await api(`/conversations/${encodeURIComponent(id)}?after=${encodeURIComponent(after)}`);
        if (String(id) === String(state.selected) && state.active) {
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
          const summary = panel.querySelector('.chat-member-summary');
          if (summary && state.conversation.type === 'group') summary.textContent = `${state.members.length} members`;
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
      } else {
        state.failures += 1;
        state.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(4, state.failures));
        if (state.active) status('Connection interrupted. We will try again. Your typed message is still here.', true);
      }
    } finally { state.pollBusy = false; }
  }

  panel.addEventListener('click', async (event) => {
    const conversation = event.target.closest('[data-conversation]');
    if (conversation) { await selectConversation(conversation.dataset.conversation); return; }
    const reveal = event.target.closest('[data-reveal]');
    if (reveal) {
      const id = reveal.dataset.reveal;
      if (state.revealed.has(id)) state.revealed.delete(id); else state.revealed.add(id);
      // Update in place so keyboard focus stays on the button.
      const text = reveal.closest('.chat-message').querySelector('.chat-message-text');
      text.hidden = !state.revealed.has(id); reveal.setAttribute('aria-expanded', String(!text.hidden));
      reveal.innerHTML = `${icon('eye')}${text.hidden ? 'Show text' : 'Hide text'}`;
      return;
    }
    const audio = event.target.closest('[data-listen]');
    if (audio) { const item = state.messages.find((item) => String(item.id) === audio.dataset.listen); if (item) await listen(item.text, String(item.id)); return; }
    const button = event.target.closest('[data-chat-action]');
    if (!button) return;
    switch (button.dataset.chatAction) {
      case 'retry':
        state.ready = false; render(); await boot(); break;
      case 'friend': case 'new-group': case 'join-group': showDialog(button.dataset.chatAction); break;
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
      case 'back': state.view = 'list'; panel.querySelector('.chat-shell').dataset.view = 'list'; break;
      case 'invite': showInvite(); break;
      case 'copy-code': case 'copy-link': {
        const value = panel.querySelector('.chat-invite-details')?.dataset[button.dataset.chatAction === 'copy-code' ? 'code' : 'link'];
        try { await navigator.clipboard.writeText(value); status(button.dataset.chatAction === 'copy-code' ? 'Invite code copied.' : 'Invite link copied.'); }
        catch { status(`Copy this invite: ${value}`); }
        break;
      }
      case 'logout':
        try {
          await api('/logout', {}); stopAudio(); state.user = null; state.inbox = { friends: [], requests: [], conversations: [], unread: 0 };
          state.selected = null; state.conversation = null; state.messages = []; state.revealed.clear(); state.draft = ''; state.drafts.clear(); status(); render(); updateBell();
        } catch (error) { status(error.message, true); }
        break;
      case 'demo-reveal': {
        const text = panel.querySelector('#chat-demo-text'); text.hidden = !text.hidden;
        button.innerHTML = `${icon('eye')}${text.hidden ? 'Show text' : 'Hide text'}`; button.setAttribute('aria-expanded', String(!text.hidden));
        break;
      }
      case 'demo-listen': await listen('Hi my name is Lelin', 'demo'); break;
    }
  });

  bell.addEventListener('click', () => {
    notifications.hidden = !notifications.hidden;
    bell.setAttribute('aria-expanded', String(!notifications.hidden));
    if (!notifications.hidden) {
      renderNotifications(); notifications.querySelector('button')?.focus();
      if (state.user?.username) void refreshInbox().catch(() => {});
    }
  });
  function closeNotifications() { notifications.hidden = true; bell.setAttribute('aria-expanded', 'false'); }
  document.addEventListener('click', (event) => { if (!event.target.closest('.chat-notification-wrap')) closeNotifications(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !notifications.hidden) { closeNotifications(); bell.focus(); } });
  notifications.addEventListener('click', async (event) => {
    if (event.target.closest('[data-notify-close]')) { closeNotifications(); bell.focus(); return; }
    if (event.target.closest('[data-notify-chat]')) { closeNotifications(); onEnter(); return; }
    const request = event.target.closest('[data-request]');
    if (!request) return;
    request.disabled = true;
    try {
      await api('/friends/respond', { id: request.dataset.request, accept: request.dataset.accept === 'true' });
      await refreshInbox();
    } catch (error) {
      const node = document.createElement('p'); node.className = 'chat-error'; node.textContent = error.message; request.closest('.chat-request').append(node);
      request.disabled = false;
    }
  });

  async function boot() {
    try {
      state.config = await api('/config');
      if (state.config.available) state.user = (await api('/me')).user;
      if (state.user?.username) await refreshInbox();
    } catch { state.config = { available: false, providers: {} }; }
    finally { state.ready = true; render(); updateBell(); await offerPendingJoin(); }
    if (authError) {
      const url = new URL(location.href); url.searchParams.delete('chat_error'); history.replaceState(null, '', url);
    }
  }
  void boot();
  let timer = setInterval(() => { void poll(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('pagehide', () => { stopAudio(); clearInterval(timer); });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { timer = setInterval(() => { void poll(); }, 5000); void poll(); }
  });
  return {
    open() { state.active = true; render(); if (state.ready) { void poll(); void offerPendingJoin(); } },
    close() { saveDraft(); state.active = false; stopAudio(); closeNotifications(); document.querySelector('.chat-dialog')?.close(); },
    stopAudio,
  };
}
