// enter.js: Enter sends what a box holds, Shift-Enter breaks the line (from
// galley's web/rail.ts submitOnEnter, which has the full reasoning). It
// imports nothing, so a page without the rest of the kit (galley) can bundle
// it alone.

// submitOnEnter calls submit on a plain Enter and prevents its new line. It
// leaves the key alone when Shift is held (a new line), when the Enter is a
// repeat (a held key must not send once per repeat), and when it confirms IME
// input (isComposing, or keyCode 229 from browsers that clear isComposing
// first). Whether there is anything to send, and stopping a second press while
// the first send is out, are submit's own business. Returns the field.
export function submitOnEnter(field, submit) {
  field.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter' || e.shiftKey || e.repeat) return;
    e.preventDefault();
    submit();
  });
  return field;
}
