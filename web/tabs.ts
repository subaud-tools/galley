// tabs.ts — the right column's two tabs, as values: Instructions (the round's
// drafts on the text and the reviewer's hand edits) and Chat (the whole document:
// its drafts, each Revise sent and the agent's answer). shell.ts draws them with
// the kit's parts; everything here runs in node, so probe.mjs drives it.
//
// The kit holds what is being typed, so nothing here rebuilds a box. A draft saves
// on blur or Enter through /_galley/instruct. A hand edit is not a draft: its one
// verb is Revert, and it is not sent as an instruction, but it does go with the
// round, so the tab counts it.
//
// Chat reads the record, /_galley/versions: a round keeps what was asked and what
// the agent said, so earlier answers are there. A message's state is the server's
// only for the last Revise. Earlier ones are worked out from their round.

import { postJSON, routes } from './net.ts';
import { COULD_NOT } from './versions.ts';
import { asksOf, messageLine, trackCards } from './roundbar.ts';
import { revealMark } from './card.ts';
import { runFor, markElement } from './runs.ts';
import type { AppShell, Thread } from './appshell.ts';
import type { MessageView, ReviewerChange, RoundView } from './wire';

/** Who the reviewer is on the wire. The agent is always "agent". */
export const AUTHOR = 'court';

export type PendingThreadEntry = {
  author?: string;
  text?: string;
};

export type PendingThread = {
  anchor?: string;
  anchorKey?: string;
  run?: string;
  region?: object | null;
  blockKind?: string;
  heading?: string;
  entries?: PendingThreadEntry[];
};

// --- small things the rest of the editor shares ---

/** The next run, wrapping, or the first (or last, going back) from nowhere. */
export function stepPending(
  runs: string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (runs.length === 0) {
    return null;
  }
  const at = current === null ? -1 : runs.indexOf(current);
  if (at === -1) {
    return direction < 0 ? runs[runs.length - 1] : runs[0];
  }
  return runs[(at + direction + runs.length) % runs.length];
}

