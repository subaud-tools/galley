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
  filterRow,
  frame,
  groupList,
  h,
  indexRow,
  keepElsewhere,
  live,
  narrowMode,
  railTabs,
  remembered,
  sendBar,
  shareMenu,
  stageTrack,
  submitOnEnter,
  thread,
  threadMessage,
  type BarHandle,
  type Frame,
  type ShareMenu,
  type ThreadMessageValue,
} from '/_kit/kit.js';
import {
  docHref,
  findReviews,
  folderItems,
  pageFilters,
  pageIdOf,
  rowFace,
  stateGroups,
  switcherItems,
} from './pagelist.ts';
import { TOP_REVISE, type GalleyChrome, type TabActions } from './roundbar.ts';
import { tip, tipBox, tipText } from './tip.ts';
import {
  afterFiled,
  strandedValue,
  type DraftRowValue,
  type EditRowValue,
} from './tabs.ts';
import type { PageView, ReviewOpenView } from './wire.d.ts';

// The tool's name, for the bar and for what the frame remembers.
const NAME = 'galley';

// A goto waiting for network idle would never see one with the stream open, and
// the browser gates wait for it, so the stream opens once the page has settled.
// The tab has checked in by then, and the stream takes up from that check-in.
const STREAM_AFTER_LOAD_MS = 1500;

function go(id: string): void {
  location.assign(id ? docHref(id) : '/');
}

/** Opens a kept approved review whose document isn't open, and goes to it. */
async function openKept(key: string): Promise<void> {
  const opened = await createApi().post<ReviewOpenView>('/reviews/open', {
    key,
  });
  go(opened.id);
}

/** A row for one review, in the index or on the front page. underHeading: it
 * sits under a heading that says where it stands (the index), so it doesn't
 * say it again. extra: nodes after its button, the index's ⋯. */
export function reviewRow(
  p: PageView,
  on: boolean,
  underHeading: boolean,
  extra?: Node[],
): HTMLElement {
  return indexRow({
    id: p.id,
    title: p.name,
    ...rowFace(p, on, underHeading, new Date()),
    on,
    extra,
    select: p.open ? go : () => void openKept(p.key),
  });
}

const REMOVE = 'Remove from list';
const REMOVE_OPEN =
  'Remove from list? This ends the review and tells the agent.';

/** Remove from list: the entry forgotten, and an open review ended first (its
 * agent is told). The file and its versions stay. here is the review this page
 * shows, which goes to the front page once it is removed. */
async function removeFromList(p: PageView, here: string): Promise<void> {
  await createApi().post('/reviews/remove', { key: p.key });
  if (p.id === here) {
    go('');
  }
}

/** Where a section's fold is kept. */
const foldKey = (key: string) => `galley.index.folded.${key}`;

/** The sections folded now: Approved until the reader unfolds it. */
function foldedSections(): string[] {
  return stateGroups([])
    .map((g) => g.key)
    .filter(
      (key) =>
        (remembered.get(foldKey(key)) ?? (key === 'approved' ? '1' : '0')) ===
        '1',
    );
}

/** The left panel's body: the search box, the folder filter and the reviews in
 * their sections, each row with its ⋯. Returns the draw for each list. picked
 * hears a review chosen from it. */
