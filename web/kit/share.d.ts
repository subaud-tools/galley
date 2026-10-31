// ---- share.js (styled by share.css; kit.css imports it, a page without kit.css links it and sets --share-*)

export const SHARE_LABEL: 'Share ▾';
export const SHARE_DOWNLOAD_HTML: 'Download HTML';
export const SHARE_DOWNLOAD_MD: 'Download Markdown';
export const SHARE_SHARE_HTML: 'Share HTML';
export const SHARE_SHARE_MD: 'Share Markdown';
export const SHARE_COPY_LINK: 'Copy link';
export const SHARE_PRINT: 'Print or save as PDF';
/** How long a Share's copied line stays on the status line, in ms. */
export const SHARE_REPLY_MS: number;

/** The status line after a Share put the file at path on the clipboard: "<base name> copied · paste to attach". */
export function sharedLine(path: string): string;

/** One menu row; act is the tool's own name for what it does. */
export interface ShareRow<A extends string = string> {
  label: string;
  act: A;
}

/** A label over the rows after it: not a menuitem, not pressable, not in the tab order. */
export interface ShareHeading {
  label: string;
  heading: true;
}

export type ShareItem<A extends string = string> = ShareRow<A> | ShareHeading;

export interface ShareMenu {
  el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Removes the menu and its listeners, the button's toggle included. */
  destroy(): void;
}

/** Builds button's menu from items, hidden, and makes the button toggle it, right-aligned under it. A pick closes it and calls onPick; an outside click, Escape and a resize close it. */
export function shareMenu<A extends string>(button: HTMLElement, items: ShareItem<A>[], onPick: (act: A, item: ShareRow<A>) => void): ShareMenu;

// ---- tip.js

/** Makes trigger open tip (a .kit-tip) inside box (a .kit-tip-at): on hover, keyboard focus, Enter or a tap; Esc, leaving by keyboard or a tap elsewhere closes it. when says whether there is anything to show; a press with nothing to show goes to what is under it. */
export function wireTip(box: HTMLElement, trigger: HTMLElement, tip: HTMLElement, when?: () => boolean): void;
/** A tip of one plain line. */
export function lineTip(text: string): HTMLElement;

// ---- frame.js

export interface CollapsibleOptions {
  col: HTMLElement;
  body: HTMLElement;
  /** Names the panel to the reader ("Show the index") and in the key. */
  panel: string;
  side: 'left' | 'right';
  /** The tool's name: the fold is remembered in localStorage["<name>.collapsed.<panel>"]. */
  name: string;
  /** Start folded whatever the page remembers, and leave what it remembers alone. */
  folded?: boolean;
  /** Hears each press of the toggle. */
  onPress?(): void;
}

/** Puts a toggle and body in col: the side folds to a thin strip and the page remembers it. Returns a function that folds or opens the side without remembering it. */
export function collapsible(o: CollapsibleOptions): (folded: boolean) => void;

export interface FrameSide {
  panel: string;
  /** The column's aria-label. */
  label: string;
  folded?: boolean;
}

export interface FrameOptions {
  /** The tool's name; see CollapsibleOptions.name. */
  name: string;
  left?: FrameSide;
  centre: { label: string };
  right?: FrameSide;
}

export interface Frame {
  left: HTMLElement | null;
  /** Where the caller draws the index. */
  leftBody: HTMLElement | null;
  /** The centre column, which the caller draws into. */
  centre: HTMLElement;
  right: HTMLElement | null;
  /** Where the caller draws the thread. */
  rightBody: HTMLElement | null;
  /** Says whether the thread of card has no messages: an empty one folds to its strip and its first message opens it. card is an id unique across the tool, e.g. `${folder}/${card}`. A press on the toggle wins until the card changes, over a reload too. */
  setRightEmpty(empty: boolean, card?: string): void;
}

/** The three columns of a .kit-app grid; the caller appends left, centre and right after its bar. */
export function frame(o: FrameOptions): Frame;

// ---- index.js

/** A row's needs-you dot, which says so in a tip. */
export function attentionDot(): HTMLElement;

export interface IndexRowOptions {
  /** What the row opens: its data-card, and what select gets. */
  id: string;
  title: string;
  meta?: string;
  /** The row in front of the reader. */
  on?: boolean;
  /** It needs the reader: a dot, and its meta in the signal colour. */
  attention?: boolean;
  /** Its meta in the wait colour. */
  waits?: boolean;
  /** It holds a draft: a wait-coloured edge and meta. */
  draft?: boolean;
  /** Nodes after the row's button, before the dot. */
  extra?: Node[];
  select?(id: string): void;
}

/** One row of the left index; add a class of your own for anything further. */
export function indexRow(o: IndexRowOptions): HTMLElement;

export interface IndexSectionOptions {
  name: string;
  rows: HTMLElement[];
  /** The words when there are no rows. */
  empty: string;
  /** Turns the name into a link: "<name> ›". */
  open?: () => void;
}

/** A named group of rows. */
export function indexSection(o: IndexSectionOptions): HTMLElement;

// ---- thread.js

