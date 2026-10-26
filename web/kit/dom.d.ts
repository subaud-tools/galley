// ---- dom.js

type Child = Node | string | number | null | undefined | false;

/** Create an element: class, on<event>, dataset, boolean attributes; string children are text. */
export function h(tag: string, attrs?: Record<string, unknown> | null, ...children: Array<Child | Child[]>): HTMLElement;

export interface Section {
  id: string;
  label: string;
  /** Any string: "46", "37/150". */
  count?: string | number;
}

export interface Primary {
  label: string;
  run(): void;
}

export type StatusTone = 'muted' | 'signal' | 'danger';

export interface BarHandle {
  el: HTMLElement;
  themeControl: HTMLElement;
  setSection(id: string): void;
  setCount(id: string, count?: string | number | null): void;
  /** tone: muted (default), signal, or danger (e.g. "offline · 3 queued"). */
  setStatus(text: string, opts?: { tone?: StatusTone }): void;
  /** The pill; text overrides its label (stale defaults to the bar's staleText). */
  setLive(s: LiveStatus, text?: string): void;
  /** The one filled button; null hides it. */
  setPrimary(p: Primary | null): void;
  /** The "also open" button before the live pill, and its list in this order. An empty array hides it. */
  setElsewhere(items: ElsewhereItem[]): void;
}

/** An item in the bar's "also open" list: other work a click away. The bar shows one fixed-width button that counts the items (and those that need you) and opens the list. */
export interface ElsewhereItem {
  label: string;
  /** Muted line under the label in the list, e.g. "needs you · Decisions". */
  detail?: string;
  /** Who it waits on: you (signal dot and edge), working (the agent's dot), idle (muted, the default). */
  tone?: 'you' | 'working' | 'idle';
  /** The page you are on: listed in its place and counted, marked "you are here"; its row only closes the list. */
  current?: boolean;
  onClick(): void;
}

export function bar(o: {
  /** With href, the brand links there (the tool's home page); without it, plain text. */
  brand: { name: string; mark?: Node; href?: string };
  sections?: Section[];
  active?: string;
  onSection?(id: string): void;
  status?: string;
  primary?: Primary | null;
  theme?: HTMLElement;
  /** The tool's words for the stale pill, e.g. "restarted · continued in a new tab". */
  staleText?: string;
}): BarHandle;

export interface Chip {
  id: string;
  label: string;
  count?: string | number;
  on?: boolean;
}

export interface Row {
  /** The row's identity across setItems; without it, key + title is. */
  id?: string;
  /** The mono kicker line. */
  key?: string;
  title: string;
  meta?: string;
  sub?: string;
  selectable?: boolean;
}

export interface ListHandle<T> extends ListNav {
  el: HTMLElement;
  /** The store this list binds to: the one passed in, or its own. */
  selection: Selection;
  /** Keeps the open row, cursor and selection by row id (else key + title); calls onSelect if the selection changed. Tested to 500 rows; paginate beyond that. */
  setItems(items: T[]): void;
  setChips(group: 'view' | 'filter', chips: Chip[]): void;
  move(d: number): void;
  open(i?: number): void;
  toggle(i?: number): void;
  toggleRange(i?: number): void;
  /** The selected items among those rendered now. */
  selected(): T[];
  /** Every selected row id, rendered or not (other pages, select-all-in-view). Rows need an id. */
  selectedIds(): string[];
  selectAll(ids: string[]): void;
  deselect(ids: string[]): void;
  clearSelection(): void;
  /** The cursor row's index, -1 when empty. */
  current(): number;
  /** Set the search text (e.g. restored from the URL) without calling onInput. */
  setSearch(text: string): void;
  /** Present only when the list has a search field; the keyboard layer binds / to it. */
  focusSearch?(): void;
  /** Stop listening to a shared selection (call when the list is discarded). */
  destroy(): void;
}

export function list<T>(o: {
  label: string;
  views?: Chip[];
  filters?: Chip[];
  onChip?(group: 'view' | 'filter', id: string): void;
  row(item: T): Row;
  onOpen?(item: T, i: number): void;
  onSelect?(selected: T[]): void;
  /** A search field in the header. onInput runs on every input (no debounce). Esc clears it, then leaves it; / focuses it. */
  search?: { placeholder?: string; value?: string; onInput(text: string): void };
  /** Bind to a shared selection store; rows need an id. Default: the list's own. */
  selection?: Selection;
  /** Open the row the cursor moves to (the reading column follows j/k). */
  openOnMove?: boolean;
  foot?: Node;
}): ListHandle<T>;

export function facts(pairs: Array<[string, string | Node]>): HTMLElement;

export interface Button {
  label: string;
  run?(): void;
  /** The one primary in a card. */
  fill?: boolean;
  /** A destructive verb: red text. */
  danger?: boolean;
  disabled?: boolean;
}

export function buttons(bs: Button[]): HTMLElement;

export function card(o: { edge?: 'signal' | 'agent' | 'wait'; head?: string; body?: Node | string; actions?: Button[] }): HTMLElement;

/** Line-numbered source: two <pre>s, scrolls sideways; highlight returns the source's content. */
export function codeBlock(src: string, o?: { start?: number; highlight?(src: string): Node }): HTMLElement;

export function fold(label: string, content: Node | string, o?: { open?: boolean }): HTMLDetailsElement;

/** ↵ or blur commits a changed value; Esc reverts and leaves. Page keys don't fire while it has focus. */
export function noteField(o: { value?: string; placeholder?: string; onCommit(v: string): void }): HTMLInputElement;

/** A message's state: tools-common/msgstate's State. */
export type MessageState = 'sent' | 'with_agent' | 'working' | 'answered' | 'declined' | 'failed' | 'no_reply';

/** A message's state pill (its label from msgstate.js) with the line under it; no line, no line element. */
export function messagePill(state: MessageState, line?: string): HTMLSpanElement;

