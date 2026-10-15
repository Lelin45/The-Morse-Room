import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/Opening.tsx', import.meta.url), 'utf8');
const timing = JSON.parse(await readFile(new URL('../generated/welcome-timing.json', import.meta.url), 'utf8'));
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual component with persistent hooks and native API boundaries.
// Timers and promises remain separate, as they are during a slow native launch.
function createOpening(initialProps = {}, {
  loaded = true, audioMode = 'resolve', confirmPlayback = true, ringerMode = 'normal', initialAppState = 'active',
} = {}) {
  let now = 0;
  let nextTimer = 0;
  let hookIndex = 0;
  let rendering = false;
  let dirty = false;
  let mounted = true;
  let root;
  let props;
  let status = { isLoaded: loaded, didJustFinish: false, currentTime: 0, playing: false };
  let appliedAudioMode = {};
  let volume = 1;
  let finishCount = 0;
  const timers = new Map();
  const hooks = [];
  const listeners = new Set();
  const effects = [];
  const calls = [];
  const modeRequests = [];
  const setTimer = (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + Math.max(0, Number(delay)), callback });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const changed = (previous, next) => !previous || !next || previous.length !== next.length
    || previous.some((value, index) => !Object.is(value, next[index]));
  const state = (initial) => {
    const index = hookIndex++;
    if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[index].value, (next) => {
      const value = typeof next === 'function' ? next(hooks[index].value) : next;
      if (!Object.is(value, hooks[index].value)) {
        hooks[index].value = value;
        dirty = true;
        if (!rendering && mounted) render();
      }
    }];
  };
  const player = {
    get volume() { return volume; },
    set volume(value) { volume = value; calls.push({ type: 'volume', value, at: now }); },
    play() {
      calls.push({ type: 'play', volume, at: now });
      // Expo 57's Android native play() returns without playback for silent or
      // vibrate ringer mode when playsInSilentMode is false, without throwing.
      if (ringerMode !== 'normal' && !appliedAudioMode.playsInSilentMode) {
        calls.push({ type: 'ringer-suppressed', at: now });
        return;
      }
      if (confirmPlayback) void Promise.resolve().then(() => {
        if (!mounted) return;
        status = { ...status, playing: true };
        render();
      });
    },
    pause() { calls.push({ type: 'pause', at: now }); },
  };
  class AnimatedValue {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate(value) { return value; }
  }
  const animation = (value, options) => {
    let timer;
    return {
      start(callback) {
        calls.push({ type: 'animation', toValue: options.toValue, duration: options.duration, at: now });
        timer = setTimer(() => {
          value.setValue(options.toValue);
          callback?.({ finished: true });
        }, options.duration);
      },
      stop() { clearTimer(timer); },
    };
  };
  const element = (type, elementProps) => ({ type, props: elementProps });
  const appState = {
    currentState: initialAppState,
    addEventListener(name, callback) {
      assert.equal(name, 'change');
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
  };
  const modules = {
    react: {
      useState: state,
      useRef(initial) {
        const index = hookIndex++;
        if (!hooks[index]) hooks[index] = { current: initial };
        return hooks[index];
      },
      useCallback(callback, dependencies) {
        const index = hookIndex++;
        if (!hooks[index] || changed(hooks[index].dependencies, dependencies)) {
          hooks[index] = { callback, dependencies };
        }
        return hooks[index].callback;
      },
      useEffect(callback, dependencies) {
        const index = hookIndex++;
        if (!hooks[index] || changed(hooks[index].dependencies, dependencies)) {
          effects.push(() => {
            hooks[index]?.cleanup?.();
            hooks[index] = { dependencies, cleanup: callback() };
          });
        }
      },
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      AppState: appState, Pressable: 'pressable', Text: 'text', View: 'view',
      StyleSheet: { create: (value) => value, absoluteFill: {} },
      Animated: {
        Value: AnimatedValue, View: 'animated-view', timing: animation,
        sequence: (animations) => ({ animations }),
        loop: () => ({
          start() { calls.push({ type: 'loop-start', at: now }); },
          stop() { calls.push({ type: 'loop-stop', at: now }); },
        }),
      },
    },
    'expo-audio': {
      useAudioPlayer(asset, options) {
        assert.equal(asset, 'welcome.wav');
        assert.equal(options.updateInterval, 40);
        assert.notEqual(options.downloadFirst, true, 'Bundled welcome audio must not wait for an asset download');
        return player;
      },
      useAudioPlayerStatus: (instance) => { assert.equal(instance, player); return status; },
      setAudioModeAsync(options) {
        calls.push({ type: 'audio-mode', options, at: now });
        if (audioMode === 'resolve') return Promise.resolve().then(() => { appliedAudioMode = options; });
        if (audioMode === 'reject') return Promise.reject(new Error('Audio mode unavailable'));
        return new Promise((resolve, reject) => modeRequests.push({
          resolve: () => { appliedAudioMode = options; resolve(); }, reject,
        }));
      },
    },
    '../generated/welcome-timing.json': timing,
    '../assets/welcome.wav': 'welcome.wav',
  };
  const context = {
    exports: {}, setTimeout: setTimer, clearTimeout: clearTimer,
    require(name) { assert(name in modules, `Unexpected native import: ${name}`); return modules[name]; },
  };
  vm.runInNewContext(compiled, context);
  props = {
    dark: true, volume: 50, preferencesReady: true, visible: true, loadFailed: false,
    onFinish: () => { finishCount++; }, ...initialProps,
  };
  function render() {
    if (!mounted) return;
    rendering = true;
    do {
      dirty = false;
      hookIndex = 0;
      root = context.exports.default(props);
      while (effects.length) effects.shift()();
    } while (dirty);
    rendering = false;
  }
  function findElement(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
    for (const child of children.flat()) {
      const result = findElement(child, predicate);
      if (result) return result;
    }
    return null;
  }
  render();
  return {
    calls, player,
    get now() { return now; },
    get finishCount() { return finishCount; },
    get pendingTimers() { return timers.size; },
    get listenerCount() { return listeners.size; },
    update(nextProps) { props = { ...props, ...nextProps }; render(); },
    setStatus(nextStatus) { status = { ...status, ...nextStatus }; render(); },
    skip() {
      const button = findElement(root, (node) => node.type === 'pressable');
      assert(button, 'The welcome must expose its Skip control');
      button.props.onPress();
    },
    appState(nextState) {
      appState.currentState = nextState;
      for (const callback of [...listeners]) callback(nextState);
    },
    resolveAudioMode(index = 0) {
      assert(modeRequests[index], 'Audio configuration should be pending');
      modeRequests[index].resolve();
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end)
          .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await settle();
      }
      now = end;
      await settle();
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

test('a slow hidden splash preserves the full welcome and saved mute before playback', async (t) => {
  const opening = createOpening({ visible: false, preferencesReady: false });
  t.after(() => opening.unmount());
  await opening.advance(10000);
  assert.equal(opening.finishCount, 0, 'A welcome hidden for ten seconds must not expire');
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);

  opening.update({ preferencesReady: true, volume: 0 });
  await opening.advance(10000);
  assert.equal(opening.finishCount, 0, 'Preferences alone must not start a hidden intro deadline');
  assert.equal(opening.calls.filter((call) => call.type === 'audio-mode').length, 0);
  assert.equal(opening.calls.filter((call) => call.type === 'loop-start').length, 0);

  opening.update({ visible: true });
  await settle();
  const playIndex = opening.calls.findIndex((call) => call.type === 'play');
  assert(playIndex >= 0, 'Ready and visible welcome audio must start');
  assert.equal(opening.calls[playIndex].volume, 0);
  assert(opening.calls.slice(0, playIndex).some((call) => call.type === 'volume' && call.value === 0),
    'Saved mute must reach the native player before play');
  assert.equal(opening.calls.filter((call) => call.type === 'loop-start').length, 1);
  opening.update({ dark: false });
  opening.setStatus({ currentTime: 1 });
  await settle();
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1, 'Renders must not replay WELCOME');

  assert.equal(timing.wpm, 24);
  assert(Math.abs(timing.duration - 3.68) < 0.0001);
  await opening.advance(timing.duration * 1000);
  assert.equal(opening.finishCount, 0, 'The full audio duration must remain available after native readiness');
  opening.setStatus({ currentTime: timing.duration, didJustFinish: true });
  assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 1);
  await opening.advance(220);
  assert.equal(opening.finishCount, 1);
  opening.skip();
  await opening.advance(10000);
  assert.equal(opening.finishCount, 1, 'Audio completion and fallback timers must not finish twice');
});

