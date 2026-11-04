// tip.js: the page's one pop-out, a .kit-tip inside a .kit-tip-at box. It opens
// at once on hover, on keyboard focus or Enter, and on a tap, sits in the window
// with position: fixed, so no column or card that scrolls clips it, and closes
// on Esc, on leaving by keyboard, or on the next tap elsewhere.
import { h } from './dom.js';

const GAP = 6;
const EDGE = 8;

// Under the box, or over it where the window has no room below; moved sideways
// to stay in the window.
function place(box, tip) {
  const at = box.getBoundingClientRect();
  const r = tip.getBoundingClientRect();
  const x = Math.min(at.left, window.innerWidth - EDGE - r.width);
  const below = at.bottom + GAP;
  const y = below + r.height > window.innerHeight - EDGE ? at.top - GAP - r.height : below;
  tip.style.left = `${Math.max(EDGE, x)}px`;
  tip.style.top = `${Math.max(EDGE, y)}px`;
}

// wireTip makes trigger open tip inside box. when, if given, says whether a
// press or focus has anything to show; a press with nothing to show goes to
// what is under it.
export function wireTip(box, trigger, tip, when = () => true) {
  const set = on => {
    box.classList.toggle('show', on);
    trigger.setAttribute('aria-expanded', String(on));
    if (on) {
      place(box, tip);
      document.addEventListener('click', shut);
    } else document.removeEventListener('click', shut);
  };
  function shut(e) {
    if (!box.contains(e.target)) set(false);
  }
  trigger.setAttribute('aria-expanded', 'false');
  box.addEventListener('mouseenter', () => place(box, tip));
  trigger.addEventListener('focus', () => {
    if (when() && trigger.matches(':focus-visible')) set(true);
  });
  trigger.addEventListener('blur', () => set(false));
  trigger.addEventListener('click', e => {
    if (!when()) return;
    e.preventDefault();
    e.stopPropagation();
    set(!box.classList.contains('show'));
  });
  trigger.addEventListener('keydown', e => {
    if (e.key === 'Escape') set(false);
    else if ((e.key === 'Enter' || e.key === ' ') && when()) {
      e.preventDefault();
      e.stopPropagation();
      set(!box.classList.contains('show'));
    }
  });
}

// lineTip is what the page says on a tip that is one plain line.
export function lineTip(text) {
  return h('span', { class: 'kit-tip', role: 'tooltip' }, text);
}
