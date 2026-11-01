// roundbar.ts — the words and states of the send bar, the bar's primary and the
// stage track, worked out from where the review stands. Pure, so probe.mjs can
// read it in node; web/shell.ts draws them with the kit.

import { COULD_NOT, askedOf, roundCards } from './versions.ts';
import type { MessageView, RoundView } from './wire';
import type { ChatMessage, DraftRowValue, EditRowValue } from './tabs.ts';

// What this file needs of the kit's StageValue. Spelled here because the kit
// only loads in a browser.
export interface RoundStage {
  key: string;
  label: string;
  count?: string;
  state?: 'done' | 'now' | 'flagged' | '';
  live?: boolean;
  opens?: string | null;
}

declare global {
  interface Window {
    galleyChrome?: GalleyChrome;
  }
}

/** What the shell gives the editor, on window.galleyChrome. */
/** What the kit's rows and the Chat box ask of the editor. */
export interface TabActions {
  /** Whether the words are safe: the server took them, or its row is gone and they went to Chat. */
  edit(key: string, text: string): Promise<boolean>;
  remove(key: string): void;
  select(key: string): void;
  file(text: string): Promise<boolean>;
  revert(key: string): void;
  /** A row left the page while its box held words it hadn't saved. */
  stranded(words: string): void;
}

export interface GalleyChrome {
  wireTabs(actions: TabActions): void;
  paintDrafts(view: {
    text: DraftRowValue[];
    chat: DraftRowValue[];
    edits: EditRowValue[];
    selected: string;
    counts: { instructions: number; chat: number };
  }): void;
  paintChat(messages: ChatMessage[]): void;
  /** Opens the Instructions tab on a draft's row. */
  showRow(key: string): void;
  /** Opens the Chat tab with its box in hand. */
  openChat(): void;
  /** Words with nowhere else to go, added to the Chat box. */
  keepInChat(words: string): void;
  /** The composer has something to ask: its tab comes forward. */
  showComposer(): void;
  /** The composer has gone: back to the tab it replaced. */
  composerGone(): void;
  /** The Chat box holds words not filed. */
  chatHolds(): boolean;
  /** Files what the Chat box holds. False when the server didn't take it. */
  fileWords(): Promise<boolean>;
  /** Waits out every save and filing on its way, trying a failed save again.
   * False when something is still not with the server. */
  settled(): Promise<boolean>;
  paintPrimary(label: string | null): void;
  paintStages(
    stages: RoundStage[],
    open: (opens: string) => void,
    door: HTMLElement | null,
  ): void;
}

export const MESSAGE_HELD_LINE =
  'the agent is mid-turn; it reads this when the turn ends';

/** The line under a message's pill. */
export function messageLine(m: MessageView): string {
  return m.held ? MESSAGE_HELD_LINE : m.line;
}

type MessageLike = { state: string } | null | undefined;

// The agent's turn is over with no answer: the round can go again.
function noReply(m: MessageLike): boolean {
  return !!m && m.state === 'no_reply';
}

