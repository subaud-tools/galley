// appshell.ts — what `this` must be, inside every mixin `Object.assign`ed
// onto `App.prototype`.
//
// A mixin's methods read and write `this` on the live App instance —
// `this.rail`, `this.suggestions`, `this.paintCensus` — and `this` on a plain
// object literal has no type of its own to infer from. THIS FILE IS THAT
// TYPE, spelled once so every mixin task after this one (three more are
// coming, covering roughly twenty more modules) inherits the same answer
// rather than each inventing its own.
//
// THREE SHAPES WERE WEIGHED. TWO ARE ON RECORD AS REJECTED.
//
// PER-MIXIN INTERFACES — each mixin declaring exactly the members its own
// methods touch — were the most honest shape on paper: a mixin's own
// interface IS its documented surface, and reaching for a member the
// interface does not list is a type error naming the overreach on sight.
// REJECTED, because the mixins do not, in fact, keep to disjoint surfaces: they all
// land on one shared prototype, and they share `this.editor`,
// `this.versionsPanel` and `this.step` among others. Twenty-one further mixin files
// declaring their own copies of that same core is the "two spellings of one
// rule" shape this codebase has already paid for a dozen times over (see
// CLAUDE.md's "six agreeing spellings and one silence" and everything that
// followed it) — except here it would be TWENTY spellings, each one a place
// a shared field's type could quietly drift from the others.
//
// `ThisType<>` ON THE OBJECT LITERAL is the idiomatic TypeScript spelling of
// exactly this pattern, and it was rejected for what happens at the OTHER
// end of it — Task 8, where `entry.js` becomes `entry.ts` and `App` becomes a
// real class. `ThisType<AppShell>` makes every method in an object literal
// see `this: AppShell` WITHOUT a per-method annotation, which means nothing
// at the call site records that a method needs it, and nothing forces
// `class App` to PROVE it actually satisfies AppShell — there is no
// expression anywhere for that proof to attach to. `this: AppShell` written
// as an explicit first parameter on every method is the identical constraint
// on the identical body, and it costs one line per method — but it appears
// in the function's own signature, which is a real position TypeScript can
// check the moment `App` is a typed class: `Object.assign(App.prototype,
// keyMethods)` becomes a call TypeScript can refuse, and `class App
// implements AppShell` becomes a sentence TypeScript can verify. That
// verification is the entire point of doing this now rather than leaving
// every mixin's assumption about `this` implicit until Task 8 has to
// reconstruct it from twenty-five files at once.
//
// SO: ONE SHARED INTERFACE, and every mixin method spells `this: AppShell`
// as its first parameter — in this file, and in every mixin file after it.
// It is not a claim that App has ONLY these members; App will have hundreds,
// most of them private to a single not-yet-converted mixin. It is a claim
// that THESE are the ones a method converted so far may touch, checked on
// every one of them, every time this file or a caller of it changes.
//
// GOD-INTERFACE IS A REAL RISK, AND IT IS ACCEPTED RATHER THAN DESIGNED
// AROUND. As the three remaining mixin tasks land, this file's member count
// will keep growing toward App's own. That is the honest shape of a codebase
// whose mixins already share one prototype by design — an interface kept
// artificially small by inventing boundaries the mixins themselves do not
// observe would be documenting a discipline the code does not practise, and
// would be wrong in the direction that costs the most: a member silently
// missing from AppShell that some OTHER mixin still needs is exactly the
// wrong assumption this file exists to make loud. What stays narrow is each
// method's OWN reach — `this: AppShell` reads the same on `sectionFor` as on
// `paintSheet`, and that is the cost of the shared shape.
//
// AT TASK 8, AND THIS WAS MEASURED RATHER THAN REASONED. An earlier draft of
// this header said `class App implements AppShell` would become a sentence
// TypeScript can verify. IT WOULD NOT: 34 of these members arrive through
// `Object.assign(App.prototype, …)`, so no class body declares them, and the
// clause reports "Property 'paintCensus' is missing in type 'App'" once per
// method. The obvious repair — declaration merging, `interface App extends
// AppShell {}` — compiles, and verifies NOTHING: a required member simply
// absent from the class still type-checks at every use and is `undefined` at
// runtime. Both were run against this repo's own tsc before this was written.
//
// So the interface is SPLIT along the only line that matters here — what the
// class body itself declares, against what is bolted on afterwards:
//
//   `class App implements AppState`   — REAL verification. Every field below
//                                       is one App's own constructor assigns,
//                                       so the clause can and does check it.
//   `interface App extends AppMethods {}` — a DECLARATION, not a check, and
//                                       necessarily so: these genuinely do
//                                       not exist until Object.assign runs.
//
// `AppShell` is the two together and stays what every mixin method's `this`
// is annotated as, so nothing in the six converted mixins changes. What the
// split buys is that the half which CAN be checked now is, instead of both
// halves being an unverified claim.
//
// The original argument for a per-method `this` over `ThisType<>` survives
// this correction intact — an explicit annotation is still the position that
// makes `Object.assign(App.prototype, keyMethods)` a call TypeScript can
// refuse. Only the `implements` half of it was wrong.
//
// AppShell is written from the MIXINS' side rather than narrowed FROM App's
// own shape, because App will carry members no mixin needs (constructor
// plumbing, DOM handles private to one
// not-yet-converted mixin) and AppShell exists to describe the SHARED
// surface, not the whole instance. `implements` is the check this file was
// written to make possible: the moment a member this file promises goes
// missing, is renamed, or changes shape on the real class, `class App
// implements AppShell` is a compile error naming exactly which member and
// where — not an `undefined` three files away at runtime, discovered by
// whoever happened to click the right button first.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type {
  SuggestionLike,
  SuggestionRun,
  SuggestionUI,
  LiteralHit,
} from './suggestions.ts';
import type { VersionsPanel, Arrival } from './versions.ts';
import type { PendingThread, PendingThreadEntry } from './tabs.ts';
import type {
  PendingView,
  BlockRef,
  Region,
  ReviseStateView,
  ReviewerChange,
  MessageView,
} from './wire';
import type { Composer } from './composer.ts';
import type { MessageState } from './kit/dom.js';
import type { GripTarget } from './grips.ts';
import type { Mode, ModeUI } from './bar.ts';
import type { DocMenu, MenuItem } from './menu.ts';
import type { ReviseWatchView } from './verdict.ts';
import type { ShareMenu } from './share.ts';

