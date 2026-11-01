// shell.ts — the page around the editor, from the family kit: the bar with its
// switcher and Approve, the left index of open reviews, the right column's tabs,
// and the centre card the editor sits in. The front page takes the bar from here too.
//
// Both pages read one GET /api/pages, on the first draw and on each `pages`
// event, and a switch between them is a navigation.

import {
  bar,
  buttons,
  card,
  createApi,
  createDrafts,
  draftList,
  frame,
  h,
  indexRow,
  indexSection,
  keepElsewhere,
  live,
  railTabs,
  sendBar,
  stageTrack,
  thread,
  threadMessage,
  type BarHandle,
  type Frame,
  type ThreadMessageValue,
} from '/_kit/kit.js';
import { docHref, pageIdOf, stateWords, switcherItems } from './pagelist.ts';
import type { GalleyChrome, TabActions } from './roundbar.ts';
import { strandedValue, type EditRowValue } from './tabs.ts';
import type { PageView } from './wire.d.ts';

// The tool's name, for the bar and for what the frame remembers.
const NAME = 'galley';

// A goto waiting for network idle would never see one with the stream open, and
// the browser gates wait for it, so the stream opens once the page has settled.
// A tab checks in this much later for it.
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

// Below this the index starts folded.
const INDEX_FITS_WIDTH = 1240;

const TAB_INSTRUCTIONS = 'instructions';
const TAB_CHAT = 'chat';
const CHAT_HINT = 'Ask about the whole document, sent with the next Revise';
const REVERT_NOTE =
  'this puts the words back and drops your undo history — press again';

/** A hand edit's row: the words it took out, the words it put in, and Revert. */
function editRow(e: EditRowValue, revert: (key: string) => void): HTMLElement {
  return h(
    'li',
    { class: 'kit-draft-row gly-edit-row', 'data-edit-key': e.key },
    h('span', { class: 'kit-label' }, e.head),
    h(
      'p',
      { class: 'gly-edit-words' },
      e.before ? h('del', null, e.before) : null,
      e.before && e.after ? ' ' : null,
      e.after ? h('ins', null, e.after) : null,
    ),
    e.armed ? h('span', { class: 'kit-meta' }, REVERT_NOTE) : null,
    e.key
      ? buttons([
          {
            label: e.armed ? 'Revert?' : 'Revert',
            danger: e.armed,
            run: () => revert(e.key),
          },
        ])
      : null,
  );
}

/** The right column: the kit's two tabs, each built once so a box keeps its words,
 * and what the editor paints them through. */
function makeTabs(
  cols: Frame,
  doc: string,
): Pick<
  GalleyChrome,
  | 'wireTabs'
  | 'paintDrafts'
  | 'paintChat'
  | 'showRow'
  | 'openChat'
  | 'keepInChat'
  | 'showComposer'
  | 'composerGone'