function makeIndex(
  body: HTMLElement,
  here: string,
  picked: () => void,
): (pages: PageView[]) => void {
  let held: PageView[] = [];
  let words = '';
  const folders: string[] = [];
  let menus: ShareMenu[] = [];
  const search = h('input', {
    class: 'kit-search gly-find',
    type: 'search',
    placeholder: 'Find a review',
    'aria-label': 'Find a review',
  }) as HTMLInputElement;
  search.addEventListener('input', () => {
    words = search.value;
    draw(held);
  });
  const list = h('div', { class: 'gly-index' });
  list.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.kit-index-main')) {
      picked();
    }
  });
  body.replaceChildren(search, list);
  const more = (p: PageView): HTMLElement => {
    const b = h(
      'button',
      { class: 'kit-ctl gly-row-more', type: 'button', 'aria-label': 'More' },
      '⋯',
    );
    // A review still under way asks first, in the menu itself: the second
    // press is the confirmation, as a delete's arming is elsewhere on the page.
    let first: ShareMenu | undefined;
    const ask = (): void => {
      first?.destroy();
      const m = shareMenu(
        b,
        [
          { label: REMOVE_OPEN, heading: true },
          { label: REMOVE, act: 'remove' },
        ],
        () => void removeFromList(p, here),
      );
      menus.push(m);
      m.open();
    };
    b.addEventListener(
      'click',
      () => {
        first = shareMenu(b, [{ label: REMOVE, act: 'remove' }], () => {
          if (p.state === 'approved') void removeFromList(p, here);
          else setTimeout(ask);
        });
        menus.push(first);
        first.open();
      },
      { once: true },
    );
    return b;
  };
  function draw(pages: PageView[]): void {
    held = pages;
    for (const m of menus) {
      m.destroy();
    }
    menus = [];
    const shown = pageFilters(findReviews(pages, words), [], folders);
    list.replaceChildren(
      filterRow({
        label: 'Folder',
        items: folderItems(pages),
        chosen: folders,
        onToggle: (v) => {
          const at = folders.indexOf(v);
          if (!v) folders.length = 0;
          else if (at >= 0) folders.splice(at, 1);
          else folders.push(v);
          draw(held);
        },
      }),
      groupList({
        groups: stateGroups(shown).map((g) => ({
          key: g.key,
          title: g.title,
          rows: g.pages.map((p) =>
            reviewRow(p, p.id === here, true, [more(p)]),
          ),
          empty: 'Nothing here.',
          edge: g.key === 'you' && g.pages.length ? 'signal' : undefined,
        })),
        folded: foldedSections(),
        onFold: (key, on) => remembered.set(foldKey(key), on ? '1' : '0'),
      }),
    );
  }
  return draw;
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
  // One short poll says at once that this tab is open, so a review opened in the
  // moments after a load finds it, with no connection held open.
  const tab = crypto.randomUUID();
  const checkedIn = api
    .get<{ cursor?: string }>(
      `/poll?tab=${encodeURIComponent(tab)}&page=${encodeURIComponent(o.page)}`,
    )
    .then((r) => r?.cursor)
    .catch(() => undefined);
  const stream = async () =>
    live({
      events: '/api/events',
      poll: '/api/poll',
      page: o.page,
      randomUUID: () => tab,
      cursor: await checkedIn,
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

/** The kit's send bar, built once with the ids the editor paints it by: the
 * draft count and Discard drafts. Its Send is relabelled Revise and goes to the
 * top bar, with its ▾, as the top-right button while the round has something to
 * send (`top`); the editor paints its label and state, since the kit's own would
 * rebuild the buttons on every tick of the counter. The bar holds the round and
 * nothing else, so the kit's hint goes: the sentence is Revise's tip. */
function makeSendBar(): { el: HTMLElement; top: HTMLElement } {
  const el = sendBar({
    count: '',
    sends: 1,
    hint: '',
    // verdict.ts listens on the buttons themselves.
    discard: () => {},
    send: () => {},
  });
  const [discard, send] = el.querySelectorAll('.kit-btn');
  discard.id = 'gly-discard';
  send.id = 'gly-revise';
  // Revise's ▾, one control with it: Revise & approve, shown while work is
  // pending. verdict.ts paints it and opens its menu.
  const top = h(
    'span',
    { class: 'gly-top-revise', id: 'gly-top-revise', hidden: true },
    send,
    h(
      'button',
      {
        class: 'kit-btn fill gly-revise-more',
        id: 'gly-revise-more',
        type: 'button',
        'aria-label': 'More ways to send',
        hidden: true,
      },
      '▾',
    ),
  );
  el.querySelector('.kit-sendbar-count')!.id = 'gly-drafts';
  el.querySelector('.kit-sendbar-hint')?.remove();
  return { el, top };
}

// Below this the index starts folded.
const INDEX_FITS_WIDTH = 1240;

const TAB_INSTRUCTIONS = 'instructions';
const TAB_INSTRUCTIONS_DOC = 'instructions-doc';
const TAB_CHAT = 'chat';
const DOC_HINT = 'Add an instruction on the whole document…';
const CHAT_HINT = 'Message the agent…';
const CHAT_SAYS =
  "The agent reads it now and answers here. It doesn't change the document; instructions and Revise do.";
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

/** The agent's chat reply, as the server rendered it from its markdown. */
function renderedReply(m: ThreadMessageValue & { html?: string }): Node {
  const body = h('div');
  body.innerHTML = m.html ?? '';
  return body;
}

/** The right column: the kit's two tabs, each built once so a box keeps its words,
 * and what the editor paints them through. Instructions holds every instruction
 * the next Revise sends: on the whole document (a box and its rows), then on the
 * text. Chat is a conversation with the agent, with the rounds in it. */
function makeTabs(
  cols: Frame,
): Pick<
  GalleyChrome,
  | 'wireTabs'
  | 'paintDrafts'
  | 'paintChat'
  | 'showRow'
  | 'openDocInstruction'
  | 'keepInChat'
  | 'chatHolds'
  | 'fileWords'
  | 'settled'
> {
  let act: TabActions | null = null;
  // What each row last showed from the server and what the server last took from
  // its box: a box holding anything else, when its row leaves, holds words nobody has.
  const painted = new Map<string, string>();
  const saved = new Map<string, string>();
  // Words a row has asked to save and the server hasn't taken, which a failure
  // leaves here: until it does, a redraw shows them and not the server's. And the
  // request on its way for each, so a row's saves go in order.
  const held = new Map<string, string>();
  const saving = new Map<string, Promise<boolean>>();
  const save = (key: string, text: string): Promise<boolean> => {
    held.set(key, text);
    const before = saving.get(key) ?? Promise.resolve(true);
    const run: Promise<boolean> = before
      .then(() => act?.edit(key, text) ?? false)
      .then((ok) => {
        if (ok && held.get(key) === text) {
          saved.set(key, text);
          held.delete(key);
        }
        if (saving.get(key) === run) {
          saving.delete(key);
        }
        return ok;
      });
    saving.set(key, run);
    return run;
  };
  const showing = (rows: DraftRowValue[]) =>
    rows.map((r) => {
      const words = held.get(r.id);
      return words === undefined ? r : { ...r, text: words };
    });
  const callbacks = {
    onEdit: (key: string, text: string) => {
      void save(key, text);
    },
    onDelete: (key: string) => {
      painted.delete(key);
      held.delete(key);
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
      if (!staying.has(id)) {
        held.delete(id);
      }
    }
  };
  const textList = draftList({
    drafts: [],
    empty: 'No instructions yet.',
    ...callbacks,
  });
  textList.el.classList.add('gly-text-drafts');
  const docList = draftList({ drafts: [], empty: '', ...callbacks });
  docList.el.classList.add('gly-doc-drafts');
  const edits = h('ul', { class: 'kit-draft-rows gly-edit-rows' });

  const words = createDrafts();
  const box = words.box(TAB_INSTRUCTIONS_DOC, DOC_HINT, 3);
  box.box.id = 'gly-doc-box';
  // The words stay in the box until the server has them: a failure has nothing
  // to put back, and what's typed meanwhile stays with them. A press while one
  // is on its way waits for it, then files whatever that left.
  let filing: Promise<boolean> | null = null;
  const fileWords = (): Promise<boolean> => {
    if (filing) {
      return filing.then((ok) => ok && fileWords());
    }
    const text = words.get(TAB_INSTRUCTIONS_DOC).trim();
    if (!text || !act) {
      return Promise.resolve(true);
    }
    filing = act.file(text).then((ok) => {
      filing = null;
      if (ok) {
        words.restore(
          TAB_INSTRUCTIONS_DOC,
          afterFiled(words.get(TAB_INSTRUCTIONS_DOC), text),
        );
      }
      return ok;
    });
    return filing;
  };
  const send = () => {
    void fileWords();
  };
  submitOnEnter(box.box, send);
  window.addEventListener('beforeunload', (e) => {
    if (words.dirty() || held.size > 0) {
      e.preventDefault();
    }
  });
  const instructions = h(
    'div',
    { class: 'gly-tab' },
    h('div', { class: 'kit-label' }, 'On the whole document'),
    h(
      'div',
      { class: 'kit-note-line gly-doc-line' },
      box.el,
      buttons([{ label: 'Add instruction', run: send }]),
    ),
    docList.el,
    h('div', { class: 'kit-label' }, 'This round · on the text'),
    textList.el,
    edits,
    h(
      'p',
      { class: 'kit-meta gly-tab-hint' },
      'Select words in the document to add one.',
    ),
  );

  // Chat's box: Enter or Send posts the words, which stay until the server has
  // them, and what was typed meanwhile stays after them.
  const chatBox = words.box(TAB_CHAT, CHAT_HINT, 3);
  chatBox.box.id = 'gly-chat-box';
  let sending: Promise<boolean> | null = null;
  const sendChat = (): void => {
    const text = words.get(TAB_CHAT).trim();
    if (sending || !text || !act) {
      return;
    }
    sending = act.chat(text).then((ok) => {
      sending = null;
      if (ok) {
        words.restore(TAB_CHAT, afterFiled(words.get(TAB_CHAT), text));
      }
      return ok;
    });
  };
  const chat = thread<ThreadMessageValue>({
    id: TAB_CHAT,
    name: 'Chat',
    note: { el: chatBox.el, box: chatBox.box, send: sendChat, label: 'Send' },
  });
  chat.querySelector('.kit-note-line')?.classList.add('gly-chat-note');
  chat.append(h('p', { class: 'kit-meta gly-chat-hint' }, CHAT_SAYS));
  // The kit draws the thread whole, so the messages are kept in a list of their
  // own in its empty line's place, redrawn as they change: the box keeps its words.
  const said = h('ul', { class: 'kit-thread-msgs' });
  const none = chat.querySelector('.kit-empty')!;
  const told = h('div', { class: 'gly-chat-said' }, none.cloneNode(true), said);
  none.replaceWith(told);

  const tabs = railTabs({
    name: NAME,
    tabs: [
      { id: TAB_INSTRUCTIONS, label: 'Instructions', body: instructions },
      { id: TAB_CHAT, label: 'Chat', body: chat },
    ],
  });
  cols.rightBody?.append(tabs.el);
  // The thread column stays where the reader left it: showing a tab switches
  // the tab and never unfolds a column they folded.
  const show = (id: string) => tabs.setOpen(id);

  let drawnEdits = '';
  let drawnSaid = '';
  return {
    wireTabs(actions) {
      act = actions;
    },
    paintDrafts(v) {
      keepLeaving(textList.el, v.text);
      keepLeaving(docList.el, v.chat);
      textList.redraw({ drafts: showing(v.text), selected: v.selected });
      docList.redraw({ drafts: showing(v.chat), selected: v.selected });
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
    },
    paintChat(messages, waiting) {
      tabs.setCount(TAB_CHAT, waiting);
      const key = JSON.stringify(messages);
      if (key !== drawnSaid) {
        drawnSaid = key;
        // The reviewer's words stay plain, as diazo's threads draw them; only
        // the agent's reply is rendered.
        said.replaceChildren(
          ...messages.map((m) =>
            threadMessage(m, undefined, m.html ? renderedReply : undefined),
          ),
        );
        told.classList.toggle('gly-chat-told', messages.length > 0);
      }
    },
    showRow(key) {
      show(TAB_INSTRUCTIONS);
      const row = [
        ...instructions.querySelectorAll<HTMLElement>('[data-draft-id]'),
      ].find((r) => r.dataset.draftId === key);
      row?.scrollIntoView({ block: 'nearest' });
    },
    openDocInstruction() {
      show(TAB_INSTRUCTIONS);
      box.box.focus();
    },
    keepInChat(kept) {
      const next = strandedValue(words.get(TAB_INSTRUCTIONS_DOC), kept);
      if (next !== null) {
        words.restore(TAB_INSTRUCTIONS_DOC, next);
      }
      show(TAB_INSTRUCTIONS);
    },
    chatHolds: () => words.dirty(),
    fileWords,
    async settled() {
      // A box still in hand saves on its blur.
      const inHand = document.activeElement;
      if (
        inHand instanceof HTMLElement &&
        inHand.classList.contains('kit-draft-words')
      ) {
        inHand.blur();
      }
      const filed = await (filing ?? Promise.resolve(true));
      await Promise.all(saving.values());
      // What's still held failed, and this is the press that needs it.
      const retried = await Promise.all(
        [...held].map(([key, text]) => save(key, text)),
      );
      return filed && retried.every(Boolean);
    },
  };
}

/** Builds the page around the editor's <main>: the rounds, the centre card and
 * the send bar. The top button asks the editor's own verdict: Approve on a clean
 * document, the way back in History. */
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
  // The preview: beside History, kept across each redraw of the track.
  // share.ts puts it in.
  const docTools = h('span', { class: 'gly-doc-tools', id: 'gly-doc-tools' });
  const stages = h('div', { class: 'gly-stages' }, docTools);
  // At 1080 wide or less one thing at a time: the document, or a panel in its
  // place with the other a strip. A review picked from the index goes back to it.
  const narrow = narrowMode({ root: app, left: cols.left, right: cols.right });
  window.addEventListener('pagehide', () => narrow.stop(), { once: true });
  const drawIndex = cols.leftBody
    ? makeIndex(cols.leftBody, id, () => narrow.show(null))
    : () => {};
  const b: BarHandle = connect({
    page: id,
    status: name,
    reload: () => {},
    // The token outlives a restart, so this is a page signed out: the editor
    // says so itself the first time it can't reach the server.
    refused: () => {},
    draw(pages: PageView[]) {
      drawIndex(pages);
      narrow.setCount('left', pages.filter((p) => p.state === 'you').length);
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
  const send = makeSendBar();
  cols.centre.append(stages, editorCard, send.el);
  // Revise takes the kit primary's place, in the same box (editor.css).
  const primary = b.el.querySelector('.kit-primary');
  primary?.before(send.top);
  const tabs = makeTabs(cols);
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
      const revise = label === TOP_REVISE;
      b.setPrimary(label && !revise ? { label, run: verdict } : null);
      send.top.hidden = !revise;
      b.el.classList.toggle('gly-revise-on-top', revise);
    },
    paintStages(values, open, door) {
      const key = JSON.stringify(values);
      if (key === drawn) {
        return;
      }
      drawn = key;
      stages.replaceChildren(
        stageTrack({
          stages: values,
          open,
          label: 'Rounds',
          // History's door sits in its tip box (web/tip.ts).
          after: [door && tipBox(door), docTools],
        }),
      );
      // A door placed for the first time gets the tip it was given.
      if (door) {
        tip(door, tipText(door));
      }
    },
  };
  window.galleyChrome = chrome;
}