// --- shapes AppShell's members are built from ---

// A thread as the App carries it in `this.comments` — the rounds-only wire's
// `/_galley/pending` instructions, adapted to the rail's established card
// shape. Built by pending.ts's refreshPending, which is the one place this
// shape is actually assembled; every other mixin only reads it.
//
// It EXTENDS tabs.ts's own `PendingThread` (widening every field back to
// required, since the App always fills every one of them) rather than
// re-declaring the same eight fields by hand — see tabs.ts's own comment on
// why PendingThread is exported at all.
export interface ThreadEntry extends PendingThreadEntry {
  author: string;
  at: string;
  text: string;
}

export interface Thread extends PendingThread {
  key: string;
  heading: string;
  entries: ThreadEntry[];
  run: string;
  anchor: string;
  anchorKey: string;
  blockKind: string;
  region: Region | null;
  instruction: true;
}

// The loose shape of one arrival — the same fields web/arrivals.ts's own
// (unexported) `Arrival` type carries, restated here because a caller cannot
// name a type its source file does not export. TypeScript compares these
// structurally, not by name, so this and arrivals.ts's `Arrival` are
// interchangeable wherever both appear.
export interface ArrivalItem {
  run?: string;
  author?: string;
  kind?: string;
  section?: string;
}

// What `/_galley/revise` reports, restricted to the two fields readArrival
// reads.
//
// IT IS A NARROWING OF THE GENERATED TYPE NOW, not a hand-copy beside it. The
// comment here used to say "not in wire.d.ts: that file carries only the five
// view structs wire_test.go generates it from, and `/_galley/revise` is not one
// of them" — true when it was written, and fixed rather than restated:
// `ReviseStateView` is generated, so `landed` and `cannot` cannot be renamed on
// the Go side without this failing to compile.
//
// It stays a NAMED NARROWING rather than becoming the full type, because
// readArrival genuinely reads two fields and a reader typed to the whole
// payload invites the next author to reach for a third without asking whether
// this surface should know about it.
export type ReviseView = Pick<ReviseStateView, 'landed' | 'cannot'>;

