import { createSelection } from './selection.js';
import { MESSAGE_STATES } from './msgstate.js';
import { submitOnEnter } from './enter.js';

// DOM builders for the kit's components. Each returns plain elements styled by
// kit.css; the CSS classes are the contract and also work from static HTML.

// h creates an element. attrs: class → className, on<event> → listener,
// dataset → data-*, booleans set or remove the attribute; string children are
// text (never HTML). null, undefined and false children are skipped.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') {
      if (k in el) el[k] = v;
      else el.toggleAttribute(k, v);
    } else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const count = n => (n === undefined || n === null || n === '' ? null : h('span', { class: 'kit-n' }, String(n)));

const LIVE_TEXT = { live: 'live', polling: 'polling', down: 'offline', stale: 'stale' };

// alsoOpen is the bar's "also open" area: other work a click away (diazo's
// other plans). It is one button of fixed width, so the bar never moves as
// the work changes: it counts the work and how much waits on Court, and opens
// a floating list with every item in full.
function alsoOpen() {
  const dot = h('i');
  const text = h('span', { class: 'kit-also-text' });
  const btn = h('button', { class: 'kit-also-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, dot, text);
  const el = h('span', { class: 'kit-also', hidden: true }, btn);
  let items = [];
  let menu = null;

  // The page you are on is listed in its place, so the list reads the same
  // on every page; its row says so and only closes the list.
  const row = it => h('button', {
    class: 'kit-also-row', type: 'button', role: 'menuitem', dataset: { tone: it.tone || 'idle' },
    'aria-current': it.current ? 'page' : null,
    onclick: () => { closeMenu(); if (!it.current) it.onClick(); },
  }, h('i'), h('span', { class: 'kit-also-name' }, it.label, it.current ? h('span', { class: 'kit-also-here' }, 'you are here') : null),
  it.detail ? h('span', { class: 'kit-also-detail' }, it.detail) : null);

  const onKey = e => { if (e.key === 'Escape' && !e.isComposing) closeMenu(); };
  const onDown = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
  }
  function openMenu() {
    menu = h('div', { class: 'kit-float kit-also-menu', role: 'menu' }, items.map(row));
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
  }
  btn.addEventListener('click', () => (menu ? closeMenu() : openMenu()));

  return {
    el,
    set(next) {
      closeMenu();
      items = next.slice();
      const you = items.filter(it => it.tone === 'you').length;
      btn.dataset.tone = you ? 'you' : 'idle';
      text.textContent = (you ? `${you} ${you === 1 ? 'needs' : 'need'} you · ` : '') + `${items.length} open`;
      el.hidden = !items.length;
    },
  };
}

// bar is the top bar: brand, section controls with counts, status text, the
// "also open" button, the live pill, theme, and the one filled primary button.
export function bar(o) {
  const ctls = new Map();
  for (const s of o.sections || []) {
    ctls.set(s.id, h('button', { class: 'kit-ctl', type: 'button', dataset: { id: s.id }, onclick: () => o.onSection && o.onSection(s.id) }, s.label, count(s.count)));
  }
  const status = h('span', { class: 'kit-status' }, o.status || '');
  const also = alsoOpen();
  const pill = h('span', { class: 'kit-live', hidden: true, role: 'status' });
  const themeControl = o.theme || h('button', { class: 'kit-ctl', type: 'button' }, 'theme');
  const primary = h('button', { class: 'kit-primary', type: 'button', hidden: true });
  let run = null;
  primary.addEventListener('click', () => run && run());

  const handle = {
    el: h('header', { class: 'kit-bar' },
      h(o.brand.href ? 'a' : 'span', { class: 'kit-brand', href: o.brand.href || null }, o.brand.mark || null, o.brand.name),
      ...ctls.values(), status, h('span', { class: 'kit-sp' }), also.el, pill, themeControl, primary),
    themeControl,
    setSection(id) {
      for (const [k, el] of ctls) {
        el.classList.toggle('on', k === id);
        if (k === id) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      }
    },
    setSectionsShown(shown) {
      for (const el of ctls.values()) el.hidden = !shown;
    },
    setCount(id, n) {
      const el = ctls.get(id);
      if (!el) return;
      el.querySelector('.kit-n')?.remove();
      const c = count(n);
      if (c) el.append(c);
    },
    setStatus(text, opts = {}) {
      status.textContent = text;
      if (opts.tone && opts.tone !== 'muted') status.dataset.tone = opts.tone;
      else status.removeAttribute('data-tone');
    },
    setLive(s, text) {
      pill.hidden = false;
      pill.dataset.state = s;
      const fallback = s === 'stale' && o.staleText ? o.staleText : LIVE_TEXT[s] || s;
      pill.replaceChildren(h('i'), text ?? fallback);
    },
    setPrimary(p) {
      run = p ? p.run : null;
      primary.hidden = !p;
      primary.textContent = p ? p.label : '';
    },
    setElsewhere(items) {
      also.set(items || []);
    },
  };
  handle.setSection(o.active);
  handle.setPrimary(o.primary || null);
  return handle;
}

function chipRow(group, chips, onChip) {
  return (chips || []).map(c =>
    h('button', { class: 'kit-chip' + (c.on ? ' on' : ''), type: 'button', dataset: { id: c.id }, onclick: () => onChip && onChip(group, c.id) }, c.label, count(c.count)));
}

// list is the list panel: a section label, view and filter chips, rows, and
// a footer. It satisfies the keyboard layer's ListNav. The cursor (.cur) is
// where j/k are; the open row (.open) is the one in the reading column.
export function list(o) {
  let items = [];
  let keys = [];
  let rows = [];
  let cur = -1;
  let opened = -1;
  // Selection lives in a store (shared with other views when o.selection is
  // given), keyed by row identity: the row's id, else a private key + title
  // identity that only this list uses. It covers rows not rendered and
  // survives setItems.
  const store = o.selection || createSelection();
  const views = h('div', { class: 'kit-chips', dataset: { group: 'view' } });
  const filters = h('div', { class: 'kit-chips', dataset: { group: 'filter' } });
  const body = h('div', { class: 'kit-rows', role: 'list' });
  // The optional search field: onInput on every input event (no debounce;
  // debounce in the page if the query is costly). Esc in it clears the text
  // first, then leaves the field (the keyboard layer's field rule).
  const search = o.search
    ? h('input', { class: 'kit-search', type: 'search', placeholder: o.search.placeholder || 'search', value: o.search.value || '', 'aria-label': o.search.placeholder || 'search' })
    : null;
  if (search) {
    search.addEventListener('input', () => o.search.onInput(search.value));
    search.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.isComposing || !search.value) return;
      e.preventDefault(); // handled: the keyboard layer won't also blur
      search.value = '';
      o.search.onInput('');
    });
  }
  const el = h('aside', { class: 'kit-list' },
    h('div', { class: 'kit-lh' }, h('div', { class: 'kit-eyebrow' }, o.label), views, filters, search),
    body,
    o.foot ? h('div', { class: 'kit-foot' }, o.foot) : null);

  const PRIVATE = '\u0000';
  const keyOf = (item, i) => {
    const r = o.row(item);
    if (r.id !== undefined) return String(r.id);
    return PRIVATE + (r.key !== undefined ? r.key + PRIVATE + r.title : 'i' + i);
  };
  const clamp = i => Math.max(0, Math.min(items.length - 1, i));
  const isSel = i => store.has(keys[i]);
  const selectable = i => !!o.row(items[i]).selectable;
  // What onSelect reports on: the id set and which rendered rows are selected.
  const snapshot = () => store.ids().join('\n') + '\u0001' + keys.filter(k => store.has(k)).join('\n');
  let last = snapshot();

  function paint() {
    rows.forEach((r, i) => {
      r.classList.toggle('cur', i === cur);
      r.classList.toggle('open', i === opened);
      r.classList.toggle('sel', isSel(i));
      if (i === opened) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
      const box = r.querySelector('.kit-box');
      if (box) box.setAttribute('aria-checked', String(isSel(i)));
    });
  }

  // Every change to the store, from this list or another view, repaints and
  // reports once.
  let quiet = false; // setItems' own store changes: it reports once itself
  function changed() {
    if (quiet) return;
    paint();
    const now = snapshot();
    if (now === last) return;
    last = now;
    if (o.onSelect) o.onSelect(handle.selected());
  }
  const unsubscribe = store.onChange(changed);

  function render() {
    rows = items.map((item, i) => {
      const r = o.row(item);
      const box = r.selectable
        ? h('span', { class: 'kit-box', role: 'checkbox', 'aria-checked': 'false', onclick: e => { e.stopPropagation(); e.shiftKey ? handle.toggleRange(i) : handle.toggle(i); } })
        : null;
      return h('div', { class: 'kit-row' + (box ? ' has-box' : ''), role: 'listitem', onclick: e => (e.shiftKey && box ? handle.toggleRange(i) : handle.open(i)) },
        box,
        h('div', { class: 'kit-row-main' },
          r.key !== undefined ? h('div', { class: 'kit-kicker' }, r.key) : null,
          h('div', { class: 'kit-title' }, r.title),
          r.sub ? h('div', { class: 'kit-sub' }, r.sub) : null),
        r.meta !== undefined ? h('span', { class: 'kit-meta' }, r.meta) : null);
    });
    body.replaceChildren(...rows);
  }

  const handle = {
    el,
    selection: store,
    setItems(next) {
      const openKey = opened >= 0 ? keys[opened] : null;
      const curKey = cur >= 0 ? keys[cur] : null;
      items = next.slice();
      keys = items.map(keyOf);
      opened = openKey === null ? -1 : keys.indexOf(openKey);
      const was = cur;
      cur = curKey === null ? -1 : keys.indexOf(curKey);
      if (cur < 0 && items.length) cur = was >= 0 ? clamp(was) : opened >= 0 ? opened : 0;
      render();
      // Rows without an id belong to this page only: drop their stale identities.
      const gone = store.ids().filter(k => k.startsWith(PRIVATE) && !keys.includes(k));
      if (gone.length) {
        quiet = true;
        try {
          store.deselect(gone);
        } finally {
          quiet = false;
        }
      }
      changed(); // the one paint and report
    },
    setChips(group, chips) {
      (group === 'view' ? views : filters).replaceChildren(...chipRow(group, chips, o.onChip));
    },
    move(d) {
      if (!items.length) return;
      cur = clamp((cur < 0 ? 0 : cur) + d);
      paint();
      rows[cur].scrollIntoView?.({ block: 'nearest' });
      if (o.openOnMove) handle.open(cur);
    },
    open(i = cur) {
      if (i < 0 || i >= items.length) return;
      cur = opened = i;
      paint();
      if (o.onOpen) o.onOpen(items[i], i);
    },
    toggle(i = cur) {
      if (i < 0 || i >= items.length || !selectable(i)) return;
      store.toggle(keys[i]);
    },
    toggleRange(i = cur) {
      if (i < 0 || i >= items.length) return;
      const order = keys.filter((_, j) => selectable(j));
      const anchor = store.anchor();
      if (anchor === null || !order.includes(anchor)) return handle.toggle(i);
      if (selectable(i)) store.range(anchor, keys[i], order);
    },
    selected: () => items.filter((_, i) => isSel(i)),
    selectedIds: () => store.ids().filter(k => !k.startsWith(PRIVATE)),
    selectAll: ids => store.all(ids.map(String)),
    deselect: ids => store.deselect(ids.map(String)),
    clearSelection: () => store.clear(),
    current: () => cur,
    setSearch(text) {
      if (search) search.value = text;
    },
    destroy() {
      unsubscribe();
    },
  };
  if (search) handle.focusSearch = () => search.focus();
  handle.setChips('view', o.views);
  handle.setChips('filter', o.filters);
  return handle;
}

