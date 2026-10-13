// Only UI state leaves the trainer. Account credentials stay in HttpOnly cookies.
const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
const theme = () => post({ type: 'theme', dark: document.documentElement.dataset.theme === 'dark' });
theme();
new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

document.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a[href]');
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin === location.origin && url.pathname === '/api/auth/google') {
    event.preventDefault();
    post({ type: 'sign-in' });
  } else if (url.origin === location.origin && url.pathname === '/' && !url.search) {
    event.preventDefault();
    document.querySelector('[data-mode="learn"]')?.click();
  }
}, true);

window.addEventListener('morse-native-back', () => {
  let handled = true;
  const dialog = document.querySelector('dialog[open]');
  const back = document.querySelector('.chat-mobile-back');
  const account = document.querySelector('#account-toggle[aria-expanded="true"]');
  const bell = document.querySelector('#chat-bell[aria-expanded="true"]');
  if (dialog) dialog.close();
  else if (document.body.classList.contains('audio-settings-open')) {
    document.querySelector('#audio-settings-toggle')?.click();
  } else if (account) account.click();
  else if (bell) bell.click();
  else if (back?.getClientRects().length) back.click();
  else if (!document.querySelector('[data-mode="learn"].active')) {
    document.querySelector('[data-mode="learn"]')?.click();
  } else handled = false;
  post({ type: 'back', handled });
});

window.addEventListener('morse-native-initial-state', (event) => {
  const detail = event.detail || {};
  post({ type: 'preferences', dark: detail.theme === 'dark', volume: Number(detail.volume) });
});

post({ type: 'ready' });
window.dispatchEvent(new CustomEvent('morse-native-ready'));