// `/_galley/rev` and `/_galley/saved` — the two polls `tick` makes on every
// beat. Both handlers (`internal/serve/editmode.go`) write every field of
// their response unconditionally, so nothing here is optional.
export interface RevView {
  rev: number;
  room: string;
}

export interface SavedView {
  saved: number;
}

// --- the shell itself ---

export interface AppState {
  // --- editor and identity ---
  editor: Editor;
  docName: string;
  // Read once off the mount (`data-page-mode`, `data-can-share`), before the
  // rail is built: whether a page is under review, and whether the server can
  // put a file on the clipboard, which only macOS can (Share's menu).
  pageMode: boolean;
  canShare: boolean;
  room: string | null;
  sealed: boolean;

  // --- the pending view: suggestions, threads, blocks ---
  suggestions: SuggestionLike[];
  prevSuggestions: SuggestionLike[] | null;
  comments: Thread[];
  // changes is what the reviewer altered BY HAND since the last round —
  // the other half of what pressing Revise sends. Off the same pending
  // payload as the instructions; see the server's liveChanges.
  changes: ReviewerChange[];
  blocks: BlockRef[];
  pendingCount: number;
  // A press is waiting for the words on their way to the server.
  settling: boolean;
  verdict: string;

  // --- the right column's tabs (web/tabs.ts) ---
  // Which "your edit" row's Revert is armed, on its first press.
  armedRevert: string | null;
  // The draft whose row is marked and whose words are lit.
  selectedDraft: string;
  // Where j and k last stopped.
  stepped: string | null;

  // --- the bubble, and the census/bar chrome ---
  bubble: SuggestionUI;
  strip: { root: HTMLElement };

  // --- arrivals: the queue, the hold, the strip's batch ---
  arrivalQueue: ArrivalItem[];
  stripBatch: ArrivalItem[];
  held: Set<string>;
  heldArrivals: ArrivalItem[];
  holding: boolean;
  newRuns: Set<string>;

  // --- History: the door, the round, the reading state ---
  versionsPanel: VersionsPanel;
  versionsButton: HTMLButtonElement;
  historyScroll: number;
  seenRound: number | null;
  seenCannot: string;
  arrival: Arrival | null;

  // --- the verdict menu, and polling ---
  verdictOpen: boolean;
  rev: number | null;
  savedMs: number;

  // --- Revise (web/verdict.ts) ---
  // `this.revise = this.makeRevise();` is a direct, unconditional
  // constructor assignment — makeRevise itself may return null (no
  // `#gly-revise` on an unbuilt checkout), so the field is nullable rather
  // than absent.
  revise: HTMLButtonElement | null;
  // Discard drafts beside it, and what the two and the primary read.
  discardBtn: HTMLButtonElement | null;
  discardArmedAt: number;
  discarding: boolean;
  approving: boolean;
  editCount: number;
  // Where the last Revise stands: the cell makeRevise puts beside the button,
  // and the message readRevise last read (none before the first poll, and
  // none when the server has none).
  reviseMsg?: HTMLElement;
  reviseMessage?: MessageView | null;
  // The verdict menu — built on the first press that needs it
  // (`this.verdictMenu = null;` is the constructor's own direct,
  // unconditional line; `openVerdictMenu` fills it in later).
  verdictMenu: HTMLElement | null;
  // R10's window: direct, unconditional constructor assignments
  // (`this.reviseWaiting = false; this.reviseRunning = false;
  // this.approveNotBefore = 0; this.reviseStartedAt = 0;`).
  reviseRunning: boolean;
  approveNotBefore: number;
  reviseStartedAt: number;

