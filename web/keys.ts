// web/keys.ts owns the page's keyboard: the Esc chain, and the j/k stepper
// that walks the drafts on the text, given to the kit's keyboard layer. It is a MIXIN — an object
// of methods `Object.assign`ed onto `App.prototype` in entry.ts — not a
// class of its own, so every method here still reads and writes `this` on
// the live App instance exactly as it did before the move (`this.stepped`,
// `this.comments`, `this.versionsPanel`,
// and so on).
//
// `this` IS TYPED AGAINST `AppShell` (web/appshell.ts), the shape every
// mixin's `this` shares from here on — see that file's own header for the
// three options weighed and why this one was chosen.

import { stepPending, textThreads } from './tabs.ts';
import { closeMenu, menuOpen, moveMenuFocus } from './menu.ts';
import type { AppShell } from './appshell.ts';
import type { EscStep, KeyLayer } from './roundbar.ts';

export const keyMethods = {
  // keyLayer is what the page's keyboard answers, handed to the kit's
  // createKeys by the shell (web/shell.ts mountKeys): the Esc chain as the
  // kit's Esc closers, and the page's own keys. The kit keeps every key but Esc
  // out of a text field, so j and k are ordinary letters in the document, a
  // draft box or Chat; Esc is the one key that acts inside a field, and with
  // nothing of galley's open the kit's own Esc leaves the field, which is the
  // way out of the field and into the stepper.
  //
  // THE CHAIN IS TOPMOST FIRST, and the kit tries the closers in this order and
  // stops at the first that closed something. One key may not do two things in
  // one press.
  keyLayer(this: AppShell): KeyLayer {
    const esc: EscStep[] = [
      // THE MENU IS TOPMOST. It is drawn over everything the pointer was on and
      // it is the most recent thing the reviewer opened, so a press that closed
      // anything else while it was up would be closing something they cannot
      // see.
      {
        label: 'close the menu',
        close: () => {
          if (!menuOpen(this.menu)) {
            return false;
          }
          closeMenu(this.menu);
          return true;
        },
      },
      // The refusal note and the selection bubble go with any Esc and take no
      // press of their own: the key goes on to History or out of the field, as
      // it always has. The composer's form takes the press.
      {
        label: 'close the instruction box',
        close: () => {
          const formOpen =
            !this.composer.root.hidden && !this.composer.form.hidden;
          this.hideRefusal();
          this.bubble.hide();
          // A BLOCK GRIP'S COMPOSER HANDS FOCUS BACK TO THE GRIP. The keyboard
          // reached the composer through that button, and closing it into
          // nowhere would leave the reviewer to Tab back from the top of the page.
          const opener = this.composer.root.hidden
            ? null
            : this.composer.opener;
          this.hideComposer();
          if (opener && opener.isConnected) {
            opener.focus();
          }
          return formOpen;
        },
      },
      // THE ROUNDS. The record floats over the whole-document panel below it.
      // Inside History Esc has two meanings stacked: release the change a
      // reviewer pinned, and leave the reading mode. The pin is the innermost,
      // so it goes first; `unpin` reports whether it had anything to release.
      {
        label: 'unpin a change in History',
        close: () => this.versionsPanel.open && this.versionsPanel.unpin(),
      },
      {
        label: 'close History',
        close: () => {
          if (!this.versionsPanel.open) {
            return false;
          }
          this.versionsPanel.hide();
          this.paintVersionsButton();
          return true;
        },
      },
    ];
    // THE MENU'S OWN ARROWS, in a field too: a menu the mouse can reach and the
    // keyboard cannot is half a menu. With no menu up they are the page's
    // scroll again (false leaves the key to the browser).
    const menuArrow = (d: 1 | -1) => () =>
      menuOpen(this.menu) && moveMenuFocus(this.menu, d);
    // j/k WALK THE DRAFTS ON THE TEXT, but not under the menu (two surfaces
    // answering one press) and not in History, which is a READING mode: its
    // premise is that it computes nothing and decides nothing, and stepping
    // moves `this.stepped`, state a reading mode may not write.
    const stepper = (d: 1 | -1) => () => {
      if (menuOpen(this.menu) || this.versionsPanel.open) {
        return false;
      }
      this.step(d);
      return true;
    };
    return {
      esc,
      keys: [
        { keys: 'j', label: 'next draft on the text', run: stepper(1) },
        { keys: 'k', label: 'previous draft on the text', run: stepper(-1) },
        {
          keys: '↓',
          label: 'next menu item',
          inField: true,
          run: menuArrow(1),
        },
        {
          keys: '↑',
          label: 'previous menu item',
          inField: true,
          run: menuArrow(-1),
        },
      ],
    };
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
