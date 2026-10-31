// web/preview.ts — the split-pane live preview, PAGE MODE ONLY.
//
// `galley edit page.html` runs the editor in "page mode": the shell tags the
// #editor mount with data-page-mode="1" and data-preview naming the preview
// under the document's base (internal/serve/editmode.go), and init() (web/entry.ts) hands both to
// mountPreview below. In markdown mode the mount carries neither, so init()
// never reaches this file and the markdown editor renders exactly as it did
// before this pass — the airtight guard the design (change 5) asks for, drawn
// on the same side the server draws its own in editmode.go.
//
// The idea (docs/superpowers/specs/2026-08-29-html-split-preview-design.md):
// one pane is the editable content (the TipTap #editor, untouched), the other
// is the real page rendered live in an iframe with all its own CSS and JS. A
// three-state control — HTML · Both · Content — shows one, the other, or both.
// The iframe reloads when a projection lands, which we learn from the same
// /_galley/saved stamp the App's own poll already reads.

import { getJSON, routes } from './net.ts';
import type { Editor } from '@tiptap/core';
import { headingAlignKey, normHeading, alignKey } from './headingalign.ts';

// The most a single heading is bumped down to meet the page. Alignment is
// section-level and "closer", not "exact": line-for-line is impossible when the
// same block renders at different heights in a plain editor and a styled page
// (a command list is tall in the editor and compact on the page; a hero is the
// reverse). Where a region renders FAR taller on the page, the honest gap can
// be a full screen; this cap trades that away, keeping every gap modest so the
// panes read together without a void. 260 is empirical — enough to close the
// prose-section drift, small enough that the worst mismatch is a short gap, not
// a blank screen.
const MAX_ALIGN_BUMP_PX = 260;

// Realignment is debounced: layout settles in bursts (fonts, images, the iframe
// growing), and each would otherwise fire its own measure and dispatch.
const ALIGN_DEBOUNCE_MS = 120;

// The saved-stamp poll runs on the editor's own cadence. entry.ts spells the
// same 1500 as POLL_MS for tick(); that const is private to entry.ts, so this
// file restates the number with this note tying the two together.
const PREVIEW_POLL_MS = 1500;

// The three views, and the class each one paints on <body>. On the body rather
// than the split container because two of the three ancestors this restyles —
// `main`'s width reservation and the absolute `.gly-rail` — sit ABOVE the
// container, and a descendant cannot reach an ancestor in CSS. This mirrors
// `body.gly-collapsed`, the rail's own existing body-level switch.
type View = 'html' | 'both' | 'content';

// The chosen view outlives a repaint but not the session — a module variable,
// not localStorage, as the brief allows. Default BOTH: both panes side by side.
let currentView: View = 'both';

interface SavedView {
  saved: number;
}

// /_galley/saved advances when a projection lands. The iframe reloads only on
// an ADVANCE past the last value we saw, never on every poll — else each poll
// would thrash the iframe mid-read. Seeded on the first successful poll so the
// initial load (already showing the current page) does not trigger a needless
// reload before anything has been edited.
let lastSaved = 0;
let seeded = false;

// The saved-stamp poll handle, module-scoped so a repeat mountPreview can cancel
// the prior poll before starting a new one — else two polls would race, each
// reloading the iframe. Null until the first mount arms it.
let pollTimer: number | null = null;

// The window resize handler, module-scoped so a repeat mountPreview can remove
// the prior one before adding its own (see the poll-timer note above).
let resizeHandler: (() => void) | null = null;

