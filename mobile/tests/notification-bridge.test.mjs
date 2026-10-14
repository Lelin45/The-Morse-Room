import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/use-chat-notifications.ts', import.meta.url), 'utf8');
const nativeSource = await readFile(new URL('../src/notifications-native.ts', import.meta.url), 'utf8');
const compiled = (await transform(source, { loader: 'ts', format: 'cjs' })).code;
const compiledNative = (await transform(nativeSource, { loader: 'ts', format: 'cjs' })).code;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the real hook with persistent state, effect cleanup and async native boundaries.
function createBridge({ visible = true, ready = true, enabled = true, fcmConfigured = true, nativeAvailable = true, promptShown = false } = {}) {
  let index = 0;
  let rendering = false;
  let dirty = false;
  let mounted = true;
  let bridge;
  let configuredUser = null;
  let nextTimer = 0;
  let nextUUID = 0;
  let now = 1000000;
  let state = { supported: true, enabled, fcmConfigured, token: 'fcm-token', deviceId: 'a1111111-1111-4111-8111-111111111111', accountConfigured: false, configuredUserId: null };
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const storage = new Map(promptShown ? [['morse-notifications-prompt', 'shown']] : []);
  const storageWaits = new Map();
  const waits = { state: [], token: [], route: [], configure: [] };
  const appListeners = new Set();
  const nativeListeners = new Map();
  const calls = { state: 0, token: 0, settings: 0, clear: 0, consume: 0, configure: [], writes: [] };
  const alerts = [];
  const scripts = [];
  const webview = { current: { injectJavaScript: (script) => scripts.push(script) } };
  let options = { webview, visible, ready };
  const changed = (previous, next) => !previous || !next || previous.length !== next.length
    || previous.some((value, position) => !Object.is(value, next[position]));
  const readStorage = async (key) => {
    const pending = storageWaits.get(key)?.shift();
    return pending ? pending.promise : storage.get(key) ?? null;
  };
  const native = {
    async getStateAsync() { calls.state += 1; return waits.state.length ? waits.state.shift().promise : { ...state }; },
    async getFCMTokenAsync() { calls.token += 1; return waits.token.length ? waits.token.shift().promise : state.token; },
    async configureAsync(value) {
      calls.configure.push(clone(value));
      if (waits.configure.length) await waits.configure.shift().promise;
      configuredUser = value.userId;
      state = { ...state, accountConfigured: true, configuredUserId: value.userId, registeredDeviceId: value.deviceId };
      return { ...state, accountConfigured: true };
    },
    async clearAsync() { calls.clear += 1; configuredUser = null; state = {...state, accountConfigured: false, configuredUserId: null}; return { ...state }; },
    async consumeRouteAsync() { calls.consume += 1; return waits.route.length ? waits.route.shift().promise : null; },
    async openSettingsAsync() { calls.settings += 1; },
    addListener(event, callback) {
      if (!nativeListeners.has(event)) nativeListeners.set(event, new Set());
      nativeListeners.get(event).add(callback);
      return { remove: () => nativeListeners.get(event).delete(callback) };
    },
  };
  let notifications = native;
  if (!nativeAvailable) {
    const adapter = {
      module: { exports: {} }, __DEV__: false,
      require(name) {
        if (name === 'expo-modules-core') return { requireOptionalNativeModule: () => null };
        if (name === 'react-native') return { Platform: { OS: 'android' } };
        throw new Error(`Unexpected adapter import: ${name}`);
      },
    };
    vm.runInNewContext(compiledNative, adapter);
    notifications = adapter.module.exports.nativeNotifications;
  }
  const modules = {
    react: {
      useState(initial) {
        const position = index++;
        if (!hooks[position]) hooks[position] = { value: typeof initial === 'function' ? initial() : initial };
        return [hooks[position].value, (next) => {
          const value = typeof next === 'function' ? next(hooks[position].value) : next;
          if (!Object.is(hooks[position].value, value)) {
            hooks[position].value = value;
            dirty = true;
            if (!rendering && mounted) render();
          }
        }];
      },
      useRef(initial) {
        const position = index++;
        if (!hooks[position]) hooks[position] = { current: initial };
        return hooks[position];
      },
      useCallback(callback, dependencies) {
        const position = index++;
        if (!hooks[position] || changed(hooks[position].dependencies, dependencies)) hooks[position] = { callback, dependencies };
        return hooks[position].callback;
      },
      useEffect(callback, dependencies) {
        const position = index++;
        if (!hooks[position] || changed(hooks[position].dependencies, dependencies)) {
          effects.push(() => {
            hooks[position]?.cleanup?.();
            hooks[position] = { dependencies, cleanup: callback() };
          });
        }
      },
    },
    'react-native': {
      Alert: { alert: (title, message, buttons) => alerts.push({ title, message, buttons }) },
      AppState: { addEventListener: (_event, callback) => {
        appListeners.add(callback);
        return { remove: () => appListeners.delete(callback) };
      } },
    },
    'expo-crypto': { randomUUID: () => `installation-${++nextUUID}` },
    'expo-secure-store': {
      getItemAsync: readStorage,
      setItemAsync: async (key, value) => { storage.set(key, value); calls.writes.push({ key, value }); },
    },
    './notifications-native': { nativeNotifications: notifications },
  };
  const context = {
    module: { exports: {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    require(name) { assert(name in modules, `Unexpected notification import: ${name}`); return modules[name]; },
  };
  vm.runInNewContext(compiled, context);
  function render() {
    if (!mounted) return;
    rendering = true;
    do {
      dirty = false;
      index = 0;
      bridge = context.module.exports.useChatNotifications(options);
      while (effects.length) effects.shift()();
    } while (dirty);
    rendering = false;
  }
  render();
  function eventDetail(name) {
    return scripts.filter((script) => script.includes(`'${name}'`)).map((script) => {
      const marker = '{detail:';
      const start = script.indexOf(marker) + marker.length;
      const end = script.lastIndexOf('}));');
      assert(start >= marker.length && end > start, `Unexpected event injection: ${script}`);
      return JSON.parse(script.slice(start, end));
    });
  }
  return {
    calls, alerts, scripts, storage,
    advance(milliseconds) { now += milliseconds; },
    get configuredUser() { return configuredUser; },
    account(userId, available = true) { return bridge.handleMessage({ type: 'chat-account', userId, notificationsAvailable: available }); },
    message(value) { return bridge.handleMessage(value); },
    update(value) { options = { ...options, ...value }; render(); },
    state(value) { state = { ...state, ...value }; },
    registration() { return eventDetail('morse-native-register-notifications'); },
    routes() { return eventDetail('morse-native-open-conversation'); },
    acknowledge(detail, data = {}) {
      return bridge.handleMessage({ type: 'notifications-registered', ok: true, requestId: detail.requestId,
        data: { userId: detail.userId, deviceId: `device-${detail.userId}`, authToken: `auth-${detail.userId}`, ...data } });
    },
    appActive() { for (const callback of [...appListeners]) callback('active'); },
    emit(event, value) { for (const callback of [...nativeListeners.get(event) ?? []]) callback(value); },
    wait(kind, key) {
      const pending = deferred();
      if (kind === 'storage') {
        if (!storageWaits.has(key)) storageWaits.set(key, []);
        storageWaits.get(key).push(pending);
      } else waits[kind].push(pending);
      return pending;
    },
    expire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    unmount() {
      mounted = false;
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

test('notification permission prompt appears once, opens settings, and registers on return', async (t) => {
  const bridge = createBridge({ enabled: false });
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  assert.equal(bridge.alerts.length, 1);
  assert.equal(bridge.registration().length, 0);
  bridge.account('user-a');
  bridge.appActive();
  await settle();
  assert.equal(bridge.alerts.length, 1);
  const enable = bridge.alerts[0].buttons.find((button) => button.text === 'Enable');
  assert(enable, 'The enable action must be available.');
  enable.onPress();
  await settle();
  assert.equal(bridge.calls.settings, 1);
  bridge.state({ enabled: true });
  bridge.appActive();
  await settle();
  const [detail] = bridge.registration();
  assert.equal(detail.userId, 'user-a');
  assert.equal(detail.fcmToken, 'fcm-token');
  bridge.acknowledge(detail);
  await settle();
  assert.equal(bridge.calls.configure.length, 1);
  assert.equal(bridge.calls.configure[0].userId, 'user-a');
});

test('saved permission prompt is not repeated on a later app launch', async (t) => {
  const bridge = createBridge({ enabled: false, promptShown: true });
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  assert.equal(bridge.alerts.length, 0);
  assert.equal(bridge.registration().length, 0);
  assert.equal(bridge.message({ type: 'notifications-settings' }), true);
  await settle();
  assert.equal(bridge.calls.settings, 1);
});

test('forty ordinary app resumes reuse a successful registration without rotating server credentials', async (t) => {
  const bridge = createBridge(); t.after(() => bridge.unmount());
  bridge.account('user-a'); await settle();
  const first = bridge.registration()[0];
  assert.equal(first.installationId, 'a1111111-1111-4111-8111-111111111111');
  bridge.acknowledge(first); await settle();
  for (let index = 0; index < 40; index++) { bridge.appActive(); await settle(); }
  assert.equal(bridge.registration().length, 1);
  assert.equal(bridge.calls.configure.length, 1);
});

test('a refreshed FCM token or missing native credentials registers again for the current account', async (t) => {
  const bridge = createBridge(); t.after(() => bridge.unmount());
  bridge.account('user-a'); await settle();
  bridge.acknowledge(bridge.registration()[0]); await settle();
  bridge.state({ token: 'refreshed-fcm-token' });
  bridge.emit('onTokenChanged', { token: 'refreshed-fcm-token' }); await settle();
  assert.equal(bridge.registration().length, 2);
  assert.equal(bridge.registration()[1].fcmToken, 'refreshed-fcm-token');
  bridge.acknowledge(bridge.registration()[1]); await settle();
  bridge.state({ accountConfigured: false, configuredUserId: null });
  bridge.emit('onStateChange', { accountConfigured: false }); await settle();
  assert.equal(bridge.registration().length, 3);
});

test('failed device registration backs off and settings return can explicitly retry', async (t) => {
  const bridge = createBridge(); t.after(() => bridge.unmount());
  bridge.account('user-a'); await settle();
  const first = bridge.registration()[0];
  bridge.message({ type: 'notifications-registered', requestId: first.requestId, ok: false });
  bridge.appActive(); await settle();
  assert.equal(bridge.registration().length, 1);
  bridge.advance(30001); bridge.appActive(); await settle();
  assert.equal(bridge.registration().length, 2);
  const second = bridge.registration()[1];
  bridge.message({ type: 'notifications-registered', requestId: second.requestId, ok: false });
  bridge.message({ type: 'notifications-settings' }); bridge.appActive(); await settle();
  assert.equal(bridge.registration().length, 3);
});

test('overlapping resume and token events produce a single registration request', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  const state = bridge.wait('state');
  bridge.account('user-a');
  bridge.appActive();
  bridge.emit('onTokenChanged', { token: 'fcm-token' });
  state.resolve({ supported: true, fcmConfigured: true, enabled: true, deviceId: 'a1111111-1111-4111-8111-111111111111' });
  await settle();
  assert.equal(bridge.registration().length, 1);
  assert.equal(bridge.calls.token, 1);
});

test('logout while registration waits on native state, token, or permission preference never sends old credentials', async (t) => {
  for (const stage of ['state', 'token', 'prompt']) {
    const bridge = createBridge({ enabled: stage !== 'prompt' });
    t.after(() => bridge.unmount());
    const pending = stage === 'prompt' ? bridge.wait('storage', 'morse-notifications-prompt') : bridge.wait(stage);
    bridge.account('user-a');
    await settle();
    bridge.account(null);
    pending.resolve(stage === 'state' ? { supported: true, fcmConfigured: true, enabled: true }
      : stage === 'token' ? 'old-fcm-token' : null);
    await settle();
    assert.equal(bridge.registration().length, 0, `Logout during ${stage} must cancel the old request.`);
    assert.equal(bridge.calls.configure.length, 0);
    assert.ok(bridge.calls.clear >= 1);
  }
});

test('switching accounts cancels an older asynchronous registration without blocking the new user', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  const token = bridge.wait('token');
  bridge.account('user-a');
  await settle();
  bridge.account('user-b');
  await settle();
  token.resolve('old-user-token');
  await settle();
  const requests = bridge.registration();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].userId, 'user-b');
  assert.equal(requests[0].fcmToken, 'fcm-token');
  bridge.acknowledge(requests[0]);
  await settle();
  assert.deepEqual(bridge.calls.configure.map((value) => value.userId), ['user-b']);
});

test('only the matching registration acknowledgement configures once, including after logout and sign-in', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  const first = bridge.registration()[0];
  assert.equal(typeof first.requestId, 'string');
  assert.ok(first.requestId.length > 0);
  bridge.message({ type: 'notifications-registered', ok: true, requestId: 'unrelated-request',
    data: { userId: 'user-a', deviceId: 'bad-device', authToken: 'bad-token' } });
  await settle();
  assert.equal(bridge.calls.configure.length, 0);
  bridge.acknowledge(first);
  bridge.acknowledge(first);
  await settle();
  assert.equal(bridge.calls.configure.length, 1);
  bridge.account(null);
  bridge.account('user-a');
  await settle();
  const second = bridge.registration()[1];
  assert.notEqual(second.requestId, first.requestId);
  bridge.acknowledge(first, { authToken: 'stale-token' });
  await settle();
  assert.equal(bridge.calls.configure.length, 1);
  bridge.acknowledge(second);
  await settle();
  assert.equal(bridge.calls.configure.length, 2);
  assert.ok(bridge.calls.configure.every((value) => value.authToken !== 'stale-token'));
});

