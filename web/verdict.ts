// verdict.ts — the verdict: what it is, and the controls that set it.
//
// A REVIEW HAS ONE QUESTION ON OFFER AT A TIME. The top half of this file is
// the pure vocabulary for asking and answering it — markup pending means the
// verdict on offer is Revise, a clean document means it is Approve, a sealed
// review's verdict is one of three fixed outcomes — every label, every button
// string and every enum value that says which of those states is true, with
// no `this` and no DOM. probe.mjs imports it from here directly: a
// browserless test can drive vocabulary.
//
// THE BOTTOM HALF, `verdictMethods`, IS A MIXIN — an object of methods
// `Object.assign`ed onto `App.prototype` in entry.ts, not a class of its own
// — and it is Revise on the kit's send bar (`#gly-revise`), Discard drafts, the
// bar's primary, the menu Approve discloses when work is pending
// (Revise & Approve), the poll response that drives all three
// (readRevise — which also drives History's and the seal's own readers, see
// its own comment), and hold/release, the browser-side queue over what the
// rail shows while the mode is live. One file owns one subject — the
// verdict, what it is and the controls that set it — rather than splitting
// the noun from the verb.
//
// `this` IS TYPED AGAINST `AppShell` (web/appshell.ts) — see that file's own
// header for the this-typing decision.

import type { PendingThread } from './tabs.ts';
import { getJSON, postJSON, routes } from './net.ts';
import { runFor } from './runs.ts';
import { arrivalMessage, queueArrivals, holdLabel } from './arrivals.ts';
import {
  agentHolds,
  draftCountWords,
  messageLine,
  primaryWords,
  roundStages,
  sendFace,
} from './roundbar.ts';
import { STAGE_READING } from './versions.ts';
import type { AppShell, ArrivalItem } from './appshell.ts';
import type { ReviseStateView } from './wire';
import { messagePill } from './kit/dom.js';
import type { SuggestionLike } from './suggestions.ts';

// The full shape of what GET /_galley/revise answers.
//
// IT IS THE GENERATED TYPE NOW, not a hand-copy of it. This block used to
// restate all thirteen fields and explain why it had to: "Not in wire.d.ts —
// that file is generated only from the five view structs
// internal/serve/wire_test.go names, and `/_galley/revise` answers with a
// hand-built `map[string]any`." Both halves of that are fixed rather than
// documented: the server answers `ReviseStateView` and the struct is in
// `wireRoots`, so a rename on either side now fails `just verify` instead of
// arriving in a browser as `undefined`.
//
// `entrusted`, `outstanding`, `landing`, `reopenBy` and `reopenNote` stay
// declared here and stay OPTIONAL, and that is not caution — it is the literal
// wire shape. `writeReviseState` sets none of them, so they are undefined on
// every real payload; the entrusted-handoff vocabulary that sealLine and
// reopenLine still carry has no live server path. They are deliberately NOT in
// the Go struct: putting them there would generate a contract claiming the
// server sends fields it never sends, which is worse than the gap. Narrowing
// this is a product decision for whoever owns the handoff.
export interface ReviseWatchView extends ReviseStateView {
  entrusted?: number;
  outstanding?: number;
  landing?: number;
  reopenBy?: string;
  reopenNote?: string;
}

/** What the verdict is while markup is pending. `verdict` holds it, and a press
 * of Approve then offers Revise & Approve rather than sealing over the work. */
export const REVISE_IDLE = 'Revise';

/** The line under a held Revise's pill: the harness is holding the wake
 * because the agent is mid-turn. */
/** The line under a Revise's pill: the agent's note, or the mid-turn line
 * while the harness holds it. */
/**
 * reviseSeconds is R10: Revise says how long it has been, until the revision
 * LANDS. Whole seconds, floored; a clock that skewed backwards reads 0.
 *
 * @param ms how long since Revise was pressed
 */
function reviseSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

/** What the verdict is on a clean document, and the bar's primary. */
export const APPROVE_IDLE = 'Approve';

// How long Discard stays armed after its first press, as delete and revert do.
const DISCARD_ARM_MS = 4000;

/** What Approve offers over a document with work still pending. */
export const MENU_TRUST = 'Revise & Approve';

/** The verdicts the server can seal a review with that the seal paints apart.
 * The third, `approved`, is sealLine's default branch and needs no name. */
