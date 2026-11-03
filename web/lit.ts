import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { markRuns } from './suggestions.ts';

// LIGHTING THE TEXT — which words is this card about.
//
// THE LINE IS DELETED AND THE WORDS ANSWER INSTEAD. A connector was drawn from
// a card to its mark for two phases and failed twice for one reason: it was
// invented to bridge the gap when a card had DRIFTED from its mark, and it read
// as meaningful only because it was LONG. Once the rail scrolled with the
// document and cards sat beside their text the leg collapsed and what was left
// was a 26px stub crossing 7% of a 376px gutter, ending in empty page. Aimed at
// the card's MIDDLE instead it stopped striking horizontally and began sagging
// diagonally THROUGH the paragraph the reviewer is reading — measured at 250px
// of sag with the card and its mark 0px apart vertically, in the accent, which
// over prose reads as a strike. The gutter is too wide for a line to cross
// without becoming the loudest thing on the page, and the question the line
// answered — *which words is this about* — is answered better by the words
// changing. The user, after a mockup: *"1: light the text is fine."*
//
// IT HAS TO BE A DECORATION, and that is the whole reason this file exists.
// CLAUDE.md: a class on a ProseMirror-rendered element is not yours to keep.
// The obvious implementation — walk `[data-run]` and toggle a class — was what
// `.gly-note` was marked settled with once, and it was measured failing:
// ProseMirror rewrites those elements' attributes from the node on every
// redraw, and a redraw follows every server-side mutation, each of which
// replaces the whole document. The class lands and is wiped a moment later.
//
// The lit set is not in the document and must not be: it is where the pointer
// is. So it arrives as transaction META from the code that watches hover and
// focus, and this plugin holds it as view state — never as content.
export interface LitPluginState {
  runs: string[];
  decos: DecorationSet;
}

export const litKey = new PluginKey<LitPluginState>('glyLit');

// litDecorations lights every inline carrying one of `runs`.
//
// IT ASKS `markRuns` RATHER THAN WALKING MARKS ITSELF. That function is the ONE
// definition of "these inlines are one suggestion" the browser has — the bubble
// asks it, the rail asks it — and a second walk here would be this repository's
// most-repeated defect, a spelling that agrees for now.
export function litDecorations(doc: PMNode, runs: string[]): DecorationSet {
  const want = new Set((runs || []).filter(Boolean));
  if (!want.size) {
    return DecorationSet.empty;
  }
  const decos: Decoration[] = [];
  for (const run of markRuns(doc)) {
    if (want.has(run.runId)) {
      decos.push(Decoration.inline(run.from, run.to, { class: 'gly-lit' }));
    }
  }
  return DecorationSet.create(doc, decos);
}

export function litPlugin(): Plugin<LitPluginState> {
  return new Plugin<LitPluginState>({
    key: litKey,
    state: {
      init: (_, state) => ({ runs: [], decos: litDecorations(state.doc, []) }),
      apply(tr: Transaction, prev: LitPluginState): LitPluginState {
        // `Transaction.getMeta` is typed `any` by prosemirror-state's own
        // declaration (the same fact web/trail.ts's own apply() states); `meta`
        // is read once and narrowed with a real check — Array.isArray plus an
        // element check — rather than trusted at that type. paintLit
        // (web/entry.ts) is this plugin's one setter and always passes a real
        // `string[]` (empty or one run), never anything else, so the narrowed
        // branch is the only one a real transaction ever takes.
        const meta: unknown = tr.getMeta(litKey);
        const next =
          Array.isArray(meta) && meta.every((r) => typeof r === 'string')
            ? meta
            : null;
        // A DOC CHANGE RE-DERIVES RATHER THAN CLEARING. Every server-side
        // mutation replaces the whole document, so the positions this set was
        // built from are gone — but the pointer has not moved, and a light that
        // went out on somebody else's `galley suggest` would read as the
        // reviewer's own gesture ending. The runs are re-found in the new doc.
        if (!next && !tr.docChanged) {
          return prev;
        }
        const runs = next || prev.runs;
        return { runs, decos: litDecorations(tr.doc, runs) };
      },
    },
    props: {
      decorations(state) {
        // getState answers `undefined` only for a state this plugin is not
        // installed in, which cannot happen here — decorations() is only ever
        // called by ProseMirror on a state that already carries this plugin.
        // The fallback is the same inert case litDecorations itself uses.
        return litKey.getState(state)?.decos ?? DecorationSet.empty;
      },
    },
  });
}

// sameRuns compares two lit sets, so paintLit can decline to dispatch.
export function sameRuns(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => v === b[i]);
}