  // --- the seal and the handoff (web/seal.ts) ---
  // Every one of these is a direct, unconditional constructor line:
  // `this.sealed = false; this.sealVerdict = ''; this.sealAt = 0;
  // this.sealEntrusted = 0; this.sealOutstanding = 0; this.sealLanding = 0;
  // this.sealUI = this.makeSeal();` — makeSeal always returns the same
  // shape, never null.
  sealVerdict: string;
  sealAt: number;
  sealEntrusted: number;
  sealOutstanding: number;
  sealLanding: number;
  sealUI: { readout: HTMLElement };
  // `this.cancelBtn = this.makeHandoffCancel();` — direct and unconditional;
  // makeHandoffCancel itself may return null (the anchor button it hangs
  // off, `#gly-revise`, may not exist).
  cancelBtn: HTMLButtonElement | null;
  // `this.share = this.makeShare();` — direct and unconditional, nullable
  // for the cancel button's reason (no `#gly-revise`, nothing to sit beside).
  // makeShare builds the kit's menu with it, hidden.
  share: HTMLButtonElement | null;
  shareMenu: ShareMenu | null;

  // --- the block grips (web/figures.ts) ---
  //
  // `gripSizes` is optional for `barSize`'s reason: it is assigned only
  // inside a `typeof window.ResizeObserver === 'function'` branch.
  grips: HTMLElement;
  // The block instruction's one scope outline, beside the grips (paintScope).
  scopeBox: HTMLElement;
  scheduleGrips: () => void;
  gripSizes?: ResizeObserver;

  // --- the right-click menu in the document (web/menu.ts) ---
  //
  // Built once, on `body`, and never rebuilt — only its rows are. It is
  // unconditional (`this.menu = makeMenu()` in the constructor), so unlike
  // `overall` and `capture` it is never optional.
  menu: DocMenu;

  // --- the composer, and the refused-keystroke note (web/composer.ts) ---
  composer: Composer;
  refusal: HTMLElement;
  refusalPending: LiteralHit | null;
  refusalTick: number;
  refusalTimer: number;
  refusalShownAt: number;
  // The deferred composer-blur dismissal's own setTimeout handle — cancelled
  // by placeComposerButton when a fresh placement outranks it. See
  // composer.ts's placeComposerButton for why a placement beats a dismissal.
  // `number | undefined`, and the undefined is not defensive. Both writes to
  // this field live inside entry.ts's `editor.on('blur', …)` callback, which
  // the constructor REGISTERS but does not RUN — so the field is genuinely
  // unset until the first blur fires, and entry.ts:839 reads it before ever
  // writing it. That read is `window.clearTimeout(this.blurDismiss)`, a
  // silent no-op on undefined, which is why nothing has ever noticed.
  //
  // Typed `number` this would be a lie tsc cannot catch today and WOULD catch
  // at Task 8: strictPropertyInitialization does not credit an assignment
  // inside a nested callback, so `class App implements AppState` would fail
  // here — and the tempting repair is a definite-assignment `!`, which the
  // global constraints forbid. Saying `| undefined` now costs nothing and
  // leaves Task 8 free to add a real initialiser as a deliberate change
  // rather than a forced one.
  blurDismiss: number | undefined;

  // --- the bar's status readout and mode toggle (web/bar.ts) ---
  status: HTMLElement;
  said: string;
  connection: string;
  historyCount: number;
  approved: boolean;
  handoff: boolean;
  draftError: string;
  diskNotice: string;
  reviseWaiting: boolean;
  mode: Mode;
  modeUI: ModeUI;
}