test('timed-out registration acknowledgements cannot configure an account', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  const detail = bridge.registration()[0];
  bridge.expire();
  bridge.acknowledge(detail);
  await settle();
  assert.equal(bridge.calls.configure.length, 0);
});

test('logout clears native credentials after an in-flight configuration finishes', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  const configuration = bridge.wait('configure');
  bridge.acknowledge(bridge.registration()[0]);
  await settle();
  assert.equal(bridge.calls.configure.length, 1);
  bridge.account(null);
  await settle();
  assert.equal(bridge.calls.clear, 0, 'Native clear must wait behind an in-flight configuration.');
  configuration.resolve();
  await settle();
  assert.ok(bridge.calls.clear >= 1);
  assert.equal(bridge.configuredUser, null);
});

test('logout cancels a configuration that has been queued but has not started', async (t) => {
  const bridge = createBridge();
  t.after(() => bridge.unmount());
  bridge.account('user-a');
  await settle();
  bridge.acknowledge(bridge.registration()[0]);
  bridge.account(null);
  await settle();
  assert.equal(bridge.calls.configure.length, 0);
  assert.equal(bridge.configuredUser, null);
});

test('notification routes wait for both WebView readiness and the finished opening', async (t) => {
  const bridge = createBridge({ visible: false, ready: false });
  t.after(() => bridge.unmount());
  const route = { conversationId: 'conversation-a', messageId: 'message-a' };
  bridge.emit('onNotificationOpen', route);
  assert.equal(bridge.routes().length, 0);
  bridge.update({ ready: true });
  await settle();
  assert.equal(bridge.routes().length, 0);
  bridge.update({ visible: true });
  await settle();
  assert.deepEqual(bridge.routes(), [route]);
  bridge.emit('onNotificationOpen', route);
  assert.equal(bridge.routes().length, 1, 'A duplicate event must not open the same conversation twice.');
  bridge.emit('onNotificationOpen', { conversationId: 'bad/id', messageId: 'message-b' });
  assert.equal(bridge.routes().length, 1);
});

