// share.js: a Share ▾ button's menu (from galley's web/share.ts).
//
// The kit's half is the menu and its words: the labels, the status line
// after a Share, and how long that line stays. The tool's half is which
// items to pass and what each one does, in onPick. It imports nothing, so a
// page without the rest of the kit (galley) can bundle it alone; share.css
// styles it through --share-* properties.

export const SHARE_LABEL = 'Share ▾';
export const SHARE_DOWNLOAD_HTML = 'Download HTML';
export const SHARE_DOWNLOAD_MD = 'Download Markdown';
export const SHARE_SHARE_HTML = 'Share HTML';
export const SHARE_SHARE_MD = 'Share Markdown';
export const SHARE_COPY_LINK = 'Copy link';
export const SHARE_PRINT = 'Print or save as PDF';

// SHARE_REPLY_MS is how long a Share's copied line stays on the status line
// before it clears itself. An error stays until something else is said.
export const SHARE_REPLY_MS = 5000;

// sharedLine is the status line after a Share put the file at path on the
// clipboard.
export function sharedLine(path) {
  const i = path.lastIndexOf('/');
  return `${i === -1 ? path : path.slice(i + 1)} copied · paste to attach`;
}

// shareMenu builds button's menu from items ({label, act}), hidden, and makes
// the button toggle it. An item {label, heading: true} is a label over the
// items after it: nothing to press, and not in the tab order. A pick closes it and calls onPick(act, item); an
// outside click, Escape and a resize close it. It opens right-aligned under
// the button, so a button at the bar's right end grows its menu leftward
// over the page rather than off its edge.
export function shareMenu(button, items, onPick) {
  const el = document.createElement('div');
  el.className = 'kit-share-menu';
  el.setAttribute('role', 'menu');
  el.hidden = true;
  for (const item of items) {
    if (item.heading) {
      const h = document.createElement('div');
      h.className = 'kit-share-heading';
      h.textContent = item.label;
      el.append(h);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.addEventListener('click', () => {
      close();
      onPick(item.act, item);
    });
    el.append(b);
  }
  document.body.append(el);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  function open() {
    const at = button.getBoundingClientRect();
    const right = document.documentElement.clientWidth - at.right;
    el.hidden = false;
    el.style.top = `${at.bottom + window.scrollY + 4}px`;
    el.style.right = `${Math.max(4, right - window.scrollX)}px`;
    el.style.left = 'auto';
    button.setAttribute('aria-expanded', 'true');
  }
  function close() {
    el.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  const isOpen = () => !el.hidden;
  const toggle = () => (isOpen() ? close() : open());

  // In capture, so a handler below that stops the click cannot keep the menu
  // open. The button is not outside: it owns the toggle.
  const onOutside = (e) => {
    if (!isOpen() || !(e.target instanceof Node)) return;
    if (el.contains(e.target) || button.contains(e.target)) return;
    close();
  };
  // Escape closes the menu and goes no further, so a page's own Esc (the
  // kit's keys) does not also act on it.
  const onKey = (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
    button.focus();
  };
  button.addEventListener('click', toggle);
  document.addEventListener('click', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);

  return {
    el,
    open,
    close,
    toggle,
    isOpen,
    destroy() {
      button.removeEventListener('click', toggle);
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      el.remove();
    },
  };
}