// THE METHODS ARRIVE AT RUNTIME, WHICH IS WHY THEY ARE A SEPARATE INTERFACE.
// Every one of these reaches App through `Object.assign(App.prototype, …)`, so
// no class body declares them and no `implements` clause can check them —
// measured, not assumed: `class App implements AppShell` reports "Property
// 'paintCensus' is missing in type 'App'" for each one. Splitting them out is
// what lets the half that CAN be verified actually be verified.
export interface AppMethods {
  closeVerdictMenu(): void;
  hideComposer(): void;
  clearScope(): void;
  openComposerForm(): void;
  menuItems(): MenuItem[];
  menuAt(target: EventTarget | null): boolean;
  hideRefusal(): void;
  hideStrip(): void;
  paintVersionsButton(): void;
  runsNow(): SuggestionRun[];
  step(direction: 1 | -1): void;
  stepOrder(): string[];
  clearNewLater(): void;
  noticeArrivals(arrived: ArrivalItem[]): void;
  paintHold(): void;
  paintReadout(): void;
  paintRevise(): void;
  sendVerdict(
    body: Parameters<AppShell['postVerdict']>[0],
    approving: boolean,
  ): void;
  paintMessage(): void;
  readRevise(): void;
  refreshPending(): Promise<void>;
  reconcileRunSets(
    arrived: ArrivalItem[],
    resolved: (string | undefined)[],
  ): void;
  sectionFor(run: SuggestionRun | null): string;
  showStrip(
    text: string,
    arrival?: Arrival | null,
    pill?: MessageState | null,
  ): void;
  // SUPERSEDES an earlier generic stub (`<T extends { run?: string }>`)
  // written before this method's body existed. verdict.ts's withhold reads
  // `kind`/`author` off every arrival to reconstruct a `SuggestionLike` for
  // `runFor` — fields the generic bound never promised — and pending.ts's
  // `change.arrived` (arrivals.ts's own `Arrival[]`) is its one caller, so
  // the concrete shape is the honest one rather than a genericity nothing
  // needs.
  withhold(arrived: ArrivalItem[]): ArrivalItem[];
  say(text: string): void;
  toggleVersions(): void;
  showArrival(): void;

  // --- Revise, the verdict menu, and hold/release (web/verdict.ts) ---
  askRevise(): void;
  pressSend(): void;
  makeDiscard(): HTMLButtonElement | null;
  discardDrafts(): void;
  paintDiscard(): void;
  paintChrome(): void;
  openStage(opens: string): void;
  postVerdict(
    body: { verdict?: string; approveOnAnswer?: boolean; trust?: boolean },
    approving: boolean,
  ): void;
  makeVerdictMenu(): HTMLElement;
  openVerdictMenu(): void;

  // --- the seal and the handoff (web/seal.ts) ---
  // readArrival is history.ts's own — declared here because verdict.ts's
  // readRevise is the poll that drives it, the first already-converted
  // caller. readSeal/readHandoff/applySeal/paintSeal and the two
  // sealed-verb sweeps are seal.ts's, needed for its own self-calls.
  readArrival(d: ReviseView): void;
  readSeal(d: ReviseWatchView): void;
  readHandoff(d: ReviseWatchView): void;
  applySeal(was: boolean, d: ReviseWatchView): void;
  paintSeal(): void;
  paintCancel(): void;
  paintCancelOn(b: HTMLButtonElement): void;
  applySealedVerbs(): void;
  releaseSealOnlyVerbs(): void;
  sealHides(): (HTMLElement | null)[];

  // --- the right column's tabs (web/tabs.ts) ---
  paintTabs(): void;
  paintChat(): void;
  wireTabs(): void;
  editDraft(key: string, text: string): Promise<boolean>;
  deleteDraft(key: string): void;
  strandEdit(words: string): void;
  selectDraft(key: string): void;
  openDraft(key: string): void;
  fileChat(text: string): Promise<boolean>;
  chatHolds(): boolean;
  revertEdit(key: string): void;
  reveal(run: string): void;
  revealBlock(index: number): void;
  // The band of the window the PROSE is readable in, measured per call —
  // App's own, and the number every floating surface here clamps into.
  chromeFrame(): { top: number; bottom: number };
  // --- three of entry.ts's own methods, needed now that a converted mixin
  //     calls each by name ---
  clearTrail(): void;
  refreshVersions(): void;
  paintNoteWords(): void;

