// ---- share.js (styled by share.css; kit.css imports it, a page without kit.css links it and sets --share-*)

export const SHARE_LABEL: 'Share ▾';
export const SHARE_DOWNLOAD_HTML: 'Download HTML';
export const SHARE_DOWNLOAD_MD: 'Download Markdown';
export const SHARE_SHARE_HTML: 'Share HTML';
export const SHARE_SHARE_MD: 'Share Markdown';
export const SHARE_COPY_LINK: 'Copy link';
export const SHARE_PRINT: 'Print or save as PDF';
/** How long a Share's copied line stays on the status line, in ms. */
export const SHARE_REPLY_MS: number;

/** The status line after a Share put the file at path on the clipboard: "<base name> copied · paste to attach". */
export function sharedLine(path: string): string;

/** One menu row; act is the tool's own name for what it does. */
export interface ShareItem<A extends string = string> {
  label: string;
  act: A;
}

export interface ShareMenu {
  el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Removes the menu and its listeners, the button's toggle included. */
  destroy(): void;
}

/** Builds button's menu from items, hidden, and makes the button toggle it, right-aligned under it. A pick closes it and calls onPick; an outside click, Escape and a resize close it. */
export function shareMenu<A extends string>(button: HTMLElement, items: ShareItem<A>[], onPick: (act: A, item: ShareItem<A>) => void): ShareMenu;
