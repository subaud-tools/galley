// ---- tip.js

/** Makes trigger open tip (a .kit-tip) inside box (a .kit-tip-at): on hover, keyboard focus, Enter or a tap; Esc, leaving by keyboard or a tap elsewhere closes it. when says whether there is anything to show; a press with nothing to show goes to what is under it. */
export function wireTip(box: HTMLElement, trigger: HTMLElement, tip: HTMLElement, when?: () => boolean): void;
/** A tip of one plain line. */
export function lineTip(text: string): HTMLElement;