test('ten seconds of visible preference loading and delayed audio setup do not consume the playback deadline', async (t) => {
  const opening = createOpening({ preferencesReady: false }, { audioMode: 'defer' });
  t.after(() => opening.unmount());
  await opening.advance(10000);
  assert.equal(opening.finishCount, 0, 'Slow preference loading must survive ten visible seconds');
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);
  opening.update({ preferencesReady: true, volume: 0 });
  await opening.advance(1900);
  assert.equal(opening.finishCount, 0);
  opening.resolveAudioMode();
  await settle();
  const plays = opening.calls.filter((call) => call.type === 'play');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].at, 11900);
  assert.equal(plays[0].volume, 0);

  await opening.advance((timing.duration + 2) * 1000 - 1);
  assert.equal(opening.finishCount, 0, 'The playback deadline must begin at play, after audio setup');
  assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 0);
  await opening.advance(1);
  assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 1);
  await opening.advance(220);
  assert.equal(opening.finishCount, 1, 'A missing native completion event must still allow entry');
});

test('Skip cancels pending audio setup and Skip or background stop confirmed playback once', async () => {
  for (const action of ['skip', 'background']) {
    if (action === 'skip') {
      const opening = createOpening({}, { audioMode: 'defer' });
      try {
        await settle();
        opening.skip();
        assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 1, 'Skip must pause promptly');
        opening.resolveAudioMode();
        await settle();
        assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0, 'Skip must cancel delayed play');
        opening.skip();
        opening.appState('background');
        await opening.advance(220);
        assert.equal(opening.finishCount, 1);
        opening.appState('active');
        opening.setStatus({ currentTime: timing.duration, didJustFinish: true });
        await opening.advance(20000);
        assert.equal(opening.finishCount, 1, 'Skip and remaining timers must finish only once');
        assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);
      } finally { opening.unmount(); }
      assert.equal(opening.listenerCount, 0, 'Unmount must remove the AppState subscription');
    }

    const playing = createOpening();
    try {
      await settle();
      assert.equal(playing.calls.filter((call) => call.type === 'play').length, 1);
      if (action === 'skip') playing.skip();
      else playing.appState('background');
      assert.equal(playing.calls.filter((call) => call.type === 'pause').length, 1,
        `${action} must stop audio already playing`);
      await playing.advance(220);
      assert.equal(playing.finishCount, 1);
      playing.appState('active');
      playing.update({ dark: false });
      await playing.advance(10000);
      assert.equal(playing.calls.filter((call) => call.type === 'play').length, 1, 'Returning must not replay the welcome');
      assert.equal(playing.finishCount, 1);
    } finally { playing.unmount(); }
  }
});

