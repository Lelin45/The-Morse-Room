export const QWERTY_ROWS = Object.freeze(['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']);

/** The same familiar key positions are used by lessons and receiving practice. */
export function renderQwertyKeyboard({ attribute = 'data-training-key', disabled = true, label = 'Choose the character you heard' } = {}) {
  if (!/^[a-z][a-z-]+$/.test(attribute)) throw new TypeError('Use a valid key data attribute.');
  return `<div class="mobile-keyboard qwerty-keyboard" aria-label="${label}">${QWERTY_ROWS.map((row) => `<div class="qwerty-row">${[...row].map((character) => `<button type="button" class="mobile-key" ${attribute}="${character}" aria-label="Answer ${character}" ${disabled ? 'disabled' : ''}>${character}</button>`).join('')}</div>`).join('')}</div>`;
}