/** Whether a key press belongs to a field rather than to the page. */
export function keyTargetIsEditable(el: unknown): boolean {
  if (!el || typeof el !== 'object') {
    return false;
  }
  if ('isContentEditable' in el && el.isContentEditable) {
    return true;
  }
  const tag =
    'tagName' in el && typeof el.tagName === 'string'
      ? el.tagName.toLowerCase()
      : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Makes a box as tall as its words, up to whatever cap the stylesheet sets. */
export function growOnInput(field: HTMLTextAreaElement): HTMLTextAreaElement {
  const fit = () => {
    field.style.height = 'auto';
    const want = field.scrollHeight;
    const edge = field.offsetHeight - field.clientHeight;
    field.style.height = `${want + (edge > 0 ? edge : 0)}px`;
    field.style.overflowY = field.clientHeight < want ? 'auto' : 'hidden';
  };
  field.addEventListener('input', fit);
  return field;
}

/** How much of an anchor a one-line head quotes. */
export const HEAD_QUOTE_CHARS = 44;

export function elide(said: string, max: number = HEAD_QUOTE_CHARS): string {
  const flat = (said || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// --- what an instruction is on ---

/** What a draft row says it is on. */
export function threadLabel(
  thread:
    | {
        anchor?: string;
        heading?: string;
        blockKind?: string;
        region?: object | null;
      }
    | null
    | undefined,
): string {
  const t = thread || {};
  const heading = t.heading || '';
  if (t.anchor === 'document') {
    return 'Whole document';
  }
  if (t.anchor === 'block') {
    if (t.region) {
      return 'On a region of the figure';
    }
    if (t.blockKind === 'heading') {
      return `On §${elide(heading.replace(/^#+\s*/, ''))}`;
    }
    return `On ${elide(heading) || 'a block'}`;
  }
  return heading ? `“${heading}”` : 'An instruction';
}

/** Where a draft's words are in the document, if they still are. */
export function threadPlacement(
  thread:
    { run?: string; anchor?: string; anchorKey?: string } | null | undefined,
  blocks: { key: string; index: number }[] | null | undefined,
): { where: 'mark' | 'block' | 'anchorless'; run: string; index: number } {
  const t = thread || {};
  if (t.run) {
    return { where: 'mark', run: t.run, index: -1 };
  }
  if (t.anchor === 'block' && t.anchorKey) {
    const block = (blocks || []).find((b) => b && b.key === t.anchorKey);
    if (block && Number.isFinite(block.index) && block.index >= 0) {
      return { where: 'block', run: '', index: block.index };
    }
  }
  return { where: 'anchorless', run: '', index: -1 };
}

/** The drafts about the whole document, which the Chat tab holds. */
export function overallThreads<T extends PendingThread>(
  threads: T[] | null | undefined,
): T[] {
  return (threads || []).filter((t) => t.anchor === 'document');
}

/** The drafts on the text, which the Instructions tab holds. */
export function textThreads<T extends PendingThread>(
  threads: T[] | null | undefined,
): T[] {
  return (threads || []).filter((t) => t.anchor !== 'document');
}

// --- the rows ---

const DRAFT_META = 'draft · goes with the next Revise';
const UNPLACED_META = `${DRAFT_META} · its words were removed`;

export interface DraftRowValue {
  id: string;
  quote: string;
  text: string;
  meta: string;
}

// The server lists drafts in no fixed order, and a row that moved on a save
// would take the reader's place with it: the order they were filed in.
function filed(threads: Thread[]): Thread[] {
  const at = (t: Thread) => (t.entries[0] && t.entries[0].at) || '';
  return threads
    .slice()
    .sort((a, b) => at(a).localeCompare(at(b)) || a.key.localeCompare(b.key));
}

function draftValue(t: Thread, meta: string): DraftRowValue {
  return {
    id: t.key,
    quote: threadLabel(t),
    text: (t.entries[0] && t.entries[0].text) || '',
    meta,
  };
}

/** The Instructions tab's rows, one per draft on the text. */
export function textDrafts(
  threads: Thread[] | null | undefined,
  blocks: { key: string; index: number }[] | null | undefined,
): DraftRowValue[] {
  return filed(textThreads(threads)).map((t) =>
    draftValue(
      t,
      threadPlacement(t, blocks).where === 'anchorless'
        ? UNPLACED_META
        : DRAFT_META,
    ),
  );
}

/** The Chat tab's draft rows. */
export function chatDrafts(
  threads: Thread[] | null | undefined,
): DraftRowValue[] {
  return filed(overallThreads(threads)).map((t) => draftValue(t, DRAFT_META));
}

export interface EditRowValue {
  // Empty on an edit that can't be put back: it has no Revert.
  key: string;
  head: string;
  before: string;
  after: string;
  armed: boolean;
}

/** The Instructions tab's "your edit" rows. */
export function editRows(
  changes: ReviewerChange[] | null | undefined,
  armed: string | null,
): EditRowValue[] {
  return (changes || []).map((c) => ({
    key: c.key || '',
    head: `your edit · ${c.kind}`,
    before: c.before || '',
    after: c.after || '',
    armed: !!c.key && c.key === armed,
  }));
}

/** What each tab counts: its drafts, and in Instructions the hand edits too. */
export function tabCounts(
  threads: Thread[] | null | undefined,
  changes: ReviewerChange[] | null | undefined,
): { instructions: number; chat: number } {
  return {
    instructions: textThreads(threads).length + (changes || []).length,
    chat: overallThreads(threads).length,
  };
}

// --- the Chat tab's messages ---

export interface ChatMessage {
  id: string;
  from: 'court' | 'agent';
  at: string;
  words: string;
  state?: string;
  stateLine?: string;
  text: string;
}

const COULD_NOT_PREFIX = /^could not:\s*/;
const REFUSED = new Set(['declined', 'failed']);

function sentWords(asks: string[]): string {
  if (asks.length === 0) {
    return 'Your hand edits, with no instruction.';
  }
  if (asks.length === 1) {
    return `1 instruction sent:\n${asks[0]}`;
  }
  return `${asks.length} instructions sent:\n${asks.map((a) => `· ${a}`).join('\n')}`;
}

/** Where an earlier Revise stood, from its round alone; none when it can't be told. */
function recordedState(card: RoundView, could: boolean): string | undefined {
  if (could) {
    return 'failed';
  }
  return card.answers > 0 && (card.instruction || card.changed > 0)
    ? 'answered'
    : undefined;
}

function agentMessage(
  card: RoundView,
  number: number,
  live: MessageView | null,
  could: boolean,
): ChatMessage | null {
  const said = could
    ? card.instruction.replace(COULD_NOT_PREFIX, '')
    : card.answers > 0
      ? card.instruction
      : '';
  const refused = live && REFUSED.has(live.state) ? live : null;
  const text =
    said ||
    (refused && refused.line) ||
    (card.answers > 0 && card.changed > 0
      ? 'Answered by revising the document. The changes are in History.'
      : '');
  if (!text) {
    return null;
  }
  return {
    id: `answer-${card.n}`,
    from: 'agent',
    at: card.at,
    words: could
      ? `round ${number}: could not`
      : `round ${number} ${refused ? refused.state : 'answered'}`,
    text,
  };
}

/**
 * Each Revise and its answer, oldest first, numbered as the stage track numbers
 * them. message is the server's word on the last Revise, and that is the only one
 * it keeps: a round from before it says what its record can.
 */
export function chatMessages(
  rounds: RoundView[] | null | undefined,
  message: MessageView | null | undefined,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const cards = trackCards(rounds);
  cards.forEach((card, i) => {
    const asks = asksOf(card);
    const number = i + 1;
    const could = card.reason === COULD_NOT;
    // A file changed outside the editor: nobody asked and nobody answered.
    if (card.answers === 0 && asks.length === 0) {
      return;
    }
    const live = i === cards.length - 1 && message ? message : null;
    const asking = (rounds || []).find((r) => r.n === card.answers);
    const answer = agentMessage(card, number, live, could);
    out.push({
      id: `sent-${card.n}`,
      from: 'court',
      at: (asking || card).at,
      words: `Revise · round ${number}`,
      state: live ? live.state : recordedState(card, could),
      // The agent's words are its own message when it has one: not said twice.
      stateLine: live && !answer ? messageLine(live) : undefined,
      text: sentWords(asks),
    });
    if (answer) {
      out.push(answer);
    }
  });
  return out;
}

// --- what a stranded edit keeps ---

/** An edit whose instruction left goes to the Chat box: its words, after any already there. */
export function strandedValue(had: string, words: string): string | null {
  const keep = words.trim();
  const before = had.trimEnd();
  if (!keep || before.endsWith(keep)) {
    return null;
  }
  return before ? `${before}\n\n${keep}` : keep;
}

/** What the Chat box holds once `filed` is with the server: what was typed after
 * it. Words the reader changed meanwhile aren't the ones filed, so they stay. */
export function afterFiled(now: string, filed: string): string {
  const had = now.trimStart();
  return had.startsWith(filed) ? had.slice(filed.length).trimStart() : now;
}

const STRANDED_EDIT =
  'that instruction was sent or deleted, so your edit went to the Chat box';
const REVERT_ARM_MS = 4000;

export const tabMethods = {
  // paintTabs draws the two tabs from the last read of the server. The kit's list
  // keeps a box being typed in, so this can run on every poll.
  paintTabs(this: AppShell) {
    window.galleyChrome?.paintDrafts({
      text: textDrafts(this.comments, this.blocks),
      chat: chatDrafts(this.comments),
      edits: editRows(this.changes, this.armedRevert),
      selected: this.selectedDraft,
      counts: tabCounts(this.comments, this.changes),
    });
    this.paintNoteWords();
    this.paintFigures();
    this.applySealedVerbs();
    this.paintLit();
    this.paintChat();
  },

  paintChat(this: AppShell) {
    window.galleyChrome?.paintChat(
      chatMessages(this.versionsPanel?.rounds, this.reviseMessage),
    );
  },

  // Everything the kit's rows and box can ask for, which needs the App.
  wireTabs(this: AppShell) {
    window.galleyChrome?.wireTabs({
      edit: (key, text) => this.editDraft(key, text),
      remove: (key) => this.deleteDraft(key),
      select: (key) => this.selectDraft(key),
      file: (text) => this.fileChat(text),
      revert: (key) => this.revertEdit(key),
      stranded: (words) => this.strandEdit(words),
    });
  },

  async editDraft(this: AppShell, key: string, text: string) {
    const next = text.trim();
    if (!next) {
      this.deleteDraft(key);
      return true;
    }
    try {
      const res = await postJSON(routes.instruct, {
        op: 'edit',
        key,
        text: next,
        author: AUTHOR,
      });
      if (res.status === 404) {
        this.strandEdit(next);
      } else if (!res.ok) {
        const said = await res.text();
        this.say(said.trim() || `that edit was not saved: ${res.status}`);
        return false;
      }
    } catch (err) {
      this.say(`that edit was not saved: ${String(err)}`);
      return false;
    }
    void this.refreshPending();
    return true;
  },

  strandEdit(this: AppShell, words: string) {
    window.galleyChrome?.keepInChat(words);
    this.say(STRANDED_EDIT);
  },

  deleteDraft(this: AppShell, key: string) {
    void postJSON(routes.instructionDelete, { key }).then((res) => {
      if (!res.ok) {
        void res.text().then((said) => {
          this.say(said.trim() || `that draft stays: ${res.status}`);
        });
      }
      return this.refreshPending();
    });
  },

  // A row was pressed, or focus moved into its box: show what it is on.
  selectDraft(this: AppShell, key: string) {
    this.selectedDraft = key;
    this.paintLit();
    if (this.versionsPanel.open) {
      return;
    }
    const thread = this.comments.find((t) => t.key === key);
    const at = threadPlacement(thread, this.blocks);
    if (at.where === 'mark') {
      this.reveal(at.run);
    } else if (at.where === 'block') {
      this.revealBlock(at.index);
    }
  },

  // A highlight, a pin or j/k named a draft: open its row.
  openDraft(this: AppShell, key: string) {
    this.selectedDraft = key;
    window.galleyChrome?.showRow(key);
    this.paintTabs();
  },

  fileChat(this: AppShell, text: string): Promise<boolean> {
    return postJSON(routes.instruct, {
      op: 'comment_document',
      text,
      author: AUTHOR,
    })
      .then((res) => {
        if (res.ok) {
          void this.refreshPending();
          return true;
        }
        return res.text().then((said) => {
          this.say(said.trim() || `that was not filed: ${res.status}`);
          return false;
        });
      })
      .catch((err) => {
        this.say(`that was not filed: ${err}`);
        return false;
      });
  },

  chatHolds(this: AppShell): boolean {
    return !!window.galleyChrome?.chatHolds();
  },

  // Revert drops the undo history, so it takes two presses.
  revertEdit(this: AppShell, key: string) {
    if (this.armedRevert !== key) {
      this.armedRevert = key;
      window.setTimeout(() => {
        if (this.armedRevert === key) {
          this.armedRevert = null;
          this.paintTabs();
        }
      }, REVERT_ARM_MS);
      this.paintTabs();
      return;
    }
    this.armedRevert = null;
    void postJSON(routes.revert, { key }).then((res) => {
      if (res.ok) {
        return this.refreshPending();
      }
      return res.text().then((said) => {
        this.say(said.trim() || 'that edit could not be put back');
        this.paintTabs();
      });
    });
  },

  // Scrolls an instruction's words into view and rings them.
  reveal(this: AppShell, run: string) {
    const found = runFor(this.runsNow(), { run, suggestion: null });
    const mark = found && markElement(this.editor.view, found);
    if (mark) {
      revealMark(mark);
    }
  },

  revealBlock(this: AppShell, index: number) {
    const view = this.editor.view;
    const doc = view.state.doc;
    if (!Number.isFinite(index) || index < 0 || index >= doc.childCount) {
      return;
    }
    let pos = 0;
    for (let i = 0; i < index; i += 1) {
      pos += doc.child(i).nodeSize;
    }
    const dom = view.nodeDOM(pos);
    if (dom instanceof Element) {
      revealMark(dom);
    }
  },
};