> {
  let act: TabActions | null = null;
  // What each row last showed from the server and what its box last saved: a box
  // holding anything else, when its row leaves, holds words nobody has.
  const painted = new Map<string, string>();
  const saved = new Map<string, string>();
  const callbacks = {
    onEdit: (key: string, text: string) => {
      saved.set(key, text);
      act?.edit(key, text);
    },
    onDelete: (key: string) => {
      painted.delete(key);
      act?.remove(key);
    },
    onSelect: (key: string) => act?.select(key),
  };
  // The kit lets a leaving row's words go. A row Delete took meant to; any other
  // was sent or deleted from elsewhere while the reader was typing in it.
  const keepLeaving = (list: HTMLElement, rows: { id: string }[]) => {
    const staying = new Set(rows.map((r) => r.id));
    for (const row of list.querySelectorAll<HTMLElement>('[data-draft-id]')) {
      const id = row.dataset.draftId ?? '';
      const words = row.querySelector('textarea')?.value ?? '';
      if (
        !staying.has(id) &&
        painted.has(id) &&
        words.trim() &&
        words !== painted.get(id) &&
        words !== saved.get(id)
      ) {
        act?.stranded(words);
      }
    }
  };
  const textList = draftList({
    drafts: [],
    empty: 'No instructions yet.',
    ...callbacks,
  });
  const chatList = draftList({ drafts: [], empty: '', ...callbacks });
  const edits = h('ul', { class: 'kit-draft-rows gly-edit-rows' });
  const instructions = h(
    'div',
    { class: 'gly-tab' },
    h('div', { id: 'gly-composer-slot' }),
    h('div', { class: 'kit-label' }, 'This round · on the text'),
    textList.el,
    edits,
    h(
      'p',
      { class: 'kit-meta gly-tab-hint' },
      'Select words in the document to add one.',
    ),
  );

  const words = createDrafts();
  const box = words.box(TAB_CHAT, CHAT_HINT, 3);
  box.box.id = 'gly-chat-box';
  box.box.setAttribute('aria-label', CHAT_HINT);
  const send = () => {
    const text = words.take(TAB_CHAT).trim();
    if (text && act) {
      void act.file(text).then((ok) => {
        if (!ok) {
          words.restore(TAB_CHAT, text);
        }
      });
    }
  };
  const chat = thread<ThreadMessageValue>({
    id: TAB_CHAT,
    name: 'Chat about the whole document',
    note: { el: box.el, box: box.box, send },
  });
  // The kit draws the thread whole, and drawing it again would take the box out
  // of the page, so its messages are kept in a list of their own in its place.
  const said = h('ul', { class: 'kit-thread-msgs' });
  const none = chat.querySelector('.kit-empty')!;
  const told = h(
    'div',
    { class: 'gly-chat-said' },
    none.cloneNode(true),
    said,
    h('div', { class: 'gly-chat-drafts' }, chatList.el),
  );
  none.replaceWith(told);

  const tabs = railTabs({
    name: NAME,
    tabs: [
      { id: TAB_INSTRUCTIONS, label: 'Instructions', body: instructions },
      { id: TAB_CHAT, label: 'Chat', body: chat },
    ],
    onOpen: (id) => {
      inFront = id;
      gaveWay = '';
    },
  });
  // Which tab is showing, and the one the composer took the place of. The kit
  // remembers a press but doesn't say what it has open.
  let inFront = tabs.el
    .querySelector('.kit-ctl.on')
    ?.textContent?.startsWith('Chat')
    ? TAB_CHAT
    : TAB_INSTRUCTIONS;
  let gaveWay = '';
  cols.rightBody?.append(tabs.el);
  const show = (id: string) => {
    inFront = id;
    tabs.setOpen(id);
  };
  // A fold is held on a card until the card changes, and each ask is a new one:
  // something the reader has to see opens the column even if they had folded it.
  let asks = 0;
  const unfold = () => {
    asks += 1;
    cols.setRightEmpty(false, `${doc}/${asks}`);
  };
  cols.setRightEmpty(false, doc);

  let drawnEdits = '';
  let drawnSaid = '';
  return {
    wireTabs(actions) {
      act = actions;
    },
    paintDrafts(v) {
      keepLeaving(textList.el, v.text);
      keepLeaving(chatList.el, v.chat);
      textList.redraw({ drafts: v.text, selected: v.selected });
      chatList.redraw({ drafts: v.chat, selected: v.selected });
      for (const d of [...v.text, ...v.chat]) {
        painted.set(d.id, d.text);
      }
      tabs.setCount(TAB_INSTRUCTIONS, v.counts.instructions);
      tabs.setCount(TAB_CHAT, v.counts.chat);
      const key = JSON.stringify(v.edits);
      if (key !== drawnEdits) {
        drawnEdits = key;
        edits.replaceChildren(
          ...v.edits.map((e) => editRow(e, (k) => act?.revert(k))),
        );
      }
      told.classList.toggle('gly-chat-holds', v.chat.length > 0);
    },
    paintChat(messages) {
      const key = JSON.stringify(messages);
      if (key !== drawnSaid) {
        drawnSaid = key;
        said.replaceChildren(...messages.map((m) => threadMessage(m)));
        told.classList.toggle('gly-chat-told', messages.length > 0);
      }
    },
    showRow(key) {
      show(TAB_INSTRUCTIONS);
      gaveWay = '';
      unfold();
      const row = [
        ...textList.el.querySelectorAll<HTMLElement>('[data-draft-id]'),
      ].find((r) => r.dataset.draftId === key);
      row?.scrollIntoView({ block: 'nearest' });
    },
    openChat() {
      show(TAB_CHAT);
      gaveWay = '';
      unfold();
      box.box.focus();
    },
    keepInChat(kept) {
      const next = strandedValue(words.get(TAB_CHAT), kept);
      if (next !== null) {
        words.restore(TAB_CHAT, next);
      }
      show(TAB_CHAT);
      unfold();
    },
    showComposer() {
      if (inFront !== TAB_INSTRUCTIONS) {
        gaveWay = inFront;
        show(TAB_INSTRUCTIONS);
      }
      unfold();
    },
    composerGone() {
      if (gaveWay) {
        show(gaveWay);
        gaveWay = '';
      }
    },
  };
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
    // With both columns open a narrow window leaves the prose a few words a line,
    // and the switcher on the bar lists the same reviews.
    left: {
      panel: 'index',
      label: 'Reviews',
      folded: window.innerWidth < INDEX_FITS_WIDTH,
    },
    centre: { label: 'Document' },
    right: { panel: 'thread', label: 'Instructions and chat' },
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
  const tabs = makeTabs(cols, id);
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
    ...tabs,
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
