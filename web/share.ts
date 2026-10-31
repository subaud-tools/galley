// share.ts — handing an approved document to a reader.
//
// The vocabulary in the top half is pure — every label the button, its menu
// and the bar's preview button show, and the status line a save ends on — so
// probe.mjs and web/share.mjs import the spellings rather than restating them.
//
// THE BOTTOM HALF, `shareMethods`, IS A MIXIN `Object.assign`ed onto
// `App.prototype` in entry.ts, typed against `AppShell` like web/seal.ts.
//
// SHARE APPEARS ONLY AFTER APPROVAL, IN THE BOX REVISE LEAVES. It is built
// hidden, directly after `#gly-revise`, and `applySeal` swaps the two on the
// sealing edge (and back on the unseal edge) with `hidden`, so exactly one of
// them occupies the slot. Its width and height are Revise's own, read on that
// edge, so approving moves nothing in the bar (web/share.mjs measures it).
//
// TWO WAYS TO HAND IT OVER. A download is the browser's: Download HTML is
// GET /_galley/render?download=1 (the branded page, no refresh script) and
// Download Markdown GET /_galley/download/md, each an attachment the browser
// puts in Downloads. A Share is the server's, macOS only: POST
// /_galley/share/html writes <name>.html beside <name>.md and puts that file
// on the clipboard, /_galley/share/md puts the .md there, so a paste into a
// chat attaches the file. The server says whether it can (`data-can-share`),
// and the Shares are absent where it cannot. A page under review (page mode)
// is already the HTML a reader gets: its menu hands over the page itself and
// has no Markdown items.
//
// THE MENU AND ITS WORDS ARE TOOLS-COMMON'S. web/kit/share.js is the kit's
// share.js, copied from the module go.mod pins by `just assets` (the
// `kit-copy` script) and bundled into editor.js, its share.css into
// editor.css; `bundle-fresh` fails when the copy and the pin disagree. Its
// labels, status line and reply time are re-exported here so the harnesses
// keep importing them from this file. Which items, in what order, and what
// each does stay galley's.

import { apiUrl, postJSON, routes } from './net.ts';
import type { AppShell } from './appshell.ts';
import {
  SHARE_LABEL,
  SHARE_DOWNLOAD_HTML,
  SHARE_DOWNLOAD_MD,
  SHARE_SHARE_HTML,
  SHARE_SHARE_MD,
  SHARE_REPLY_MS,
  sharedLine,
  shareMenu,
  type ShareMenu,
} from './kit/share.js';

export {
  SHARE_LABEL,
  SHARE_DOWNLOAD_HTML,
  SHARE_DOWNLOAD_MD,
  SHARE_SHARE_HTML,
  SHARE_SHARE_MD,
  SHARE_REPLY_MS,
  sharedLine,
} from './kit/share.js';
export type { ShareMenu };

export const PREVIEW_LABEL = 'HTML preview ↗';

type ShareAct = 'download-html' | 'download-md' | 'share-html' | 'share-md';

export interface ShareItem {
  label: string;
  act: ShareAct;
}

/** shareItems is the menu, in order: the downloads, then, where the server
 * can put a file on the clipboard, the Shares. A page under review has no
 * Markdown items. */
export function shareItems(pageMode: boolean, canShare: boolean): ShareItem[] {
  const items: ShareItem[] = [
    { label: SHARE_DOWNLOAD_HTML, act: 'download-html' },
  ];
  if (!pageMode) {
    items.push({ label: SHARE_DOWNLOAD_MD, act: 'download-md' });
  }
  if (canShare) {
    items.push({ label: SHARE_SHARE_HTML, act: 'share-html' });
    if (!pageMode) {
      items.push({ label: SHARE_SHARE_MD, act: 'share-md' });
    }
  }
  return items;
}

const DOWNLOADS: Record<string, string> = {
  'download-html': `${routes.render}?download=1`,
  'download-md': routes.downloadMd,
};

// download starts the browser's download of href; the server's
// Content-Disposition names the file.
function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The pending clear of the last Share's copied line. One page, one App, so a
// module variable rather than a field on the shell.
let replyClear: ReturnType<typeof setTimeout> | undefined;

export const shareMethods = {
  // makeShare builds the button hidden, directly after Revise, so it can take
  // Revise's place on the seal edge. Null where the shell has no Revise.
  makeShare(this: AppShell): HTMLButtonElement | null {
    const revise = this.revise;
    if (!revise || !revise.parentNode) {
      return null;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gly-share';
    b.textContent = SHARE_LABEL;
    b.title = 'hand the approved document to a reader';
    b.hidden = true;
    revise.parentNode.insertBefore(b, revise.nextSibling);
    // The kit's menu binds the button's click to its toggle, and closes on an
    // outside click, Escape and a resize. Built now, hidden: the button is
    // hidden until the seal edge, so nothing can open it before approval.
    this.shareMenu = shareMenu(
      b,
      shareItems(this.pageMode, this.canShare),
      (act) => this.runShare(act),
    );
    return b;
  },

  // swapShare is the seal edge's half for the slot: sealed shows Share in
  // Revise's box (one CSS width, `--gly-verb-w`, and the bar's padding),
  // unsealed hands the slot back to Revise.
  swapShare(this: AppShell, sealed: boolean) {
    const share = this.share;
    const revise = this.revise;
    if (!share || !revise) {
      return;
    }
    if (sealed) {
      revise.hidden = true;
      share.hidden = false;
      return;
    }
    this.closeShareMenu();
    share.hidden = true;
    revise.hidden = false;
  },

  closeShareMenu(this: AppShell) {
    this.shareMenu?.close();
  },

  runShare(this: AppShell, act: ShareAct) {
    const href = DOWNLOADS[act];
    if (href) {
      download(apiUrl(href));
      return;
    }
    const route = act === 'share-md' ? routes.shareMd : routes.shareHtml;
    clearTimeout(replyClear);
    this.say('copying…');
    // The copied line clears itself, but only if it is still the line: any
    // say() since then is newer and wins.
    const copied = (path: string) => {
      const line = sharedLine(path);
      this.say(line);
      replyClear = setTimeout(() => {
        if (this.said === line) {
          this.say('');
        }
      }, SHARE_REPLY_MS);
    };
    postJSON(route, {})
      .then((res) =>
        res.ok
          ? res.json().then((v: { path: string }) => copied(v.path))
          : res
              .text()
              .then((t) =>
                this.say(t.trim() || `share failed (${res.status})`),
              ),
      )
      .catch((err: unknown) =>
        this.say(
          `share failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  },

  // The bar's way to the rendered page, markdown reviews only: a page under
  // review already has its own preview pane. It sits just before Revise, to
  // the right of the mode toggle, so the toggle leaving on the seal edge moves
  // it no more than it moves Revise; the seal does not touch it, because
  // reading the shared look is as useful after approval as before.
  makePreview(this: AppShell): HTMLButtonElement | null {
    const revise = this.revise;
    if (this.pageMode || !revise || !revise.parentNode) {
      return null;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gly-preview-open';
    b.textContent = PREVIEW_LABEL;
    b.title = 'the branded page Download HTML saves, refreshed on every save';
    b.addEventListener('click', () => {
      window.open(apiUrl(routes.render), '_blank', 'noopener');
    });
    revise.parentNode.insertBefore(b, revise);
    return b;
  },
};
