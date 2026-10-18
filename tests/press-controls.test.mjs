import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPressControls } from '../press-controls.js';

function setup() {
  let time = 0;
  let nextId = 1;
  const tasks = new Map();
  class Target {
    constructor() { this.handlers = new Map(); }
    addEventListener(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(handler);
    }
    removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
    emit(type, options = {}) {
      const event = {
        target: options.target, button: 0, pointerId: 1, detail: 1,
        clientX: 20, clientY: 20, prevented: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        ...options,
      };
      for (const handler of this.handlers.get(type) || []) handler(event);
      return event;
    }
  }
  const windowTarget = new Target();
  const documentTarget = new Target();
  documentTarget.defaultView = windowTarget;
  const root = new Target();
  root.ownerDocument = documentTarget;
  root.contains = (control) => control.attached;
  function control(key) {
    const classes = new Set();
    return {
      key, attached: true, disabled: false, hidden: false,
      getAttribute: () => null,
      classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) },
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
    };
  }
  const buttons = ['.', '-', 'undo'].map((key) => {
    const button = control(key);
    button.closest = (selector) => selector === '[hidden], [inert]' ? button.hidden ? button : null : button;
    return button;
  });
  const pressed = [];
  const binding = bindPressControls(root, {
    selector: 'button', onPress: (button) => pressed.push(button.key), repeats: (button) => button.key === 'undo',
    setTimer(callback, delay) { const id = nextId++; tasks.set(id, { at: time + delay, callback }); return id; },
    clearTimer: (id) => tasks.delete(id),
  });
  return {
    root, documentTarget, windowTarget, buttons, pressed, binding, tasks,
    advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
  };
}

test('marks register on contact before release, with no delayed click duplicate', () => {
  const s = setup();
  const button = s.buttons[0];
  const event = s.root.emit('pointerdown', { target: button });
  assert.equal(event.prevented, true);
  assert.deepEqual(s.pressed, ['.']);
  assert.equal(button.classList.contains('is-pressed'), true);
  s.advance(2000);
  assert.deepEqual(s.pressed, ['.'], 'holding a Dit never repeats it');
  s.documentTarget.emit('pointerup', { target: button });
  s.root.emit('click', { target: button, detail: 1 });
  assert.deepEqual(s.pressed, ['.']);
  assert.equal(button.classList.contains('is-pressed'), false);
});

test('100 rapid alternating two-thumb contacts retain every mark including secondary touch', () => {
  const s = setup();
  const expected = [];
  for (let i = 0; i < 100; i += 1) {
    const index = i % 2;
    expected.push(s.buttons[index].key);
    s.root.emit('pointerdown', { target: s.buttons[index], pointerId: i + 1, isPrimary: index === 0 });
    if (i) s.documentTarget.emit('pointerup', { pointerId: i });
    s.advance(20);
  }
  s.binding.cancel();
  assert.deepEqual(s.pressed, expected);
  assert.equal(s.tasks.size, 0);
});

test('held Backspace deletes immediately, then repeats at keyboard cadence and stops on release', () => {
  const s = setup();
  const button = s.buttons[2];
  s.root.emit('pointerdown', { target: button });
  assert.equal(s.pressed.length, 1);
  s.advance(399);
  assert.equal(s.pressed.length, 1);
  s.advance(1);
  assert.equal(s.pressed.length, 2);
  s.advance(150);
  assert.equal(s.pressed.length, 5);
  s.documentTarget.emit('pointerup', { target: button });
  s.advance(1000);
  assert.equal(s.pressed.length, 5);
  assert.equal(s.tasks.size, 0);
});

test('cancellation, capture loss, pointer leaving, hidden document, background and blur stop deletion', () => {
  const actions = [
    (s) => s.documentTarget.emit('pointercancel'),
    (s) => s.root.emit('lostpointercapture'),
    (s) => s.root.emit('pointermove', { clientX: 101 }),
    (s) => { s.documentTarget.hidden = true; s.documentTarget.emit('visibilitychange'); },
    (s) => s.windowTarget.emit('morse-native-background'),
    (s) => s.windowTarget.emit('blur'),
    (s) => s.windowTarget.emit('pagehide'),
    (s) => s.binding.cancel(),
  ];
  for (const cancel of actions) {
    const s = setup();
    s.root.emit('pointerdown', { target: s.buttons[2] });
    cancel(s);
    s.advance(1000);
    assert.deepEqual(s.pressed, ['undo']);
    assert.equal(s.tasks.size, 0);
    assert.equal(s.buttons[2].classList.contains('is-pressed'), false);
  }
});

test('releasing another thumb does not stop held Backspace', () => {
  const s = setup();
  s.root.emit('pointerdown', { target: s.buttons[2], pointerId: 1 });
  s.root.emit('pointerdown', { target: s.buttons[0], pointerId: 2, isPrimary: false });
  s.documentTarget.emit('pointerup', { pointerId: 2 });
  s.advance(400);
  assert.deepEqual(s.pressed, ['undo', '.', 'undo']);
  s.binding.cancel();
});

test('keyboard and assistive activation work, with repeat limited to Backspace', () => {
  const s = setup();
  const target = s.buttons[0];
  const first = s.root.emit('keydown', { target, key: ' ', code: 'Space' });
  assert.equal(first.prevented, true);
  assert.equal(first.stopped, true);
  s.root.emit('keydown', { target, key: ' ', code: 'Space', repeat: true });
  s.documentTarget.emit('keyup', { target, key: ' ', code: 'Space' });
  s.root.emit('click', { target, detail: 0 });
  for (let i = 0; i < 4; i += 1) s.root.emit('keydown', { target: s.buttons[2], key: 'Enter', repeat: i > 0 });
  assert.deepEqual(s.pressed, ['.', '.', 'undo', 'undo', 'undo', 'undo']);
});

test('disabled, hidden, detached and non-left mouse buttons never insert or continue repeating', () => {
  const s = setup();
  const target = s.buttons[0];
  target.disabled = true;
  s.root.emit('pointerdown', { target });
  target.disabled = false;
  target.hidden = true;
  s.root.emit('pointerdown', { target });
  target.hidden = false;
  target.attached = false;
  s.root.emit('pointerdown', { target });
  target.attached = true;
  s.root.emit('pointerdown', { target, button: 2 });
  assert.deepEqual(s.pressed, []);
  const undo = s.buttons[2];
  s.root.emit('pointerdown', { target: undo });
  undo.attached = false;
  s.advance(1000);
  assert.deepEqual(s.pressed, ['undo']);
  assert.equal(s.tasks.size, 0);
  s.binding.destroy();
  s.root.emit('pointerdown', { target });
  assert.deepEqual(s.pressed, ['undo']);
});