export function mountPreview(
  mount: HTMLElement,
  dataPreview: string,
  editor: Editor,
): void {
  // A second init() must not leave the previous poll running. Clear any existing
  // timer before arming the new one; the normal single-init path skips this.
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  // Same for the resize listener: a repeat mount would otherwise leave the prior
  // closure firing against the old iframe forever. Remove it before re-adding.
  if (resizeHandler !== null) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  const main = mount.parentElement;
  if (!main) {
    // #editor is `<main>`'s only child in the served shell, so this is
    // unreachable in production — the honest fallback strict null checks ask
    // for on `parentElement`, not a real path.
    return;
  }

  // The split container takes the mount's place; the mount (the live editor)
  // and a fresh iframe become its two panes. Moving an already-mounted
  // contenteditable via appendChild preserves the node and everything TipTap
  // built inside it — DOM identity is unchanged, only its parent.
  const split = document.createElement('div');
  split.id = 'gly-split';
  split.className = 'gly-split';

  const viewbar = buildViewbar();
  // Retained so paintView scopes its query to this control's own buttons.
  activeViewbar = viewbar;

  const panes = document.createElement('div');
  panes.className = 'gly-panes';

  const iframe = document.createElement('iframe');
  iframe.id = 'gly-preview';
  iframe.title = 'Live page preview';
  iframe.src = dataPreview;
  // NO sandbox: the served page runs its own CSS and JS, exactly as it would on
  // the real site, and a sandbox without allow-scripts/allow-same-origin would
  // strip both. The iframe is read-only by nature — a separate document — so
  // nothing here needs enforcing (see the design's Security note).

  // HTML on the LEFT, content editor on the RIGHT: the iframe is appended
  // first, the mount second, so the flex row reads [ page | content ] and the
  // toggle order (HTML · Both · Content) reads left-to-right with the panes.
  main.insertBefore(split, mount);
  panes.appendChild(iframe);
  panes.appendChild(mount);
  split.appendChild(viewbar);
  split.appendChild(panes);

  // One scroll for both panes: the iframe carries no internal scrollbar; it is
  // sized to its own content height so the window scrolls the page and the
  // editor together. Re-fit on every (re)load and whenever the page's own
  // layout settles or the viewport changes width.
  activeMount = mount;
  activeIframe = iframe;
  activeEditor = editor;
  iframe.addEventListener('load', () => onIframeLoad(iframe));
  resizeHandler = () => {
    fitIframe(iframe);
    scheduleAlign();
  };
  window.addEventListener('resize', resizeHandler);

  document.body.classList.add('gly-page');
  paintView(viewbar);

  // The saved-stamp poll on the editor's cadence. This is a second, lightweight
  // reader of /_galley/saved beside the App's tick(); the two do not
  // coordinate, and do not need to — each holds its own last-seen value.
  pollTimer = window.setInterval(() => {
    void pollSaved(iframe, dataPreview);
  }, PREVIEW_POLL_MS);
}

// buildViewbar makes the HTML · Both · Content segmented control. Each button
// carries its view on data-view, which paintView reads back to mark the pressed
// one — so the button and the body class are written from one source.
function buildViewbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'gly-viewbar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Preview layout');

  const labels: [View, string][] = [
    ['html', 'HTML'],
    ['both', 'Both'],
    ['content', 'Content'],
  ];
  for (const [view, label] of labels) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gly-view-btn';
    btn.dataset.view = view;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      currentView = view;
      paintView(bar);
    });
    bar.appendChild(btn);
  }
  return bar;
}

// The mounted viewbar, so a click handler (or the mount paint) can rescope
// paintView to this control alone. Set by mountPreview; the callers below pass
// their own reference where they have one.
let activeViewbar: HTMLElement | null = null;