test('cold-start notification route is consumed when the trainer becomes usable', async (t) => {
  const bridge = createBridge({ visible: false });
  t.after(() => bridge.unmount());
  const pending = bridge.wait('route');
  const route = { conversationId: 'conversation-b', messageId: 'message-b' };
  bridge.update({ visible: true });
  pending.resolve(route);
  await settle();
  assert.deepEqual(bridge.routes(), [route]);
});

test('a delayed consumed route waits again if the WebView becomes unavailable', async (t) => {
  const bridge = createBridge({ visible: false });
  t.after(() => bridge.unmount());
  const pending = bridge.wait('route');
  const route = { conversationId: 'conversation-c', messageId: 'message-c' };
  bridge.update({ visible: true });
  bridge.update({ ready: false });
  pending.resolve(route);
  await settle();
  assert.equal(bridge.routes().length, 0);
  bridge.update({ ready: true });
  await settle();
  assert.deepEqual(bridge.routes(), [route]);
});

test('missing native module and missing Firebase configuration skip notifications without crashing', async (t) => {
  for (const options of [{ nativeAvailable: false }, { fcmConfigured: false }]) {
    const bridge = createBridge(options);
    t.after(() => bridge.unmount());
    bridge.account('user-a');
    await settle();
    bridge.appActive();
    await settle();
    assert.equal(bridge.alerts.length, 0);
    assert.equal(bridge.registration().length, 0);
    assert.equal(bridge.calls.token, 0);
    bridge.account(null);
    await settle();
    assert.equal(bridge.calls.configure.length, 0);
  }
});

test('unmount during asynchronous registration produces no later WebView injection', async () => {
  const bridge = createBridge();
  const token = bridge.wait('token');
  bridge.account('user-a');
  await settle();
  bridge.unmount();
  token.resolve('fcm-token');
  await settle();
  assert.equal(bridge.registration().length, 0);
});

test('unmount ignores a delayed consumed notification route', async () => {
  const bridge = createBridge({ visible: false });
  const pending = bridge.wait('route');
  bridge.update({ visible: true });
  bridge.unmount();
  pending.resolve({ conversationId: 'conversation-d', messageId: 'message-d' });
  await settle();
  assert.equal(bridge.routes().length, 0);
});