/** One message, as plain values; the caller may carry more on it for attachments. */
export interface ThreadMessageValue {
  id: number | string;
  from: 'court' | 'agent';
  /** RFC 3339; anything else shows as it came. */
  at: string;
  /** What the caller says about it, in the head: "your note". */
  words?: string;
  /** A link after the words, opening through the caller. */
  link?: { text: string; href: string; open(): void } | null;
  /** Where one of Court's stands: a msgstate state, drawn with messagePill. */
  state?: string;
  /** The line under the state's pill. */
  stateLine?: string;
  text?: string;
}

/** Draws what a message carries, under its text. */
export type ThreadAttachments<M> = (m: M) => Node | null;

export function threadMessage<M extends ThreadMessageValue>(m: M, attachments?: ThreadAttachments<M>): HTMLElement;

/** The note box: el goes in the column; Enter in box, or Send note, calls send. */
export interface ThreadNote {
  el: HTMLElement;
  box: HTMLTextAreaElement;
  send(): void;
}

export interface ThreadOptions<M extends ThreadMessageValue> {
  /** What the thread is on; with none it draws only empty. */
  id?: string | null;
  /** The words with no id. */
  empty?: string;
  name?: string;
  /** The card's key: a button that copies a link to it, plain when readOnly; none, no line. */
  key?: string | null;
  /** The address's #fragment the key copies; default the id. */
  link?: string;
  messages?: M[];
  note?: ThreadNote | null;
  readOnly?: boolean;
  attachments?: ThreadAttachments<M>;
}

/** The thread column's content. */
export function thread<M extends ThreadMessageValue>(o: ThreadOptions<M>): HTMLElement;

// ---- tabs.js

export interface RailTab {
  id: string;
  label: string;
  /** Shown after the label; 0 shows, and null or undefined leaves none. */
  count?: number | string | null;
  /** The tab's content. It stays in the page while hidden; to redraw, the tool changes what's inside its own element. */
  body: Node;
}

export interface RailTabsOptions {
  /** The tool's name: the tab last pressed is remembered under <name>.railTab. */
  name: string;
  tabs: RailTab[];
  /** The tab to start on when the page remembers none. Default the first. */
  open?: string;
  /** Hears each press with the tab's id; setOpen doesn't call it. */
  onOpen?(id: string): void;
}

export interface RailTabs {
  /** Goes in the frame's rightBody, so setRightEmpty folds the column around it. */
  el: HTMLElement;
  /** Shows a tab for the tool, without remembering it: only a press is the reader's choice. An unknown id changes nothing. */
  setOpen(id: string): void;
  setCount(id: string, n: number | string | null | undefined): void;
}

/** Tabs in the right column, under its fold toggle's line, one body shown at a time. */
export function railTabs(o: RailTabsOptions): RailTabs;

