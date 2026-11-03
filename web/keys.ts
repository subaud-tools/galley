// web/keys.ts owns the page's keyboard: the Esc chain, and the j/k stepper
// that walks the drafts on the text. It is a MIXIN — an object
// of methods `Object.assign`ed onto `App.prototype` in entry.ts — not a
// class of its own, so every method here still reads and writes `this` on
// the live App instance exactly as it did before the move (`this.stepped`,
// `this.comments`, `this.versionsPanel`,
// and so on).
//
// `this` IS TYPED AGAINST `AppShell` (web/appshell.ts), the shape every
// mixin's `this` shares from here on — see that file's own header for the
// three options weighed and why this one was chosen.

import { stepPending, keyTargetIsEditable, textThreads } from './tabs.ts';
import { closeMenu, menuOpen, moveMenuFocus } from './menu.ts';
import type { AppShell } from './appshell.ts';

export const keyMethods = {
  // onKey is the rail's keyboard, and it is deliberately quiet while anything
  // is being typed into. The document is contenteditable, so j and k are
  // ordinary letters most of the time; Esc is the way out of the field and into
  // the stepper, which is why it is listed as blurring rather than only
  // dismissing.
  onKey(this: AppShell, event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === 'Escape') {
      // Esc is the one key that acts INSIDE a field: it dismisses what is open,
      // and failing that hands focus back to the page so the rest of these keys
      // become available.
      // THE MENU IS TOPMOST, so it is first — the ordering rule this chain is
      // built on. It is drawn over everything the pointer was on and it is the
      // most recent thing the reviewer opened, so a press that closed anything
      // else while it was up would be closing something they cannot see.
      if (menuOpen(this.menu)) {
        closeMenu(this.menu);
        return;
      }
      this.hideRefusal();
      this.bubble.hide();
      // A BLOCK GRIP'S COMPOSER HANDS FOCUS BACK TO THE GRIP. The keyboard
      // reached the composer through that button, and closing it into nowhere
      // would leave the reviewer to Tab back from the top of the page.
      const opener = this.composer.root.hidden ? null : this.composer.opener;
      this.hideComposer();
      if (opener && opener.isConnected) {
        opener.focus();
      }
      // THE ROUNDS, and the position in this chain is the ordering rule this
      // chain is built on: TOPMOST FIRST. The record floats at z-index 44, over
      // the whole-document panel below it, so Esc has to reach it before the
      // panel — otherwise a reviewer with both open presses Esc, watches
      // something they cannot see close, and presses it again.
      if (this.versionsPanel.open) {
        // ONE KEY MAY NOT DO TWO THINGS IN ONE PRESS, and inside History Esc
        // has two meanings stacked: release the change a reviewer pinned, and
        // leave the reading mode. The pin is the innermost, so it goes first —
        // the same TOPMOST-FIRST rule this whole chain is built on, one level
        // further in. `unpin` reports whether it had anything to release, so
        // the outer meaning is not swallowed on a press with nothing pinned.
        if (this.versionsPanel.unpin()) {
          return;
        }
        this.versionsPanel.hide();
        this.paintVersionsButton();
        return;
      }
      // The capture card closes on Esc like every other surface here — it is
      // something on screen that is in the way, and the one key that means
      // "put that away" has to reach it. Its `cancel` button says the same
      // thing for the mouse; the two are one exit spelled for two reviewers.
      const active = document.activeElement;
      // `document.activeElement` is `Element | null` to the DOM's own types,
      // and `blur()` is only on the HTML/SVG element mixin, not on `Element`
      // itself — a real `instanceof` narrowing where this used to read the
      // method's presence off `active.blur`. Every element `keyTargetIsEditable`
      // answers true for (an input, a textarea, a select, or a
      // contenteditable node) is an HTMLElement in this document, so nothing
      // reachable here changes which branch runs.
      if (keyTargetIsEditable(active) && active instanceof HTMLElement) {
        active.blur();
      }
      return;
    }
    // THE MENU'S OWN ARROWS, BEFORE THE EDITABLE GUARD AND BEFORE THE STEPPER.
    // A menu the mouse can reach and the keyboard cannot is half a menu, and
    // `j`/`k` walking the document underneath an open menu would be two
    // surfaces answering one press.
    if (menuOpen(this.menu)) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (moveMenuFocus(this.menu, event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault();
        }
      }
      return;
    }
    if (
      keyTargetIsEditable(event.target) ||
      keyTargetIsEditable(document.activeElement)
    ) {
      return;
    }
    // `a` AND `r` ARE DELETED, AND THE GUARD BELOW OUTLIVES THEM. They ran
    // `decideStepped`, which POSTed /_galley/accept and /_galley/reject — two
    // of the twelve endpoints internal/serve/rounds_surface_test.go asserts
    // are 404. Nothing could reach them: `stepped` is armed only by `step`, and
    // `step` walks `this.suggestions`, which is empty by construction on the
    // rounds-only wire), so nothing is lost: there is no verdict on an
    // instruction. The rail's card verbs are edit and delete, and they are on
    // the card.
    //
    // NOT WHILE HISTORY IS UP. History is a READING mode: `body.gly-history-mode`
    // takes `main` to `display: none` and puts a version's paper in its place,
    // and the whole premise of the surface is that it computes nothing and
    // decides nothing. `j`/`k` are inert there — `markElement` finds nothing
    // inside a hidden `main` — but they still moved `this.stepped`, which is
    // state a reading mode may not write. Every neighbour already knew:
    // `paintReadout`, `paintSurfaces` and the Esc chain all branch on the panel
    // being open. This switch was the one reader that did not ask, which is this
    // codebase's most-repeated shape — the rule spelled in every place but one,
    // and the silent place is the one that costs you.
    //
    // j/k AND `↓ next` WALK THE INSTRUCTION CARDS — see stepOrder, which used
    // to walk `this.suggestions.filter(decidable)` over a wire that carries no
    // suggestions, and so reached nothing at all. The note that stood here
    // named both exits ("point the stepper at the instruction cards or take
    // that check with it") and this is the first of them.
    if (this.versionsPanel.open) {
      return;
    }
    switch (event.key) {
      case 'j':
        event.preventDefault();
        this.step(1);
        break;
      case 'k':
        event.preventDefault();
        this.step(-1);
        break;
      default:
        break;
    }
  },

  // j and k walk the drafts on the text, in the order the server lists them.
  stepOrder(this: AppShell): string[] {
    return textThreads(this.comments).map((t) => t.key);
  },

  step(this: AppShell, direction: 1 | -1) {
    const next = stepPending(this.stepOrder(), this.stepped, direction);
    if (next) {
      this.stepped = next;
      this.openDraft(next);
      this.selectDraft(next);
    }
  },
};
