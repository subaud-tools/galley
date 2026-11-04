// tip.ts — the kit's tip where a control used to carry the browser's title.
//
// The kit's wireTip takes a press on its trigger to open the tip, which suits
// a dot or a line with nothing else to do. A control's press is its own, so
// here the tip opens on hover and on keyboard focus only (wireTip's `when` is
// true during the focus alone), a click, Enter and Space go to the control, and
// the control's own aria-expanded is kept: wireTip would write it.
//
// The box a tip needs (.kit-tip-at) is `display: contents` (editor.css): the
// control lays out exactly as it did, a flex item, a block card or an absolute
// grip alike, and the tip is position: fixed. A box with no box of its own has
// no rect, so the box measures as its control does, for the kit's placement.

import { lineTip, wireTip } from './kit/tip.js';

const words = new WeakMap<HTMLElement, string>();
let made = 0;

/** The tip box el sits in, or el when it has none: what a caller places. */
export function tipBox(el: HTMLElement): HTMLElement {
  const box = el.parentElement;
  return box?.classList.contains('gly-tip-at') ? box : el;
}

/** What el's tip says, '' with none. */
export function tipText(el: HTMLElement): string {
  return words.get(el) ?? '';
}

/** Puts el in a tip box in its place, the first time. */
function wrap(el: HTMLElement, text: string): HTMLElement {
  const tip = lineTip(text);
  tip.id = `gly-tip-${++made}`;
  const box = document.createElement('span');
  box.className = 'kit-tip-at gly-tip-at';
  box.getBoundingClientRect = () => el.getBoundingClientRect();
  el.replaceWith(box);
  box.append(el, tip);
  el.setAttribute('aria-describedby', tip.id);
  let own: string | null = null;
  let focusing = false;
  const keep = () => {
    own = el.getAttribute('aria-expanded');
  };
  const restore = () => {
    if (own === null) el.removeAttribute('aria-expanded');
    else el.setAttribute('aria-expanded', own);
  };
  const events = ['focus', 'blur', 'click', 'keydown'];
  for (const e of events) el.addEventListener(e, keep);
  el.addEventListener('focus', () => (focusing = true));
  keep();
  wireTip(box, el, tip, () => focusing && !!tip.textContent);
  restore();
  el.addEventListener('focus', () => (focusing = false));
  for (const e of events) el.addEventListener(e, restore);
  return tip;
}

/** el's tip says text, where `el.title = text` used to: the first call on an
 * element in its parent puts it in a tip box; '' shows no tip. An element not
 * in a parent yet keeps the words and gets its box on a call once it is. */
export function tip(el: HTMLElement, text: string): void {
  words.set(el, text);
  const box = tipBox(el);
  if (box !== el) {
    box.querySelector(':scope > .kit-tip')!.textContent = text;
  } else if (el.parentNode) {
    wrap(el, text);
  }
}