// The last Revise is still the agent's: sent, with the agent or working.
function agentHasIt(m: MessageLike): boolean {
  return (
    !!m &&
    (m.state === 'sent' || m.state === 'with_agent' || m.state === 'working')
  );
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** The count on the send bar. The server's instructions are the drafts; hand
 * edits go with them on Revise, so they are named, but Discard leaves them. */
export function draftCountWords(drafts: number, edits: number): string {
  const parts = drafts > 0 ? [plural(drafts, 'draft')] : [];
  if (edits > 0) {
    parts.push(plural(edits, 'hand edit'));
  }
  return parts.length ? parts.join(' · ') : 'No drafts';
}

/** Revise's label and whether it can be pressed. */
export function sendFace(o: {
  drafts: number;
  edits: number;
  waiting: boolean;
  message: MessageLike;
  running: boolean;
  cooling: boolean;
  seconds: number;
}): { label: string; disabled: boolean; title: string } {
  const fresh = o.drafts + o.edits > 0;
  const again = !fresh && noReply(o.message);
  // Waiting with nothing running stays pressable while it counts: "you asked,
  // nothing has come back, ask again" is what a reviewer needs if the agent
  // died. While the agent has the Revise with nothing new, a press sends nothing.
  const asking = !fresh && !again && o.waiting;
  const pressable = fresh || again || (asking && !agentHasIt(o.message));
  const disabled = o.running || o.cooling || !pressable;
  if (again) {
    return {
      label: 'Revise · send again',
      disabled,
      title:
        'the agent’s turn ended without an answer — sends the same instructions again',
    };
  }
  if (asking) {
    return {
      label: `revising · ${o.seconds}s`,
      disabled,
      title:
        'asked, and nothing has landed yet — the counter stops when the document moves',
    };
  }
  return {
    label: o.drafts > 0 ? `Revise · send ${o.drafts}` : 'Revise',
    disabled,
    title: 'hand the document to the agent with your instructions and edits',
  };
}

/** Whether the review is the agent's now: the stage's live dot. */
export function agentHolds(o: {
  handoff: boolean;
  waiting: boolean;
  message: MessageLike;
}): boolean {
  // A turn that ended with no answer has nobody working on it, even while the
  // handoff is still open.
  if (noReply(o.message)) {
    return false;
  }
  return o.handoff || o.waiting || agentHasIt(o.message);
}

/** The bar's one primary: Approve while the review is with the reader, the way
 * back while History is open, otherwise none. */
export function primaryWords(o: {
  history: boolean;
  sealed: boolean;
  handoff: boolean;
  waiting: boolean;
  message: MessageLike;
}): string | null {
  if (o.history) {
    return '← back to draft';
  }
  return o.sealed || o.handoff || agentHolds(o) ? null : 'Approve';
}

// The cards of the track: the verdict's own cut is the end of the line, not a round.
/** What a round asked: its own asks, or those of the round it answers. A landing's
 * own instruction is the agent's note, not an ask. */
export function asksOf(card: RoundView): string[] {
  if (card.answers === 0) {
    return askedOf(card);
  }
  if (card.askedInstructions && card.askedInstructions.length > 0) {
    return card.askedInstructions;
  }
  return card.asked ? [card.asked] : [];
}

export function trackCards(
  rounds: RoundView[] | null | undefined,
): RoundView[] {
  return roundCards(rounds)
    .filter((r) => r.reason !== 'verdict')
    .sort((a, b) => a.n - b.n);
}

/** The number of the round in hand, as the track counts it: a cut the agent is
 * still on is it, otherwise the one after the last card. */
export function roundInHand(
  rounds: RoundView[] | null | undefined,
  live: boolean,
): number {
  const cards = trackCards(rounds);
  const last = cards[cards.length - 1];
  return live && last && last.answers === 0 ? cards.length : cards.length + 1;
}

/** One stage per round, the round in hand, and how the review ended. A finished
 * round opens at its version; the round in hand is plain, unless History is
 * open, where it is the way back. */
export function roundStages(o: {
  rounds: RoundView[] | null | undefined;
  drafts: number;
  live: boolean;
  sealed: boolean;
  verdict: string;
  reading: number;
  history: boolean;
}): RoundStage[] {
  const cards = trackCards(o.rounds);
  const last = cards[cards.length - 1];
  // A cut nobody has answered, with the agent still on it, is the round in hand.
  const inHand = o.live && last && last.answers === 0 ? last : null;
  const done = inHand ? cards.slice(0, -1) : cards;
  const stages: RoundStage[] = done.map((r, i) => finishedStage(r, i + 1, o));
  const number = done.length + 1;
  if (inHand) {
    stages.push({
      key: `round-${number}`,
      label: `Round ${number}`,
      count: plural(askedOf(inHand).length, 'instruction'),
      state: 'now',
      live: true,
    });
  } else if (!o.sealed) {
    const reading = o.history && o.reading > 0;
    stages.push({
      key: `round-${number}`,
      label: `Round ${number}`,
      count: o.drafts > 0 ? plural(o.drafts, 'draft') : undefined,
      state: reading ? '' : 'now',
      live: o.live,
      opens: o.history ? 'draft' : undefined,
    });
  }
  stages.push({
    key: 'end',
    label: o.verdict === 'discarded' ? 'Discarded' : 'Approved',
    state: o.sealed ? 'done' : '',
  });
  return stages;
}

function finishedStage(
  r: RoundView,
  number: number,
  o: { history: boolean; reading: number },
): RoundStage {
  const could = r.reason === COULD_NOT;
  const asked = asksOf(r).length;
  let state: RoundStage['state'] = could
    ? 'flagged'
    : r.answers > 0
      ? 'done'
      : '';
  if (o.history && o.reading === r.n) {
    state = 'now';
  }
  return {
    key: `round-${number}`,
    label: `Round ${number}`,
    count: could
      ? 'could not'
      : asked > 0
        ? plural(asked, 'instruction')
        : undefined,
    state,
    opens: String(r.n),
  };
}
