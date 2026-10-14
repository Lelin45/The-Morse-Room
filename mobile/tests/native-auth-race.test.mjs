import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as auth from '../src/auth-utils.js';

const source = await readFile(new URL('../src/TrainerScreen.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function createShell(initialProof = null) {
  const effects = [];
  const writes = [];
  const browserCalls = [];
  const injectedScripts = [];
  let stored = initialProof;
  let readCount = 0;
  const resolveReads = [];
  let randomByte = 0;
  const element = (type, props) => ({ type, props });
  const notificationBridge = { handleMessage: () => false, clear() {} };
  const modules = {
    react: {
      useRef: (value) => ({ current: value }),
      useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
      useCallback: (callback) => callback,
      useEffect: (callback) => effects.push(callback),
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
      getItemAsync: () => { readCount++; return new Promise((resolve) => { resolveReads.push(resolve); }); },
      setItemAsync: async (_key, value) => { stored = value; writes.push(value); },
      deleteItemAsync: async () => { stored = null; },
    },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: async (...args) => { browserCalls.push(args); return { type: 'cancel' }; },
    },
    'expo-splash-screen': { preventAutoHideAsync: async () => {}, hideAsync: async () => {} },
    '../generated/trainer-html': { default: 'bundled trainer' },
    './Opening': { default: 'opening' },
    './use-chat-notifications': { useChatNotifications: () => notificationBridge },
    './auth-utils': auth,
  };
  const context = {
    exports: {}, URL, __DEV__: false, setTimeout, clearTimeout,
    require(name) { assert(name in modules, `Unexpected native import: ${name}`); return modules[name]; },
  };
  vm.runInNewContext(compiled, context);
  const root = context.exports.default();
  const webview = root.props.children[1].props.children[0];
  webview.props.ref.current = { injectJavaScript: (script) => injectedScripts.push(script) };
  const message = (value) => webview.props.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
  return {
    writes, browserCalls, injectedScripts, message,
    get stored() { return stored; },
    get readCount() { return readCount; },
    signIn() { message({ type: 'sign-in' }); },
    receiveOldCallback() {
      webview.props.onShouldStartLoadWithRequest({
        url: `morsenepal://auth?state=${'a'.repeat(43)}&code=${'b'.repeat(43)}`, isTopFrame: true,
      });
    },
    startRestore() { effects[0](); },
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