// paintView is the single writer of the view state: the body class the CSS keys
// off, and the pressed button in the segmented control. Called on mount and on
// every click, so the two can never disagree. Scoped to the given viewbar (or
// the mounted one) so only this control's buttons are touched.
function paintView(viewbar?: HTMLElement): void {
  const body = document.body;
  body.classList.remove('gly-view-html', 'gly-view-both', 'gly-view-content');
  body.classList.add('gly-view-' + currentView);
  const bar = viewbar ?? activeViewbar;
  if (!bar) {
    return;
  }
  const btns = bar.querySelectorAll<HTMLButtonElement>('.gly-view-btn');
  btns.forEach((btn) => {
    const active = btn.dataset.view === currentView;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  // The alignment spacers only make sense in Both view; a view change re-runs
  // (Both) or clears them (HTML / Content).
  scheduleAlign();
}

// The editor and the two panes, module-scoped so the layout hooks (load,
// resize, view change, iframe growth) can reach all three without threading
// them through every call.
let activeMount: HTMLElement | null = null;
let activeIframe: HTMLIFrameElement | null = null;
let activeEditor: Editor | null = null;
let alignTimer: number | null = null;

function headingsOf(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
}

function pushPads(editor: Editor, pads: Map<string, number>): void {
  const view = editor.view;
  // A decoration change redraws the heading's DOM, which can drop an in-flight
  // IME composition. Skip while composing; the next debounce tick re-runs.
  if (view.composing) {
    return;
  }
  view.dispatch(view.state.tr.setMeta(headingAlignKey, pads));
}

// scheduleAlign coalesces the bursts of layout events into one realignment.
function scheduleAlign(): void {
  if (alignTimer !== null) {
    window.clearTimeout(alignTimer);
  }
  alignTimer = window.setTimeout(() => {
    alignTimer = null;
    alignHeadings();
  }, ALIGN_DEBOUNCE_MS);
}

// alignHeadings measures where each content heading sits versus the same
// heading in the live page, and pushes a per-heading padding map into the
// editor's decoration plugin so the content flows down to meet the page at the
// section level. Two frames: clear the current spacers, then measure the
// NATURAL positions next frame and push the new map, so a spacer is never
// measured on top of itself. Only ADDED space, top to bottom, cumulative and
// capped. Both view only; any other view clears the spacers.
function alignHeadings(): void {
  const editor = activeEditor;
  if (!editor) {
    return;
  }
  const inBoth = document.body.classList.contains('gly-view-both');
  const doc = activeIframe?.contentDocument ?? null;
  if (!inBoth || !doc || !activeMount) {
    pushPads(editor, new Map());
    return;
  }
  // Clear first, then measure the natural layout on the next frame.
  pushPads(editor, new Map());
  requestAnimationFrame(() => {
    const ed = activeEditor;
    const mount = activeMount;
    const iframe = activeIframe;
    const idoc = iframe?.contentDocument ?? null;
    if (
      !ed ||
      !mount ||
      !iframe ||
      !idoc ||
      !document.body.classList.contains('gly-view-both')
    ) {
      return;
    }
    const ifTop = iframe.getBoundingClientRect().top;
    const cHeads = headingsOf(mount);
    // The page's headings keyed by text-and-occurrence, so a repeated title
    // matches by order rather than always resolving to the first. A heading the
    // page hides (display:none: a print-only or collapsed-nav header) reports a
    // zero rect and no client rects; skip it so it neither steals an occurrence
    // slot from the real section heading below nor measures as top-of-page.
    const fByKey = new Map<string, number>();
    const fSeen = new Map<string, number>();
    for (const f of headingsOf(idoc)) {
      if (f.getClientRects().length === 0) {
        continue;
      }
      const key = normHeading(f.textContent);
      const occ = fSeen.get(key) ?? 0;
      fSeen.set(key, occ + 1);
      fByKey.set(
        alignKey(f.textContent, occ),
        ifTop + f.getBoundingClientRect().top,
      );
    }
    const pads = new Map<string, number>();
    const cSeen = new Map<string, number>();
    let cum = 0;
    for (const c of cHeads) {
      const text = normHeading(c.textContent);
      const occ = cSeen.get(text) ?? 0;
      cSeen.set(text, occ + 1);
      const k = alignKey(c.textContent, occ);
      const fy = fByKey.get(k);
      if (fy === undefined) {
        continue;
      }
      const cy = c.getBoundingClientRect().top;
      // Where this heading WILL be once the spacers above it apply, versus
      // where its page counterpart is. Only push down, never pull up.
      const need = Math.round(fy - cy - cum);
      const bump = Math.max(0, Math.min(need, MAX_ALIGN_BUMP_PX));
      if (bump > 1) {
        pads.set(k, bump);
        cum += bump;
      }
    }
    pushPads(ed, pads);
  });
}

// fitIframe sizes the iframe to its own rendered content height so it has no
// internal scroll — the whole point of the single-scroll layout. The preview
// route is same-origin (localhost), so contentDocument is readable; the catch
// is the strict-null fallback, not a real cross-origin path. The 2px cushion
// avoids a sub-pixel-rounding scrollbar.
function fitIframe(iframe: HTMLIFrameElement): void {
  try {
    const doc = iframe.contentDocument;
    const h = doc?.documentElement?.scrollHeight ?? 0;
    if (h > 0) {
      iframe.style.height = h + 2 + 'px';
    }
  } catch {
    // cross-origin would throw; same-origin preview never does.
  }
}

// A rendered page keeps growing after its load event — fonts swap, images
// decode — so beyond the immediate fit we watch the iframe body for height
// changes. One observer at a time: a reload builds a new document whose body
// the old observer no longer reaches, so disconnect before re-observing.
let bodyObserver: ResizeObserver | null = null;
function onIframeLoad(iframe: HTMLIFrameElement): void {
  fitIframe(iframe);
  scheduleAlign();
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  try {
    const body = iframe.contentDocument?.body;
    if (body && 'ResizeObserver' in window) {
      bodyObserver = new ResizeObserver(() => {
        fitIframe(iframe);
        scheduleAlign();
      });
      bodyObserver.observe(body);
    }
  } catch {
    // same-origin; unreachable.
  }
}

function pollSaved(
  iframe: HTMLIFrameElement,
  dataPreview: string,
): Promise<void> {
  return getJSON<SavedView>(routes.saved)
    .then((d) => {
      if (!d || !d.saved) {
        return;
      }
      if (!seeded) {
        seeded = true;
        lastSaved = d.saved;
        return;
      }
      if (d.saved > lastSaved) {
        lastSaved = d.saved;
        // The query is a cache-buster on the same document: the server has
        // already rewritten page.html for this projection (render runs on every
        // one), so this pulls the current render into the iframe.
        iframe.src = dataPreview + '?t=' + d.saved;
      }
    })
    .catch(() => {});
}
