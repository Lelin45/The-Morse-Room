const mobile = matchMedia('(max-width: 760px)');
const viewport = window.visualViewport;
const settingsButton = document.querySelector('#audio-settings-toggle');
const settingsPanel = document.querySelector('#audio-controls');
const settingsHome = document.createComment('Audio settings sidebar position');
const settingsBackdrop = document.createElement('button');
const appShell = document.querySelector('.app-shell');
let settingsReturnFocus = settingsButton;
let appWasInert = false;
settingsPanel.before(settingsHome);
settingsBackdrop.type = 'button';
settingsBackdrop.className = 'audio-settings-backdrop';
settingsBackdrop.setAttribute('aria-label', 'Close audio settings');
settingsBackdrop.tabIndex = -1;
settingsBackdrop.hidden = true;
document.body.append(settingsBackdrop);
let restingHeight = viewport?.height || window.innerHeight;
let frame = 0;

function editable(element) {
  return element instanceof HTMLElement && element.matches('input, textarea, [contenteditable="true"]')
    && !element.readOnly && !element.disabled && element.getAttribute('inputmode') !== 'none';
}

function keepInputVisible() {
  const input = document.activeElement;
  if (!mobile.matches || !editable(input)) return;
  const bounds = input.getBoundingClientRect();
  const top = viewport?.offsetTop || 0;
  const bottom = top + (viewport?.height || window.innerHeight);
  if (bounds.bottom > bottom - 12 || bounds.top < top + 60) {
    input.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
}

function updateViewport() {
  frame = 0;
  const height = viewport?.height || window.innerHeight;
  const focused = editable(document.activeElement);
  if (!focused) restingHeight = Math.max(restingHeight, height);
  const inset = focused && mobile.matches ? Math.max(0, restingHeight - height) : 0;
  document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
  document.documentElement.style.setProperty('--app-top', `${Math.round(viewport?.offsetTop || 0)}px`);
  document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
  document.body.classList.toggle('keyboard-open', inset > 120);
  keepInputVisible();
}

function scheduleViewport() {
  if (!frame) frame = requestAnimationFrame(updateViewport);
}

function closeSettings({ restoreFocus = true } = {}) {
  if (!document.body.classList.contains('audio-settings-open')) return;
  document.body.classList.remove('audio-settings-open');
  document.documentElement.classList.remove('audio-dialog-open');
  settingsButton.setAttribute('aria-expanded', 'false');
  settingsPanel.removeAttribute('role');
  settingsPanel.removeAttribute('aria-modal');
  settingsPanel.removeAttribute('aria-labelledby');
  settingsPanel.removeAttribute('tabindex');
  settingsHome.after(settingsPanel);
  settingsBackdrop.hidden = true;
  if (appShell) appShell.inert = appWasInert;
  if (restoreFocus && settingsReturnFocus?.isConnected) {
    settingsReturnFocus.focus({ preventScroll: true });
  }
}

function openSettings(trigger = settingsButton) {
  if (document.body.classList.contains('audio-settings-open')) return;
  // Render outside the sidebar so chat and keyboard layouts cannot clip the panel.
  settingsReturnFocus = trigger;
  settingsBackdrop.hidden = false;
  document.body.append(settingsPanel);
  settingsPanel.setAttribute('role', 'dialog');
  settingsPanel.setAttribute('aria-modal', 'true');
  settingsPanel.setAttribute('aria-labelledby', 'audio-settings-title');
  settingsPanel.setAttribute('tabindex', '-1');
  settingsPanel.scrollTop = 0;
  document.body.classList.add('audio-settings-open');
  document.documentElement.classList.add('audio-dialog-open');
  settingsButton.setAttribute('aria-expanded', 'true');
  appWasInert = Boolean(appShell?.inert);
  if (appShell) appShell.inert = true;
  updateViewport();
  // Focus a button instead of a numeric field so opening settings never summons a keyboard.
  (settingsPanel.querySelector('#audio-settings-close') || settingsPanel).focus({ preventScroll: true });
}

settingsButton.addEventListener('click', () => {
  if (document.body.classList.contains('audio-settings-open')) closeSettings();
  else openSettings(settingsButton);
});
settingsBackdrop.addEventListener('click', () => closeSettings());
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const trigger = event.target.closest('[data-open-audio]');
  if (trigger) openSettings(trigger);
  if (event.target.closest('#audio-settings-close')) closeSettings();
  if (event.target.closest('.mode-button[data-mode]')) closeSettings({ restoreFocus: false });
});
document.addEventListener('keydown', (event) => {
  if (!document.body.classList.contains('audio-settings-open')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSettings();
  } else if (event.key === 'Tab') {
    const focusable = [...settingsPanel.querySelectorAll('button, input, select, textarea, [tabindex]')]
      .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) {
      event.preventDefault();
      settingsPanel.focus({ preventScroll: true });
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === settingsPanel)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }
});
document.addEventListener('focusin', scheduleViewport);
document.addEventListener('focusout', scheduleViewport);
window.addEventListener('resize', scheduleViewport);
viewport?.addEventListener('resize', scheduleViewport);
viewport?.addEventListener('scroll', scheduleViewport);
window.addEventListener('orientationchange', () => {
  restingHeight = 0; closeSettings(); scheduleViewport();
});
mobile.addEventListener('change', () => { closeSettings(); restingHeight = 0; scheduleViewport(); });
updateViewport();
