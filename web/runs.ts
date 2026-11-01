// web/runs.ts owns matching a card to its run — the marked span it is
// about — and finding that run's element or position in the ProseMirror view:
// `runFor` answers the first question, `markElement` and `runTop` the second.
// All three are pure lookups over data the caller already has (a list of
// runs, a view), so nothing here reaches into an App instance; every caller
// passes what it needs.

import { sameSuggestion, loosePeer, CLASS_BY_KIND } from './suggestions.ts';
import type { SuggestionLike, SuggestionRun } from './suggestions.ts';
import type { EditorView } from '@tiptap/pm/view';

// runFor finds the marked run a card is about.
//
// BY ID WHEN THERE IS ONE ON BOTH SIDES, and that is the whole of phase 1b: two
// suggestions that read the same are two cards pointing at two places, with
// nothing to disambiguate.
//
// The fallback matters and was nearly lost. It was born when a suggestion the
// REVIEWER typed existed in the fragment as a mark with no run (runs are
// minted server-side), so matching strictly by id left every freshly-typed
// suggestion carded "not in the document yet" beside text plainly on screen —
// reproduced in the browser by typing four characters. Typed marks are gone
// (the reviewer's-hand cut), but the same shape survives for a mark loaded
// from a document the server has not stamped yet. sameSuggestion's (kind,
// text, author) fallback is exactly the documented path for a mark that has
// no id, so it is used here, restricted to runs that carry no id: a run that
// HAS one can only ever be matched by it, so this cannot re-introduce
// guessing between two identified marks.
//
// Ambiguity among un-identified runs is reported, never guessed: two candidates
// leave the card adrift rather than pointing at whichever came first.
export function runFor(
  runs: SuggestionRun[],
  card: { run?: string; suggestion: SuggestionLike | null },
): SuggestionRun | null {
  if (card.run) {
    const exact = runs.find((r) => r.runId === card.run);
    if (exact) {
      return exact;
    }
  }
  const peer = loosePeer(card.suggestion);
  if (!peer) {
    return null;
  }
  const loose = runs.filter((r) => !r.runId && sameSuggestion(r, peer));
  return loose.length === 1 ? loose[0] : null;
}

// markElement finds the DOM span rendering a run. `from + 1` rather than
// `from`: a position on the boundary resolves to the parent block, which is
// the whole paragraph — scrolling to that centres the wrong thing.
//
// `run` accepts null and answers null for it. Every real caller already
// guarded this by hand or by a ternary; the guard now lives here instead,
// which is a narrowing rather than a behaviour change — `run.from` on a null
// `run` used to throw INSIDE the try block below and be caught by it,
// returning null exactly as this explicit check does. Verified against every
// call site: keys.ts's step() still ternaries around it (harmless, not
// removed) and pending.ts's noticeArrivals calls straight through, which is
// the site this guard is actually for.
export function markElement(
  view: EditorView,
  run: SuggestionRun | null,
): Element | null {
  if (!run) {
    return null;
  }
  let at: ReturnType<EditorView['domAtPos']>;
  try {
    at = view.domAtPos(run.from + 1);
  } catch {
    return null;
  }
  const node = at.node;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!(el instanceof Element)) {
    return null;
  }
  return el.closest(`.${CLASS_BY_KIND[run.kind]}`) || el;
}

// --- reaching a run's position, for whoever needs one ---
//
// runTop has two callers that do not know about each other: card.ts places
// an instruction card beside its run, and pending.ts asks the same question
// to decide whether an arrival needs the strip. Neither owns the answer, so
// it lives here instead of travelling with either.

// runTop measures where a run starts, in VIEWPORT coordinates — which is what
// coordsAtPos already returns, and it stops there ON PURPOSE. The rail is
// document-tall now and its cards are placed in DOCUMENT coordinates, so a
// scroll offset does have to be added — ONCE, by paintAnchors, which adds the
// same `window.scrollY` to every measurement it takes in one pass. Adding it
// here as well would double it, and adding it here INSTEAD would put two
// readings of `scrollY` into one layout the moment this and blockTop were
// called across a frame boundary. One offset, one place.
//
// Only the run's START is measured. The old runRect measured both ends to
// decide whether any part of a wrapped run was on screen; nothing asks that
// question now, and a card belongs beside the line its mark BEGINS on.
export function runTop(
  view: EditorView,
  run: SuggestionRun | null,
): number | null {
  if (!run) {
    return null;
  }
  try {
    return view.coordsAtPos(run.from).top;
  } catch {
    // A position the view cannot place is a position with nothing to point at.
    return null;
  }
}
