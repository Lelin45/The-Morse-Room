import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as auth from '../src/auth-utils.js';
import * as audio from '../src/audio-preferences.js';
import * as audioRules from '../generated/audio-settings.js';

const source = await readFile(new URL('../src/TrainerScreen.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function createShell(initialProof = null, { initialAudio = null, failAudio = false } = {}) {
  const effects = [];
  const writes = [];
  const browserCalls = [];
  const injectedScripts = [];
  const audioWrites = [];
  const notificationAudio = [];
  let savedAudio = initialAudio;
  let stored = initialProof;
  let readCount = 0;
  const resolveReads = [];
  let randomByte = 0;
  const element = (type, props) => ({ type, props });
  const notificationBridge = { handleMessage: () => false, clear() {} };
  const hooks = [];
  let hookIndex = 0;
  let firstRender = true;
  const modules = {
    react: {
      useRef: value => { const index = hookIndex++; return hooks[index] ??= { current: value }; },
      useState: value => {
        const index = hookIndex++;
        if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
        return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
      },
      useCallback: (callback) => callback,
      useEffect: callback => { if (firstRender) effects.push(callback); },
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      useColorScheme: () => 'light', View: 'view', Text: 'text', Pressable: 'button', ActivityIndicator: 'activity',
      KeyboardAvoidingView: 'keyboard-avoiding-view', Platform: { OS: 'android' },
      Alert: { alert() {} }, StyleSheet: { create: (value) => value, absoluteFill: {} },
      Linking: { addEventListener: () => ({ remove() {} }), getInitialURL: async () => null },
    },
    'react-native-safe-area-context': { SafeAreaView: 'safe' },
    'expo-status-bar': { StatusBar: 'status' },
    'react-native-webview': { WebView: 'webview' },
    'expo-crypto': {
      getRandomBytes: (count) => new Uint8Array(count).fill(++randomByte),
      digestStringAsync: async () => `${'x'.repeat(43)}=`,
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-secure-store': {
      getItemAsync: key => {
        if (key === audio.AUDIO_PREFERENCES_KEY) return failAudio ? Promise.reject(new Error('Unavailable')) : Promise.resolve(savedAudio);
        assert.equal(key, auth.PENDING_AUTH_KEY);
        readCount++; return new Promise(resolve => { resolveReads.push(resolve); });
      },
      setItemAsync: async (key, value) => {
        if (key === audio.AUDIO_PREFERENCES_KEY) { savedAudio = value; audioWrites.push(value); return; }
        assert.equal(key, auth.PENDING_AUTH_KEY); stored = value; writes.push(value);
      },
      deleteItemAsync: async key => { assert.equal(key, auth.PENDING_AUTH_KEY); stored = null; },
    },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: async (...args) => { browserCalls.push(args); return { type: 'cancel' }; },
    },
    'expo-splash-screen': { preventAutoHideAsync: async () => {}, hideAsync: async () => {} },
    '../generated/trainer-html': { __esModule: true, default: '<html><head></head><body>bundled trainer</body></html>' },
    './Opening': { default: 'opening' },
    './use-chat-notifications': { useChatNotifications: () => notificationBridge },
    './auth-utils': auth,
    './audio-preferences': audio,
    '../generated/audio-settings': audioRules,
    './notifications-native': { nativeNotifications: {
      async updateAudioSettingsAsync(profile) { notificationAudio.push(JSON.parse(JSON.stringify(profile))); },
    } },
  };
  const context = {
    exports: {}, URL, __DEV__: false, setTimeout, clearTimeout,
    require(name) { assert(name in modules, `Unexpected native import: ${name}`); return modules[name]; },
  };
  vm.runInNewContext(compiled, context);
  function render() {
    hookIndex = 0;
    const root = context.exports.default();
    firstRender = false;
    const find = element => {
      if (!element || typeof element !== 'object') return null;
      if (element.type === 'webview') return element;
      return [element.props?.children].flat().map(find).find(Boolean) || null;
    };
    const webview = find(root);
    if (webview) webview.props.ref.current = { injectJavaScript: script => injectedScripts.push(script) };
    return webview;
  }
  render();
  const message = value => {
    const webview = render();
    assert.ok(webview, 'Native preferences must finish loading before messages arrive');
    webview.props.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
  };
  const startAudioRestore = () => effects.find(callback => callback.toString().includes('AUDIO_PREFERENCES_KEY'))();
  const startAuthRestore = () => effects.find(callback => callback.toString().includes('getInitialURL'))();
  return {
    writes, browserCalls, injectedScripts, audioWrites, notificationAudio, message,
    get stored() { return stored; },
    get savedAudio() { return savedAudio; },
    get webview() { return render(); },
    get readCount() { return readCount; },
    signIn() { message({ type: 'sign-in' }); },
    receiveOldCallback() {
      render().props.onShouldStartLoadWithRequest({
        url: `morsenepal://auth?state=${'a'.repeat(43)}&code=${'b'.repeat(43)}`, isTopFrame: true,
      });
    },
    startAudioRestore,
    startRestore() { startAudioRestore(); startAuthRestore(); },
    finishRead(value = stored, index = resolveReads.length - 1) {
      assert(resolveReads[index], 'Storage read should be pending'); resolveReads[index](value);
    },
  };
}

