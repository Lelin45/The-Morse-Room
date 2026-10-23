// Session cookies stay in WebView. A revocable notification credential is
// passed to the native module for encrypted Android Keystore storage.
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
  else if (!document.querySelector(document.body.dataset.advanced === 'true' ? '[data-mode="radio"].active' : '[data-mode="learn"].active')) {
    document.querySelector(document.body.dataset.advanced === 'true' ? '[data-mode="radio"]' : '[data-mode="learn"]')?.click();
  } else handled = false;
  post({ type: 'back', handled });
});

window.addEventListener('morse-native-initial-state', (event) => {
  const detail = event.detail || {};
  post({ type: 'preferences', dark: detail.theme === 'dark', volume: Number(detail.volume) });
});

window.addEventListener('morse-native-chat-account', ({ detail = {} }) => {
  post({ type: 'chat-account', userId: detail.userId, notificationsAvailable: detail.notificationsAvailable === true });
});
window.addEventListener('morse-native-notification-settings', () => post({ type: 'notifications-settings' }));
window.addEventListener('morse-native-register-notifications', async ({ detail = {} }) => {
  try {
    const response = await fetch('/api/notifications/devices', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: detail.installationId, fcmToken: detail.fcmToken }),
    });
    const data = await response.json();
    post({ type: 'notifications-registered', requestId: detail.requestId, ok: response.ok && data.userId === detail.userId, data: response.ok ? data : null });
  } catch { post({ type: 'notifications-registered', requestId: detail.requestId, ok: false }); }
});

post({ type: 'ready' });
window.dispatchEvent(new CustomEvent('morse-native-ready'));
