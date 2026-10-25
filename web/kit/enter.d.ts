// ---- enter.js

/**
 * A plain Enter calls submit and prevents its new line; Shift-Enter, a repeat
 * and an IME's Enter (isComposing or keyCode 229) keep the key's usual meaning.
 * Returns the field.
 */
export function submitOnEnter<T extends { addEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void }>(
  field: T,
  submit: () => void,
): T;

