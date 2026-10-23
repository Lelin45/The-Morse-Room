import { radioTransmission } from './radio-codec.js';

const listeners = new Set();
const requests = new Map();
let counter = 0;

if (typeof window !== 'undefined') window.addEventListener('morse-radio', ({ detail = {} }) => {
  if (detail.requestId && requests.has(detail.requestId)) {
    const request = requests.get(detail.requestId);
    requests.delete(detail.requestId); clearTimeout(request.timer);
    if (detail.ok) request.resolve(detail.data);
    else request.reject(new Error(detail.error || 'The radio connection could not complete.'));
  }
  for (const listener of listeners) listener(detail);
});

export function subscribeRadio(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestRadio(action, payload = {}) {
  if (!globalThis.window?.ReactNativeWebView) {
    return action === 'getCapabilities'
      ? Promise.resolve({ available: false, usbKeyer: false, audioInput: false })
      : Promise.reject(new Error('Radio connections are available in the Android app.'));
  }
  if (action === 'transmit') {
    try { payload = { ...payload, ...radioTransmission(payload.morse, payload, payload.id) }; }
    catch (error) { return Promise.reject(error); }
  }
  const requestId = `radio${Date.now()}_${++counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(requestId);
      if (action === 'startReceive') void requestRadio('stopReceive').catch(() => {});
      if (action === 'connectKeyer') void requestRadio('disconnectKeyer').catch(() => {});
      reject(new Error('The radio connection timed out. Check the cable and adapter.'));
    }, ['connectKeyer', 'startReceive'].includes(action) ? 45000 : 15000);
    requests.set(requestId, { resolve, reject, timer });
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'radio-command', action, payload, requestId }));
  });
}
