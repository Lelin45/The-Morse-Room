const mobile = matchMedia('(max-width: 760px)');
const viewport = window.visualViewport;
const settingsButton = document.querySelector('#audio-settings-toggle');
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

function closeSettings() {
  document.body.classList.remove('audio-settings-open');
  settingsButton.setAttribute('aria-expanded', 'false');
}

settingsButton.addEventListener('click', () => {
  const open = document.body.classList.toggle('audio-settings-open');
  settingsButton.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  if (event.target.closest('.mode-button[data-mode]')) closeSettings();
  if (document.body.classList.contains('audio-settings-open')
    && !event.target.closest('#audio-controls, #audio-settings-toggle')) closeSettings();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('audio-settings-open')) {
    closeSettings(); settingsButton.focus({ preventScroll: true });
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