test('missing preferences and an explicit load failure use bounded silent entry after visibility', async () => {
  for (const loadFailed of [false, true]) {
    const opening = createOpening({ visible: false, preferencesReady: false, loadFailed });
    try {
      await opening.advance(10000);
      assert.equal(opening.finishCount, 0, 'A hidden failure must not consume the welcome');
      opening.update({ visible: true });
      if (!loadFailed) {
        await opening.advance(14999);
        assert.equal(opening.finishCount, 0);
        assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 0);
        await opening.advance(1);
      }
      assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 1);
      await opening.advance(220);
      assert.equal(opening.finishCount, 1, 'A visible failure must allow entry without sound');
      opening.update({ preferencesReady: true });
      await opening.advance(10000);
      assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);
      assert.equal(opening.finishCount, 1);
    } finally { opening.unmount(); }
  }
});

test('unloaded audio and rejected audio setup use bounded entry after ten foreground ready seconds', async () => {
  for (const options of [{ loaded: false }, { audioMode: 'reject' }]) {
    const opening = createOpening({ visible: false }, options);
    try {
      await opening.advance(10000);
      assert.equal(opening.finishCount, 0);
      opening.update({ visible: true });
      await opening.advance(9999);
      assert.equal(opening.finishCount, 0);
      assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 0);
      await opening.advance(1);
      assert.equal(opening.calls.filter((call) => call.type === 'pause').length, 1);
      await opening.advance(220);
      assert.equal(opening.finishCount, 1);
      opening.setStatus({ isLoaded: true });
      await opening.advance(10000);
      assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0, 'Late recovery must not play after entry');
      assert.equal(opening.finishCount, 1);
    } finally { opening.unmount(); }
  }
});