/** What the kit remembers for a reader, in localStorage. Where localStorage throws (a frame sandboxed without allow-same-origin), get answers null and set and remove do nothing, so the page still draws. */
export const remembered: {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

// ---- track.js

export interface StageDetail {
  title: string;
  rows?: { id?: string; text: string; meta?: string }[];
  note?: string;
}

/** One stage, as plain values, so each tool or job gives its own. */
export interface StageValue {
  key: string;
  label: string;
  /** Drawn after the label: "Findings · 3 of 5". */
  count?: string;
  /** The class it draws in; done adds a tick, now is the aria-current step. */
  state?: 'done' | 'now' | 'flagged' | '';
  /** A pulsing dot: something runs in it. */
  live?: boolean;
  /** Adds an ⓘ with this in its tip. */
  detail?: StageDetail;
  /** What it opens: stageTrack passes this to open. Unset, the stage is plain. */
  opens?: string | null;
}

/** One stage; open, when given, makes it a button. */
export function stagePill(s: StageValue, open?: (() => void) | null): HTMLElement;

export interface StageTrackOptions {
  /** A stage, or an element (a tab of the caller's) that takes its place as it is. */
  stages: (StageValue | HTMLElement)[];
  open?: (opens: string) => void;
  /** The track's aria-label. */
  label?: string;
  /** Greys it out and stops its pulse. */
  parked?: boolean;
  /** What follows on the line: wait badges, counts. */
  after?: (Node | null)[];
}

/** The stages joined by arrows. */
export function stageTrack(o: StageTrackOptions): HTMLElement;

export interface WaitValue {
  text: string;
  /** Who it waits on; 'you' is the reader. */
  who: string;
}

/** One badge, on you if any wait is, and the rest behind "and N more"; [] with no waits. */
export function waitBadges(waits: WaitValue[]): HTMLElement[];

export interface WorkingLineOptions {
  text: string | null;
  /** Draw it as a message not settled yet. */
  pending?: boolean;
  /** Hold one line's height with or without text; a long line gets a tip. */
  slot?: boolean;
}

/** The agent's one line with a pulsing dot. */
export function workingLine(o: WorkingLineOptions & { slot: true }): HTMLElement;
export function workingLine(o: WorkingLineOptions): HTMLElement | null;

// ---- drafts.js

/** The three questions a card can always be asked, in the page's words. */
export const QUESTIONS: { explain: string; smaller: string; breaks: string };

/** A button for buttons(): once asked it reads "✓ Sent: <label>" and stays off until the agent answers. */
export function questionButton(o: { label: string; asked: boolean; run(): void }): Button;

export interface DraftBox {
  /** What holds the box; put this in the page. */
  el: HTMLElement;
  box: HTMLTextAreaElement;
}

export interface Drafts {
  /** The reader's choices until Send, by what they answer. The caller redraws after changing it. */
  picks: Map<string, string>;
  /** A text box for key; drawn again, it holds what was typed. */
  box(key: string, placeholder: string, rows?: number): DraftBox;
  get(key: string): string;
  keys(): IterableIterator<string>;
  /** Returns the text, forgets it and empties every box drawn for key. */
  take(key: string): string;
  /** Puts text back in a box after a refused send. */
  restore(key: string, text: string): void;
  /** The drafts whose key starts with prefix, by what follows it. */
  notes(prefix: string): Map<string, string>;
  /** Any pick, or any text that is more than space: a reload would lose it. */
  dirty(): boolean;
  /** Clears the picks and the drafts whose key starts with prefix. */
  discard(prefix: string): void;
}

/** Keeps drafts apart from the page, so they survive a redraw. wrap holds the box in something of the tool's own. */
export function createDrafts(o?: { wrap?(box: HTMLTextAreaElement, key: string): HTMLElement }): Drafts;

export interface SendBarOptions {
  /** Where the page stands: "1 of 2 answered". */
  count: string;
  /** How many go on Send; none leaves Discard and Send off. */
  sends: number;
  hint: string;
  discard(): void;
  send(): void;
  /** Buttons before Discard. */
  extra?: Button[];
}

/** The bar at the foot of a page of drafts. */
export function sendBar(o: SendBarOptions): HTMLElement;

// ---- draftlist.js

export interface DraftListItem {
  id: string;
  /** The item the draft is on, drawn as given. */
  quote: string;
  /** The draft's words. */
  text: string;
  /** A line under the words. */
  meta?: string;
}

export interface DraftCallbacks {
  /** Hears the new words on blur or Enter, when they changed. The row already shows them, so it needn't redraw. */
  onEdit?(id: string, text: string): void;
  /** Hears delete. Unsaved words go with the draft. The tool removes the row. */
  onDelete?(id: string): void;
  /** Hears a press on the row, or the focus moving into its box: show the item. The row marks itself, so it needn't redraw. */
  onSelect?(id: string): void;
}

/** One draft's row, an <li>. */
export function draftRow(o: DraftCallbacks & { draft: DraftListItem; on?: boolean }): HTMLElement;

export interface DraftList {
  el: HTMLElement;
  /** Draws again, at any moment. A row whose draft id is still there stays the same element, with its focus, caret and unsaved words; only what changed is updated. New words from the tool replace a box's only when it has nothing unsaved. A draft no longer given goes, unsaved words with it. */
  redraw(o: { drafts: DraftListItem[]; selected?: string }): void;
}

/** The drafts list, for a tab of the right column. The tool stores the drafts. Put el in the page once and call redraw on updates: taking el out of the page takes the focus from its box. */
export function draftList(o: DraftCallbacks & { drafts: DraftListItem[]; empty: string; selected?: string }): DraftList;

// ---- elsewhere.js

/** The call to make whenever the bar's "also open" list may have changed. Each runs read() for the items and sets the bar only when they changed (their onClick aside), so an open list stays open. A call during a read reads once more after it, never twice at once; a failed read leaves the list as it was. */
export function keepElsewhere(bar: Pick<BarHandle, 'setElsewhere'>, read: () => Promise<ElsewhereItem[]> | ElsewhereItem[]): () => Promise<void>;

// ---- frontpage.js

/** A value to filter by, with how many it holds. */
export interface FilterItem {
  value: string;
  label: string;
  count: number;
}

/** A section of the left column: All with the total, then one row per item with its count. Several can be chosen; All is on when none is. onToggle hears the value pressed, '' for All. */
export function filterRow(o: { label: string; items: FilterItem[]; chosen: string[]; onToggle(value: string): void }): HTMLElement;

/** The status pills, drawn as a stage track with no arrows, since statuses aren't a sequence. A pill with no count is hidden unless chosen. The value '' is the tool's All, on when none is chosen. onToggle hears the value pressed. */
export function statusPills(o: { pills: FilterItem[]; chosen: string[]; onToggle(value: string): void; label?: string }): HTMLElement;

export interface ListGroup {
  key: string;
  title: string;
  /** The group's rows, each an <li>. */
  rows: HTMLElement[];
  /** The line shown when it has no rows. */
  empty: string;
  /** The edge of a group that needs you. */
  edge?: 'signal' | 'agent' | 'wait';
}

/** Named groups of rows, each a card that folds in place. folded holds the keys that start folded; onFold hears each press with the key and whether it is now folded. The tool decides which groups to pass, and keeps what it hears for its next draw. */
export function groupList(o: { groups: ListGroup[]; folded: string[]; onFold(key: string, folded: boolean): void }): HTMLElement;