export const VERDICT_ENTRUSTED = 'approved-entrusted';
export const VERDICT_DISCARDED = 'discarded';

/** clockTime renders a verdict's moment as the reviewer reads a clock. The
 * DATE is deliberately absent: a seal is read in the session that produced it,
 * and a page still open tomorrow is a page whose server is long gone. */
export function clockTime(ms: number): string {
  if (!ms) {
    return '';
  }
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// What verdictLabel reads: the two shapes /_galley/pending has answered with
// (a rounds-only `{instructions}` payload, or the older `{comments}` shape
// censusCounts reduces), loosened to the fields this function itself touches.
// `comments` reuses tabs.ts's own exported `PendingThread` rather than a
// hand-rolled copy of it — see tabs.ts's header on why that type is exported
// at all — and censusCounts' declared parameter type is what this is checked
// against, so a drift there is a compile error here rather than a silent
// disagreement.
type VerdictView = {
  instructions?: { text?: string }[] | null;
  comments?: PendingThread[];
  changes?: { kind?: string }[];
};

/**
 * verdictLabel is the button reading the document's state. Markup pending
 * means the verdict on offer is Revise; a clean document means it is Approve.
 * The label is a PRE-FLIGHT indicator on purpose: a reviewer who just made
 * markup and still sees Approve is looking at the lost-markup failure before
 * pressing, not diagnosing it afterwards.
 *
 * It reads censusCounts, the same reduction the strip shows, rather than
 * counting the raw list itself — one rule, not a second one that agrees for
 * now.
 *
 * THE REVIEWER'S OWN HAND EDITS ARE MARKUP TOO. `view.changes` is what the
 * reviewer altered by hand since the last round (refreshPending), and it is
 * outgoing work exactly as an instruction is: a Revise hands it to the agent.
 * Left out, the button read Approve over unsent edits — and Approve seals the
 * review without recording them as a round, so the very failure this pre-flight
 * label exists to show (markup pending, but the press says it is clean) was the
 * one case it missed. A pending change now offers Revise in both branches.
 */
export function verdictLabel(view: VerdictView | null | undefined): string {
  const changes = view && view.changes;
  const hasChanges = Array.isArray(changes) && changes.length > 0;
  const instructions = view && view.instructions;
  if (Array.isArray(instructions)) {
    return instructions.length > 0 || hasChanges ? REVISE_IDLE : APPROVE_IDLE;
  }
  const threads = (view && view.comments) || [];
  return threads.length > 0 || hasChanges ? REVISE_IDLE : APPROVE_IDLE;
}

// The body postVerdict sends. `verdict`/`approveOnAnswer` are the two real
// shapes the three call sites build; `trust` is read below (`body.trust`)
// but no call site here ever sets it — see postVerdict's own note on why
// that branch is currently dead, and left rather than deleted.
type VerdictBody = {
  verdict?: string;
  approveOnAnswer?: boolean;
  trust?: boolean;
};

export const verdictMethods = {
  paintHold(this: AppShell) {
    const { hold, holdOff, holdOn } = this.modeUI;
    // Both labels are written on every paint and both stay laid out — see
    // makeMode. Only which of them is VISIBLE changes, so the button's width
    // is the wider of the two whatever state it is in.
    holdOff.textContent = holdLabel(false, 0);
    holdOn.textContent = holdLabel(true, this.heldArrivals.length);
    holdOff.classList.toggle('gly-reserved', this.holding);
    holdOn.classList.toggle('gly-reserved', !this.holding);
    hold.title = this.holding
      ? 'show the arrivals that landed while you were holding — they are already in the document'
      : 'keep new arrivals quiet — they still land in the document, they just wait';
    hold.classList.toggle('gly-on', this.holding);
  },

  // --- Revise, on the kit's send bar, and how long it has been (R10) ---
  //
  // shell.ts builds the bar and gives its buttons ids. Null in a shell without it.
  makeRevise(this: AppShell): HTMLButtonElement | null {
    const el = document.getElementById('gly-revise');
    if (!(el instanceof HTMLButtonElement)) {
      return null;
    }
    // WHERE THE LAST REVISE STANDS, beside the draft count: it changes on the
    // agent's and the harness's word, so nothing to its right is pushed by it.
    const msg = document.createElement('span');
    msg.className = 'gly-msg';
    document.getElementById('gly-drafts')?.after(msg);
    this.reviseMsg = msg;
    el.addEventListener('click', () => this.pressSend());
    return el;
  },

  pressSend(this: AppShell) {
    if (!this.revise || this.revise.disabled) {
      return;
    }
    this.closeVerdictMenu();
    this.postVerdict({}, false);
  },

  // Discard drafts clears the round's unsent instructions, armed in two steps
  // like the other verbs that throw work away. The armed flag and its clock are
  // read on the press, and the timer repaints the label back.
  makeDiscard(this: AppShell): HTMLButtonElement | null {
    const el = document.getElementById('gly-discard');
    if (!(el instanceof HTMLButtonElement)) {
      return null;
    }
    el.addEventListener('click', () => {
      if (el.disabled) {
        return;
      }
      if (Date.now() - this.discardArmedAt >= DISCARD_ARM_MS) {
        this.discardArmedAt = Date.now();
        const at = this.discardArmedAt;
        window.setTimeout(() => {
          if (this.discardArmedAt === at) {
            this.discardArmedAt = 0;
            this.paintDiscard();
          }
        }, DISCARD_ARM_MS);
        this.paintDiscard();
        return;
      }
      this.discardArmedAt = 0;
      this.discardDrafts();
    });
    return el;
  },

  // One delete per instruction, through the route a card's own delete uses. A
  // refusal says so and the next read shows what is left.
  discardDrafts(this: AppShell) {
    const keys = this.comments.map((c) => c.key).filter(Boolean);
    this.discarding = true;
    this.paintDiscard();
    void Promise.all(
      keys.map((key) => postJSON(routes.instructionDelete, { key })),
    )
      .then((all) => {
        const refused = all.filter((r) => !r.ok).length;
        this.say(
          refused
            ? `${refused} of ${keys.length} drafts could not be discarded`
            : 'drafts discarded',
        );
      })
      .catch((err) => this.say(`discard failed: ${err}`))
      .then(() => {
        this.discarding = false;
        return this.refreshPending();
      });
  },

  paintDiscard(this: AppShell) {
    const count = document.getElementById('gly-drafts');
    if (count) {
      count.textContent = this.sealed
        ? ''
        : draftCountWords(this.pendingCount, this.editCount);
    }
    const b = this.discardBtn;
    if (!b) {
      return;
    }
    const n = this.pendingCount;
    const armed = n > 0 && Date.now() - this.discardArmedAt < DISCARD_ARM_MS;
    b.textContent = armed
      ? `Discard ${n} draft${n === 1 ? '' : 's'}?`
      : 'Discard drafts';
    b.classList.toggle('danger', armed);
    b.disabled = n === 0 || !!this.sealed || this.discarding;
  },

  // paintChrome draws what the shell owns, from the state the editor reads off
  // its polls. Absent in a shell without the kit (probe.mjs's).
  paintChrome(this: AppShell) {
    const chrome = window.galleyChrome;
    const panel = this.versionsPanel;
    if (!chrome || !panel) {
      return;
    }
    const state = {
      handoff: !!this.handoff,
      waiting: this.reviseWaiting,
      message: this.reviseMessage,
    };
    const sealed = !!this.sealed || this.approved;
    chrome.paintPrimary(
      primaryWords({ ...state, history: panel.open, sealed }),
    );
    chrome.paintStages(
      roundStages({
        rounds: panel.rounds,
        drafts: this.pendingCount,
        live: !sealed && agentHolds(state),
        sealed,
        verdict: this.sealVerdict,
        reading:
          panel.open && panel.stage === STAGE_READING ? panel.selected : 0,
        history: panel.open,
      }),
      (opens) => this.openStage(opens),
      this.versionsButton,
    );
    this.paintChat();
  },

  // askRevise is the PRIMARY's press, and it only decides. In History it is the
  // way out. On a clean document it approves. With work pending it DISCLOSES
  // Revise & Approve instead, so a press can never seal over unsent work; plain
  // Revise is the send bar's. The posting, with its status lines and its 409
  // grammar, lives in postVerdict below.
  askRevise(this: AppShell) {
    if (this.versionsPanel && this.versionsPanel.open) {
      this.toggleVersions();
      return;
    }
    if (this.approved || this.approving) {
      return;
    }
    if (this.verdict === APPROVE_IDLE) {
      if (Date.now() < this.approveNotBefore) {
        return;
      }
      this.postVerdict({ verdict: 'approve' }, true);
      return;
    }
    if (this.verdictOpen) {
      this.closeVerdictMenu();
    } else {
      this.openVerdictMenu();
    }
  },

  postVerdict(this: AppShell, body: VerdictBody, approving: boolean) {
    // Genuinely nullable: a shell without the send bar has no `#gly-revise`.
    const revise = this.revise;
    if (!revise) {
      return;
    }
    this.approving = approving;
    if (!approving) {
      // Arm before the request: polling can observe the cleared round and flip
      // this same control to Approve before the response callback runs.
      this.approveNotBefore = Date.now() + 1000;
      window.setTimeout(() => this.paintRevise(), 1000);
    }
    // Disabled for the round trip so an impatient double-click cannot ask for
    // a second revision the server would only refuse with 409. The server's
    // single-flight check is the real guard; this keeps the ordinary case from
    // reaching it. paintRevise takes over once the state comes back.
    revise.disabled = true;
    this.say(approving ? 'approving…' : 'requesting a revision…');
    // Fire-and-forget by design: the chain already ends in a `.catch` that
    // reports failure through `say`, which the reviewer is already looking
    // at because this press just wrote to it ('approving…' / 'requesting a
    // revision…'). A caller of `postVerdict` cannot await it without going
    // async itself for no benefit — the click handler already returned.
    void postJSON(routes.revise, body)
      .then((res) => {
        if (res.status === 204) {
          if (approving) {
            // EARNED: only after the server took the verdict does the primary
            // leave the bar. The review is over.
            this.approved = true;
            // The verdict retires the trail: the server wiped its copy in the
            // same act that took the approve, and this page's ghosts,
            // highlights and log go with it.
            this.clearTrail();
            // THE TRUST EXIT IS AN APPROVE THAT IS NOT AN ENDING, and this
            // line said it was for ANY approving press — one line under a menu
            // item whose own title reads "surviving unanswered notes travel to
            // the agent". It flashes rather than sticks (applySeal's say('')
            // clears it a poll later) which is why it is milder than the same
            // wrong sentence on the CLI, but it is the same wrong sentence.
            // The branch is `body.trust`, which is what the reviewer pressed;
            // the seal that arrives a poll later says the same thing in the
            // terminal bar, with the counts.
            //
            // `body.trust` IS NEVER SET BY ANY CALL SITE BELOW — a dead
            // branch, left rather than deleted per this migration's own rule:
            // typing proves it unreachable today, and a fix belongs to
            // whoever wires the trust exit's own request body, not to this
            // conversion.
            this.say(
              body.trust
                ? 'approved — your remaining notes travel to the agent'
                : 'approved — the review is over',
            );
            this.refreshVersions();
            return null;
          }
          this.say('revision requested');
          // The round is sent, so a whole-document composer left open over the
          // rail is a draft with nowhere to go: its text was never part of
          // what just went to the agent (only FILED instructions travel), and
          // leaving it open reads as pending work that is not. Close it and
          // discard — openCapture clears the box on the next open.
          // AND THE TRAIL SETTLES ON SEND. The reviewer's hand edits were the
          // round's outgoing message; pressing Revise hands them off, so the
          // ghosts and glows that were "what am I about to tell the agent"
          // have said it. Left standing they re-anchor onto the agent's
          // rebuilt document — where the edit is already baseline text — and
          // render as a stale pending change over prose nobody is going to act
          // on again. clearTrail here is the same wipe approve does, at the
          // other verdict: the record now lives in the round (versions +
          // ledger), not in live decorations. The server keeps no trail to
          // re-hydrate on reload (ReviewerChanges is computed from versions),
          // so this client wipe is the whole of it.
          this.clearTrail();
          this.refreshVersions();
          return this.refreshPending();
        }
        // 409 means two different things by verb. Revising: a revision is
        // ALREADY running, which is what asking for one wanted — `galley
        // revise` says exactly this from the command line; the two must not
        // disagree about what happened. Approving: markup landed between the
        // label's last paint and the press, the server refused ("there is
        // markup pending"), and the verdict on offer has flipped.
        if (res.status === 409) {
          this.say(
            approving
              ? 'markup arrived while approving — the verdict is Revise now'
              : 'a revision is already in flight — it will act on whatever is pending when it finishes',
          );
          return null;
        }
        return res.text().then((text) => {
          this.say(
            `${approving ? 'approve' : 'revise'} failed: ${text.trim() || res.status}`,
          );
        });
      })
      .catch((err) => {
        this.say(`${approving ? 'approve' : 'revise'} failed: ${err}`);
      })
      .then(() => {
        this.approving = false;
        return this.readRevise();
      });
  },

  // --- the verdict menu ---
  //
  // A DISCLOSURE, and every rule that travels with one is load-bearing here.
  // It appends to document.body — NEVER inside .ProseMirror, where anything
  // appended becomes CONTENT and the next projection writes it into the .md
  // (measured: a fixture went from 1 pending to 81) — and it is positioned
  // absolutely off the button's rect MEASURED at open time, because the bar
  // folds and its height is not a constant. It COVERS whatever is under it
  // and displaces nothing; the button itself does not move or change on the
  // opening press — the menu is the thing the press created. Esc closes it
  // the way Esc closes every other surface (see onKey), outside-click closes
  // it, and so does a scroll or a resize, the bubble's reasons: the bar is
  // sticky, so the page moving under an absolutely-positioned menu leaves it
  // anchored to nothing.
  makeVerdictMenu(this: AppShell): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gly-verdict-menu';
    el.hidden = true;
    el.setAttribute('role', 'menu');
    const trust = document.createElement('button');
    trust.type = 'button';
    trust.className = 'gly-verdict-trust';
    trust.textContent = MENU_TRUST;
    trust.title =
      'send these instructions and approve only after the agent successfully applies them';
    trust.addEventListener('click', () => {
      this.closeVerdictMenu();
      this.postVerdict({ approveOnAnswer: true }, false);
    });
    el.append(trust);
    document.body.appendChild(el);
    // Outside-click closes, in capture so it runs whatever the click lands
    // on. The button is NOT "outside": askRevise owns the toggle, and closing
    // here too would reopen on the same press (see the note there).
    document.addEventListener(
      'click',
      (event) => {
        if (
          !this.verdictOpen ||
          (event.target instanceof Node && el.contains(event.target))
        ) {
          return;
        }
        if (
          event.target instanceof Element &&
          event.target.closest('.kit-primary')
        ) {
          return;
        }
        this.closeVerdictMenu();
      },
      true,
    );
    // Same shape as the bubble's scroll listener, same reason to read the
    // event: scroll does not bubble, capture on window hears everything, and
    // only the page moving under the menu makes its position stale.
    window.addEventListener(
      'scroll',
      (event) => {
        if (!this.verdictOpen) {
          return;
        }
        if (event.target instanceof Node && el.contains(event.target)) {
          return;
        }
        this.closeVerdictMenu();
      },
      true,
    );
    window.addEventListener('resize', () => this.closeVerdictMenu());
    return el;
  },

  openVerdictMenu(this: AppShell) {
    // Off the bar's primary, which is what was pressed.
    const anchor = document.querySelector('.kit-primary');
    if (!anchor) {
      return;
    }
    if (!this.verdictMenu) {
      this.verdictMenu = this.makeVerdictMenu();
    }
    const menu = this.verdictMenu;
    // Position FIRST, from the button's own rect read at open time — the
    // refusal note's discipline: an element unhidden with a stale inline
    // position appears somewhere the button is not. Unhide before measuring
    // the menu's own width, because a hidden box measures zero.
    const rect = anchor.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    // Right-aligned under the button: the primary is the rightmost control in
    // the bar, so the menu grows leftward over the page rather than off its edge.
    menu.style.left = `${Math.max(4, rect.right + window.scrollX - menu.offsetWidth)}px`;
    this.verdictOpen = true;
  },

  closeVerdictMenu(this: AppShell) {
    if (this.verdictMenu) {
      this.verdictMenu.hidden = true;
    }
    this.verdictOpen = false;
  },

  readRevise(this: AppShell) {
    return getJSON<ReviseWatchView>(routes.revise)
      .then((d) => {
        if (!d) {
          return;
        }
        this.reviseWaiting = !!d.waiting;
        this.reviseRunning = !!d.running;
        // Anchored to a local instant derived from the server's elapsed time,
        // so the seconds keep climbing between polls without this page having
        // to trust its own clock against the server's.
        this.reviseStartedAt = Date.now() - (d.sinceMs || 0);
        this.reviseMessage = d.message ?? null;
        this.paintRevise();
        this.readArrival(d);
        this.readSeal(d);
        this.readHandoff(d);
        // Again once the seal is read: a sealed page shows no pill.
        this.paintMessage();
      })
      .catch(() => {});
  },

  // paintMessage fills the cell beside Revise with the kit's pill for the last
  // Revise and the line under it, laid out in a row (editor.css) so the bar
  // stays one line, with the whole line as the cell's title. Empty with no
  // message, on a sealed page, and while History owns the primary.
  paintMessage(this: AppShell) {
    const cell = this.reviseMsg;
    if (!cell) {
      return;
    }
    const m = this.reviseMessage;
    const history = !!(this.versionsPanel && this.versionsPanel.open);
    cell.textContent = '';
    cell.title = '';
    if (!m || this.sealed || history) {
      return;
    }
    const line = messageLine(m);
    cell.append(messagePill(m.state, line));
    cell.title = line;
  },

  paintRevise(this: AppShell) {
    const revise = this.revise;
    if (!revise) {
      return;
    }
    const ms = this.reviseWaiting ? Date.now() - this.reviseStartedAt : 0;
    const face = sendFace({
      drafts: this.pendingCount,
      edits: this.editCount,
      waiting: this.reviseWaiting,
      message: this.reviseMessage,
      running: this.reviseRunning,
      cooling: Date.now() < this.approveNotBefore,
      seconds: reviseSeconds(ms),
    });
    revise.textContent = face.label;
    revise.disabled = face.disabled || this.approved;
    revise.title = face.title;
    this.paintDiscard();
    this.paintMessage();
    this.paintChrome();
  },

  // --- hold and release ---
  //
  // HOLD IS A BROWSER-SIDE QUEUE OVER WHAT THE RAIL DISPLAYS, NOT A
  // SERVER-SIDE GATE ON THE DOCUMENT. The suggestions are in the CRDT and on
  // disk either way, and pretending otherwise would mean the file and the
  // screen disagreeing about what the document contains. A held arrival is a
  // CARD NOT YET SHOWN, never a suggestion not yet made — and the opposite
  // reading is the intuitive one, which is why it is said here and again in
  // arrivals.ts.
  toggleHold(this: AppShell) {
    if (this.holding) {
      this.release();
      return;
    }
    this.holding = true;
    this.paintHold();
  },

  // withhold takes the arrivals out of the rail's hands and returns what is
  // left to announce — which is nothing, by construction. The section is
  // resolved HERE rather than at release, because by then the document has
  // moved on and the heading an arrival landed under may not be the heading it
  // is under any more.
  withhold(this: AppShell, arrived: ArrivalItem[]): ArrivalItem[] {
    const runs = this.runsNow();
    for (const a of arrived) {
      if (a.run) {
        this.held.add(a.run);
      }
    }
    this.heldArrivals = queueArrivals(
      this.heldArrivals,
      arrived.map((a): ArrivalItem => {
        // `a` is the loose arrival shape, not a full SuggestionLike (it
        // carries no `text`) — runFor only ever reads `kind`/`author` off it
        // through sameSuggestion, which is exactly what this reconstructs.
        // Same pattern as pending.ts's noticeArrivals, for the same reason.
        const suggestion: SuggestionLike = {
          kind: a.kind || '',
          run: a.run,
          author: a.author,
        };
        return {
          ...a,
          section: this.sectionFor(runFor(runs, { run: a.run, suggestion })),
        };
      }),
    );
    return [];
  },

  release(this: AppShell) {
    const batch = this.heldArrivals;
    this.holding = false;
    this.held.clear();
    this.heldArrivals = [];
    for (const a of batch) {
      if (a.run) {
        this.newRuns.add(a.run);
      }
    }
    this.paintMode();
    this.paintTabs();
    if (batch.length === 0) {
      return;
    }
    // One summary for the batch, not one strip per arrival — the reviewer
    // asked to be told all at once, which is what holding meant.
    this.arrivalQueue = queueArrivals(this.arrivalQueue, batch);
    this.stripBatch = batch;
    this.showStrip(arrivalMessage(batch));
    this.clearNewLater();
  },
};