test('a pending callback cannot race a new sign-in and delete its proof', async () => {
  const shell = createShell();
  shell.startRestore();
  await settle();
  shell.finishRead();
  await settle();
  shell.receiveOldCallback();
  shell.signIn();
  await settle();
  assert.equal(shell.writes.length, 0);
  assert.equal(shell.browserCalls.length, 0);

  shell.finishRead();
  await settle();
  shell.signIn();
  await settle();
  assert.equal(shell.writes.length, 1);
  assert.equal(shell.browserCalls.length, 1);
  assert(auth.readPendingAuth(shell.stored), 'The newer proof should remain stored after browser dismissal');
});

test('native audio loads before WebView mounts and does not mix with authentication storage', async () => {
  const profile = { mode: 'default', wpm: 24, farnsworth: 15, frequency: 700, volume: 43 };
  const shell = createShell(null, { initialAudio: JSON.stringify(profile) });
  assert.equal(shell.webview, null);
  shell.startAudioRestore();
  await settle();
  assert.ok(shell.webview.props.source.html.includes(`window.__MORSE_AUDIO_SETTINGS=${JSON.stringify(profile)}`));
  assert.equal(shell.readCount, 0);
  assert.deepEqual(shell.writes, []);
  shell.message({ type: 'audio-settings', settings: { ...profile, mode: 'custom' } });
  await settle();
  assert.deepEqual(JSON.parse(shell.savedAudio), { ...profile, mode: 'custom' });
  assert.deepEqual(shell.writes, []);
});

test('an unreadable native audio backup keeps the original WebView upgrade fallback', async () => {
  const shell = createShell(null, { failAudio: true });
  shell.startAudioRestore();
  await settle();
  assert.equal(shell.webview.props.source.html, '<html><head></head><body>bundled trainer</body></html>');
  shell.message({ type: 'audio-settings', settings: { mode: 'other', wpm: 24, farnsworth: 15, frequency: 700, volume: 43 } });
  await settle();
  assert.deepEqual(shell.audioWrites, []);
  assert.deepEqual(shell.notificationAudio, []);
});

test('notification timing follows effective global audio while Default preserves remembered Custom values', async () => {
  const custom = { mode: 'custom', wpm: 24, farnsworth: 15, frequency: 700, volume: 43 };
  const shell = createShell();
  shell.startAudioRestore();
  await settle();
  shell.message({ type: 'audio-settings', settings: custom });
  shell.message({ type: 'audio-settings', settings: { ...custom, mode: 'default', volume: 0 } });
  shell.message({ type: 'audio-settings', settings: { ...custom, volume: 0 } });
  await settle();
  assert.deepEqual(shell.notificationAudio, [
    { wpm: 24, farnsworth: 15, frequency: 700, volume: 43 },
    { wpm: 18, farnsworth: 12, frequency: 600, volume: 0 },
    { wpm: 24, farnsworth: 15, frequency: 700, volume: 0 },
  ]);
  assert.deepEqual(JSON.parse(shell.savedAudio), { ...custom, volume: 0 });
  assert.deepEqual(shell.writes, []);
});

test('startup restoration finishes before a new sign-in can save its proof', async () => {
  const shell = createShell();
  shell.startRestore();
  await settle();
  shell.signIn();
  await settle();
  assert.equal(shell.writes.length, 0);
  assert.equal(shell.browserCalls.length, 0);

  shell.finishRead();
  await settle();
  shell.signIn();
  await settle();
  assert.equal(shell.writes.length, 1);
  assert.equal(shell.browserCalls.length, 1);
  assert(auth.readPendingAuth(shell.stored), 'Startup cleanup should leave the newer proof intact');
});

test('a cold start exchanges saved proof only after native readiness and clears it on completion', async () => {
  const proof = { state: 'a'.repeat(43), verifier: 'v'.repeat(43), code: 'b'.repeat(43), createdAt: Date.now() };
  const shell = createShell(JSON.stringify(proof));
  shell.startRestore();
  await settle();
  shell.finishRead();
  await settle();
  assert.equal(shell.injectedScripts.length, 0);
  assert.equal(shell.browserCalls.length, 0);

  shell.message({ type: 'morse-native-ready', theme: 'dark', volume: 0 });
  assert.deepEqual(shell.injectedScripts, [auth.finishAuthScript(proof.code, proof.verifier)]);
  shell.message({ type: 'morse-native-ready', theme: 'dark', volume: 0 });
  assert.equal(shell.injectedScripts.length, 1);

  shell.message({ type: 'auth-finish', ok: true });
  await settle();
  assert.equal(shell.stored, null);
  shell.receiveOldCallback();
  await settle();
  assert.equal(shell.readCount, 1, 'The completed callback should be ignored before storage is read');
  assert.equal(shell.injectedScripts.length, 1);
});

test('an earlier startup read cannot overwrite the code received by a concurrent callback', async () => {
  const proof = { state: 'a'.repeat(43), verifier: 'v'.repeat(43), createdAt: Date.now() };
  const saved = JSON.stringify(proof);
  const shell = createShell(saved);
  shell.startRestore();
  await settle();
  shell.receiveOldCallback();
  shell.finishRead(saved, 1);
  await settle();
  const completed = auth.readPendingAuth(shell.stored);
  assert.equal(completed.code, 'b'.repeat(43));

  shell.finishRead(saved, 0);
  await settle();
  shell.message({ type: 'morse-native-ready', theme: 'dark', volume: 0 });
  assert.deepEqual(shell.injectedScripts, [auth.finishAuthScript(completed.code, proof.verifier)]);
});
