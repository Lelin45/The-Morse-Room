/** Keyboard-like presses: act on contact, repeat only Backspace, stop on release. */
export function bindPressControls(root, {
  selector,
  onPress,
  repeats = () => false,
  // Match Android's keyboard repeat defaults: 400 ms, then 20 keys/second.
  repeatDelay = 400,
  repeatInterval = 50,
  documentTarget = root.ownerDocument,
  windowTarget = documentTarget?.defaultView,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const pointers = new Map();
  const keys = new Map();
  const listeners = [];
  const listen = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const controlFor = (event) => {
    const control = event.target?.closest?.(selector);
    return control && root.contains(control) ? control : null;
  };
  const enabled = (control) => root.contains(control) && !control.disabled
    && control.getAttribute('aria-disabled') !== 'true' && !control.closest('[hidden], [inert]');
  const release = (id) => {
    const held = pointers.get(id);
    if (!held) return;
    pointers.delete(id);
    if (held.timer !== null) clearTimer(held.timer);
    if (![...pointers.values()].some((other) => other.control === held.control)) {
      held.control.classList.remove('is-pressed');
    }
    try { held.control.releasePointerCapture?.(id); } catch { /* Capture may already be lost. */ }
  };
  const cancel = () => {
    for (const id of [...pointers.keys()]) release(id);
    keys.clear();
  };
  const repeat = (id) => {
    const held = pointers.get(id);
    if (!held) return;
    if (!enabled(held.control)) { release(id); return; }
    onPress(held.control);
    if (pointers.get(id) === held) held.timer = setTimer(() => repeat(id), repeatInterval);
  };

  listen(root, 'pointerdown', (event) => {
    const control = controlFor(event);
    if (!control || event.button !== 0 || !enabled(control)) return;
    event.preventDefault();
    if (pointers.has(event.pointerId)) return;
    const held = { control, timer: null };
    pointers.set(event.pointerId, held);
    control.classList.add('is-pressed');
    try { control.setPointerCapture?.(event.pointerId); } catch { /* Release is also watched on the document. */ }
    // No await, debounce, or audio completion before the draft changes.
    onPress(control);
    if (repeats(control) && pointers.get(event.pointerId) === held) {
      held.timer = setTimer(() => repeat(event.pointerId), repeatDelay);
    }
  });
  listen(documentTarget, 'pointerup', (event) => release(event.pointerId), true);
  listen(documentTarget, 'pointercancel', (event) => release(event.pointerId), true);
  listen(root, 'lostpointercapture', (event) => release(event.pointerId));
  listen(root, 'pointermove', (event) => {
    const held = pointers.get(event.pointerId);
    if (!held) return;
    const rect = held.control.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) release(event.pointerId);
  });
  listen(root, 'keydown', (event) => {
    const control = controlFor(event);
    if (!control || !['Enter', ' '].includes(event.key) || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey || !enabled(control)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.code || event.key;
    keys.set(id, control);
    if (!event.repeat || repeats(control)) onPress(control);
  });
  listen(documentTarget, 'keyup', (event) => {
    const id = event.code || event.key;
    if (keys.has(id)) { event.preventDefault(); keys.delete(id); }
  }, true);
  listen(root, 'click', (event) => {
    const control = controlFor(event);
    if (!control) return;
    event.preventDefault();
    event.stopPropagation();
    // Pointer activation already happened on down. Zero-detail clicks retain
    // screen-reader and programmatic activation without adding a second mark.
    if (event.detail === 0 && enabled(control)) onPress(control);
  }, true);
  listen(root, 'contextmenu', (event) => {
    if (controlFor(event)) event.preventDefault();
  });
  listen(documentTarget, 'visibilitychange', () => { if (documentTarget.hidden) cancel(); });
  listen(windowTarget, 'blur', cancel);
  listen(windowTarget, 'pagehide', cancel);
  listen(windowTarget, 'morse-native-background', cancel);
  return {
    cancel,
    destroy() { cancel(); for (const remove of listeners) remove(); },
  };
}