// facts is the reading column's facts line: muted labels, bold values.
export function facts(pairs) {
  return h('div', { class: 'kit-facts' }, pairs.map(([label, value]) =>
    h('span', null, label, ' ', value instanceof Node && value.tagName === 'B' ? value : h('b', null, value))));
}

// buttons is a row of lowercase mono buttons: fill marks the one primary,
// danger is a destructive verb (red text).
export function buttons(bs) {
  return h('div', { class: 'kit-btns' }, bs.map(b =>
    h('button', {
      class: 'kit-btn' + (b.fill ? ' fill' : '') + (b.danger ? ' danger' : ''),
      type: 'button',
      disabled: !!b.disabled,
      onclick: () => b.run && b.run(),
    }, b.label)));
}

// card is a colour-edged card that holds its own actions. edge: signal (needs
// you), agent (the agent's), wait (queued / draft). A head that is a string is
// its crumb, so it gets the header's ellipsis when it doesn't fit.
export function card(o) {
  const head = typeof o.head === 'string' ? h('span', { class: 'kit-card-crumb' }, o.head) : o.head;
  return h('div', { class: 'kit-card' + (o.edge ? ' edge-' + o.edge : '') },
    head ? h('div', { class: 'kit-card-head' }, head) : null,
    o.body !== undefined ? h('div', { class: 'kit-card-body' }, o.body) : null,
    o.actions && o.actions.length ? buttons(o.actions) : null);
}