  // --- figures and the block grips (web/figures.ts) ---
  figurePairs(): Array<{
    node: PMNode;
    pos: number;
    index: number;
    el: HTMLElement;
  }>;
  paintFigures(): void;
  markRegion(): void;
  openBlockComposer(target: GripTarget, opener: HTMLElement | null): void;
  adoptGripBlock(): void;
  paintGrips(): void;
  paintScope(): void;
  paintPins(el: HTMLElement, ref: BlockRef | null): void;

  // --- the composer, and the refused-keystroke note (web/composer.ts) ---
  fileBlockComment(c: Composer, text: string, settled: () => void): void;
  headBlockComposer(
    target: Pick<GripTarget, 'kind' | 'figure'>,
    label: string,
    region?: boolean,
  ): void;
  headComposer(quote: string): void;
  paintRefusal(hit: LiteralHit): void;
  pulseFence(pos: number): void;
  sendComment(): void;

  // --- the bar's mode toggle, and the light (web/bar.ts) ---
  paintLit(): void;
  paintMode(): void;
  release(): void;
  toggleHold(): void;
  toggleMode(): void;
  readMode(): void;

  // --- TASK 8 ADDITIONS. Every member below is a real mixin method (Tasks
  // 5-7 already gave each one `this: AppShell`) that only entry.ts's own
  // constructor called — never another mixin — so nothing before this task
  // ever needed it typed. Converting entry.ts means typing its constructor,
  // and its constructor calls every one of these by name
  // (`this.makeCensus()`, `this.onKey(event)`, and so on), so they join the
  // shared surface now for the same reason every earlier member did: a
  // member silently missing from AppShell that a real caller still needs is
  // exactly the wrong assumption this file exists to make loud. ---

  // --- History's own door and reading-mode entry/exit (web/history.ts) ---
  makeVersionsButton(): HTMLButtonElement;
  enterHistory(): void;
  leaveHistory(): void;
  didRestore(version: number, error: string): void;

  // --- the keyboard (web/keys.ts) ---
  onKey(event: KeyboardEvent): void;

  // --- the poll-and-refresh loop's own beat (web/pending.ts) ---
  tick(): void;

  // --- the composer's own builders and the refusal note's full lifecycle
  //     (web/composer.ts) ---
  makeComposer(): Composer;
  makeRefusal(): HTMLElement;
  refuse(hit: LiteralHit): void;
  dismissRefusal(): void;
  placeComposer(
    start: { top: number; left: number },
    end: { bottom: number; left?: number },
    gap?: number,
  ): void;
  placeComposerButton(byReviewer?: boolean): void;

  // --- the bar's own builders (web/bar.ts) ---
  makeStatus(): HTMLElement;
  makeMode(): ModeUI;

  // --- figures' own builder (web/figures.ts) ---
  makeGripLayer(): HTMLElement;
  makeScopeBox(): HTMLElement;

  // --- the seal and the handoff's own builders (web/seal.ts) ---
  makeHandoffCancel(): HTMLButtonElement | null;
  makeSeal(): { readout: HTMLElement };

  // --- Revise's own builder (web/verdict.ts) ---
  makeRevise(): HTMLButtonElement | null;

  // --- Share, and the bar's preview button (web/share.ts) ---
  makeShare(): HTMLButtonElement | null;
  swapShare(sealed: boolean): void;
  closeShareMenu(): void;
  runShare(
    act: 'download-html' | 'download-md' | 'share-html' | 'share-md',
  ): void;
  makePreview(): HTMLButtonElement | null;
}

// What a mixin method's `this` is: both halves together.
export interface AppShell extends AppState, AppMethods {}

// PendingView is re-exported from here rather than each mixin importing it
// separately from `./wire` — the six-of-one-place discipline `wire.d.ts`'s
// own header states applies to its own re-export as much as to its fields.
export type { PendingView };