test('silent and vibrate Android ringer settings do not suppress welcome media', async () => {
  for (const ringerMode of ['silent', 'vibrate']) {
    const opening = createOpening({ volume: 50 }, { ringerMode });
    try {
      await settle();
      const mode = opening.calls.find((call) => call.type === 'audio-mode');
      assert.equal(mode.options.playsInSilentMode, true);
      assert.equal(mode.options.shouldRouteThroughEarpiece, false);
      assert.equal(opening.calls.filter((call) => call.type === 'ringer-suppressed').length, 0);
      assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1);
      assert.equal(opening.calls.find((call) => call.type === 'play').volume, 0.5);
      opening.setStatus({ currentTime: timing.duration, didJustFinish: true, playing: false });
      await opening.advance(220);
      assert.equal(opening.finishCount, 1, `${ringerMode} must reach native completion rather than a silent timeout`);
    } finally { opening.unmount(); }
  }
});

test('a bundled audio source taking more than two seconds to load still plays completely', async (t) => {
  const opening = createOpening({}, { loaded: false });
  t.after(() => opening.unmount());
  await opening.advance(4500);
  assert.equal(opening.finishCount, 0);
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);
  opening.setStatus({ isLoaded: true });
  await settle();
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1);
  await opening.advance(timing.duration * 1000);
  assert.equal(opening.finishCount, 0, 'Preparation must not consume the playback time');
  opening.setStatus({ currentTime: timing.duration, didJustFinish: true, playing: false });
  await opening.advance(220);
  assert.equal(opening.finishCount, 1);
});

test('the playback deadline starts at native confirmation rather than a no-op play request', async () => {
  const waiting = createOpening({}, { confirmPlayback: false });
  try {
    await settle();
    assert.equal(waiting.calls.filter((call) => call.type === 'play').length, 1);
    await waiting.advance(9000);
    assert.equal(waiting.finishCount, 0, 'A request alone must not start the shorter playback deadline');
    waiting.setStatus({ playing: true });
    await waiting.advance((timing.duration + 2) * 1000 - 1);
    assert.equal(waiting.calls.filter((call) => call.type === 'pause').length, 0);
    await waiting.advance(221);
    assert.equal(waiting.finishCount, 1, 'Confirmed playback still has a bounded completion fallback');
  } finally { waiting.unmount(); }

  const noOp = createOpening({}, { confirmPlayback: false });
  try {
    await settle();
    await noOp.advance(9999);
    assert.equal(noOp.finishCount, 0);
    await noOp.advance(221);
    assert.equal(noOp.finishCount, 1, 'Missing native confirmation must eventually allow entry');
    assert.equal(noOp.calls.filter((call) => call.type === 'play').length, 1);
  } finally { noOp.unmount(); }
});

test('initial null or inactive AppState waits for active and keeps the full welcome', async () => {
  for (const initialAppState of [null, 'inactive']) {
    const opening = createOpening({}, { initialAppState });
    try {
      await opening.advance(20000);
      assert.equal(opening.finishCount, 0, 'Startup state must not silently discard the welcome');
      assert.equal(opening.calls.filter((call) => call.type === 'audio-mode').length, 0);
      opening.appState('active');
      await settle();
      assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1);
      opening.appState('inactive');
      await opening.advance(500);
      assert.equal(opening.finishCount, 0, 'A temporary inactive state is not a background transition');
      opening.appState('active');
      await settle();
      assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1, 'Foreground status changes must not duplicate playback');
      opening.setStatus({ currentTime: timing.duration, didJustFinish: true, playing: false });
      await opening.advance(220);
      assert.equal(opening.finishCount, 1);
    } finally { opening.unmount(); }
  }
});

test('background during preparation cancels the pending request and resumes safely on foreground', async (t) => {
  const opening = createOpening({}, { audioMode: 'defer' });
  t.after(() => opening.unmount());
  await settle();
  opening.appState('background');
  opening.resolveAudioMode(0);
  await opening.advance(20000);
  assert.equal(opening.finishCount, 0);
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 0);
  opening.appState('active');
  opening.resolveAudioMode(1);
  await settle();
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1);
  opening.appState('background');
  await opening.advance(220);
  assert.equal(opening.finishCount, 1, 'Background after requesting playback must stop the welcome');
  opening.appState('active');
  await opening.advance(20000);
  assert.equal(opening.calls.filter((call) => call.type === 'play').length, 1);
});