// codeBlock shows source with line numbers: a gutter <pre> and a source <pre>,
// two text nodes however long the file. It scrolls sideways, never wraps.
export function codeBlock(src, o = {}) {
  const start = o.start ?? 1;
  const lines = src.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const text = lines.join('\n');
  const gutter = lines.map((_, i) => start + i).join('\n');
  return h('div', { class: 'kit-code' },
    h('pre', { class: 'kit-gutter', 'aria-hidden': 'true' }, gutter),
    h('pre', { class: 'kit-src' }, o.highlight ? o.highlight(text) : text));
}

// fold is a collapsible section: a small-caps label with a disclosure.
export function fold(label, content, o = {}) {
  return h('details', { class: 'kit-fold', open: !!o.open },
    h('summary', { class: 'kit-label' }, label),
    h('div', { class: 'kit-fold-body' }, content));
}

// noteField is an inline note: ↵ or blur commits a changed value, Esc
// reverts and leaves. While it has focus the keyboard layer ignores page keys.
export function noteField(o) {
  let committed = o.value || '';
  const input = h('input', { class: 'kit-note', type: 'text', value: committed, placeholder: o.placeholder || '' });
  const commit = () => {
    if (input.value === committed) return;
    committed = input.value;
    o.onCommit(committed);
  };
  submitOnEnter(input, commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = committed;
      input.blur();
    }
  });
  input.addEventListener('blur', commit);
  return input;
}

const stateLabel = new Map(MESSAGE_STATES.map(s => [s.state, s.label]));

// messagePill is where one message Court sent stands: the state's pill, its
// label from tools-common/msgstate's list (msgstate.js), and the line under it
// (who has it, or what the agent is doing). An unknown state shows as itself.
export function messagePill(state, line) {
  return h('span', { class: 'kit-msg' },
    h('span', { class: 'kit-pill', dataset: { state } }, stateLabel.get(state) ?? state),
    line ? h('span', { class: 'kit-msg-line' }, line) : null);
}
