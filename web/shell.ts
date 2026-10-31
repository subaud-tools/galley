// shell.ts — the page around the editor, from the family kit: the bar with its
// switcher and Approve, the left index of open reviews, the thread column, and
// the centre card the editor sits in. The front page takes the bar from here too.
//
// Both pages read one GET /api/pages, on the first draw and on each `pages`
// event, and a switch between them is a navigation.

import {
  bar,
  card,
  createApi,
  frame,
  h,
  indexRow,
  indexSection,
  keepElsewhere,
  live,
  sendBar,
  stageTrack,
  thread,
  type BarHandle,
} from '/_kit/kit.js';
import { docHref, pageIdOf, stateWords, switcherItems } from './pagelist.ts';
import type { GalleyChrome } from './roundbar.ts';
import type { PageView } from './wire.d.ts';

// The tool's name, for the bar and for what the frame remembers.
const NAME = 'galley';

// A goto waiting for network idle would never see one with the stream open, and
// the browser gates wait for it. Task 5 moves them; until then the stream opens
// once the page has settled. A tab checks in this much later for it.
const STREAM_AFTER_LOAD_MS = 1500;

function go(id: string): void {
  location.assign(id ? docHref(id) : '/');
}

/** A row for one review, in the index or on the front page. */
export function reviewRow(p: PageView, on: boolean): HTMLElement {
  return indexRow({
    id: p.id,
    title: p.name,
    meta: stateWords(p.state),
    on,
    attention: p.state === 'you' && !on,
    waits: p.state === 'agent',
    select: go,
  });
}

/** The bar, on the page for one review or ("" as page) the front page, kept
 * current from the server's events. draw hears each list. reload is what a new
 * server's build does to this page. */
export function connect(o: {
  page: string;
  status: string;
  draw(pages: PageView[]): void;
  reload(): void;
  refused(): void;
}): BarHandle {
  const b = bar({
    brand: {
      name: NAME,
      href: '/',
      mark: h('img', { src: '/favicon.svg', alt: '', width: 18, height: 18 }),
    },
    status: o.status,
    // galley's colours follow the system, so there is no theme to pick.
    theme: h('span'),
  });
  const api = createApi({
    onStale: () => o.refused(),
    onNewBuild: () => o.reload(),
  });
  const refresh = keepElsewhere(b, async () => {
    const pages = (await api.get<PageView[] | null>('/pages')) ?? [];
    o.draw(pages);
    return switcherItems(pages, o.page, go);
  });
  const stream = () =>
    live({
      events: '/api/events',
      poll: '/api/poll',
      page: o.page,
      onEvent: (e) => {
        if (e.type === 'pages') void refresh();
      },
      onShow: (page) => {
        if (page !== o.page) go(page);
      },
      onStatus: (s) => {
        // A gap may have hidden a change, so coming back reads the list again.
        if (s === 'live') void refresh();
        else b.setLive(s);
      },
      onNewBuild: () => b.setLive('stale', 'a newer galley is installed'),
    });
  void refresh();
  if (document.readyState === 'complete') {
    setTimeout(stream, STREAM_AFTER_LOAD_MS);
  } else {
    window.addEventListener(
      'load',
      () => setTimeout(stream, STREAM_AFTER_LOAD_MS),
      { once: true },
    );
  }
  return b;
}

/** The kit's send bar, built once with the ids the editor paints it by. Its Send
 * is relabelled Revise and takes its label and its state from the editor: the
 * kit's own would rebuild the buttons on every tick of the counter. */
function makeSendBar(): HTMLElement {
  const el = sendBar({
    count: '',
    sends: 1,
    hint: 'Revise sends your instructions and edits together. The agent answers by revising the document.',
    // verdict.ts listens on the buttons themselves.
    discard: () => {},
    send: () => {},
  });
  const [discard, send] = el.querySelectorAll('.kit-btn');
  discard.id = 'gly-discard';
  send.id = 'gly-revise';
  el.querySelector('.kit-sendbar-count')!.id = 'gly-drafts';
  return el;
}

/** Builds the page around the editor's <main>: the rounds, the centre card and
 * the send bar. Approve asks the editor's own verdict, so a press can't seal over
 * unsent work: with drafts it offers Revise & Approve. */
export function mountShell(verdict: () => void): void {
  const app = document.getElementById('app');
  const main = document.querySelector('main');
  if (!app || !main) {
    return;
  }
  const id = pageIdOf(location.pathname);
  const name = document.getElementById('editor')?.dataset.doc ?? '';
  const cols = frame({
    name: NAME,
    left: { panel: 'index', label: 'Reviews' },
    centre: { label: 'Document' },
    right: { panel: 'thread', label: 'Thread' },
  });
  const crumb = h('span', { class: 'kit-card-crumb' }, name);
  const stages = h('div', { class: 'gly-stages' });
  const b: BarHandle = connect({
    page: id,
    status: name,
    reload: () => {},
    // The token outlives a restart, so this is a page signed out: the editor
    // says so itself the first time it can't reach the server.
    refused: () => {},
    draw(pages: PageView[]) {
      cols.leftBody?.replaceChildren(
        indexSection({
          name: 'Reviews',
          rows: pages.map((p) => reviewRow(p, p.id === id)),
          empty: 'No reviews open.',
        }),
      );
      // A page's file under review is its content.md: the list's name is the
      // one it was opened by.
      const here = pages.find((p) => p.id === id);
      if (here) {
        crumb.textContent = here.name;
      }
    },
  });
  const editorCard = card({ head: name, body: h('div') });
  editorCard.querySelector('.kit-card-head')?.replaceChildren(crumb);
  editorCard.classList.add('gly-editor-card');
  editorCard.querySelector('.kit-card-body')?.replaceChildren(main);
  cols.centre.append(stages, editorCard, makeSendBar());
  cols.rightBody?.append(
    thread({ empty: 'Select an instruction to see its thread.' }),
  );
  cols.setRightEmpty(true, `${id}/`);
  app.append(b.el, cols.left!, cols.centre, cols.right!);
  // The editor's one readout is the bar's status.
  const status = b.el.querySelector('.kit-status');
  if (status) {
    status.id = 'gly-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
  }
  let drawn = '';
  const chrome: GalleyChrome = {
    paintPrimary(label) {
      b.setPrimary(label ? { label, run: verdict } : null);
    },
    paintStages(values, open, door) {
      const key = JSON.stringify(values);
      if (key === drawn) {
        return;
      }
      drawn = key;
      stages.replaceChildren(
        stageTrack({ stages: values, open, label: 'Rounds', after: [door] }),
      );
    },
  };
  window.galleyChrome = chrome;
}
