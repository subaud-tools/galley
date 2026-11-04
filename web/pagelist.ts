// pagelist.ts — what the page's own lists say about the open reviews, as plain
// values: the switcher in the bar, the left index and the front page all read
// one GET /api/pages, and none of this touches the kit, so the probe runs it.

import type { PageView } from './wire.d.ts';

/** The kit's ElsewhereItem, as far as this file makes one. */
interface SwitcherItem {
  label: string;
  detail: string;
  tone: 'you' | 'working' | 'idle';
  current: boolean;
  onClick(): void;
}

const WORDS: { [state: string]: string } = {
  you: 'waiting on you',
  agent: 'with the agent',
  approved: 'approved',
};

const TONES: { [state: string]: SwitcherItem['tone'] } = {
  you: 'you',
  agent: 'working',
};

export function stateWords(state: string): string {
  return WORDS[state] ?? state;
}

/** A review's address. */
export function docHref(id: string): string {
  return `/api/docs/${encodeURIComponent(id)}/`;
}

/** The review an address shows; "" on the front page. */
export function pageIdOf(pathname: string): string {
  const m = /^\/api\/docs\/([^/]+)\//.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}

/** The bar's list: what needs the reader first, the rest in the list's order.
 * Approved reviews are the left panel's, not the switcher's. */
export function switcherItems(
  pages: PageView[],
  current: string,
  go: (id: string) => void,
): SwitcherItem[] {
  const rows = pages
    .filter((p) => p.state !== 'approved')
    .map((p) => ({
      label: p.name,
      detail: `${p.folder} · ${stateWords(p.state)}`,
      tone: TONES[p.state] ?? 'idle',
      current: p.id === current,
      onClick: () => go(p.id),
    }));
  return rows.sort(
    (a, b) => Number(b.tone === 'you') - Number(a.tone === 'you'),
  );
}

/** The status pills' values, with how many stand there. */
export function statePills(
  pages: PageView[],
): { value: string; label: string; count: number }[] {
  return [
    { value: 'you', label: 'Waiting on you' },
    { value: 'agent', label: 'With the agent' },
    { value: 'approved', label: 'Approved' },
  ].map((p) => ({
    ...p,
    count: pages.filter((v) => v.state === p.value).length,
  }));
}

/** The folder filter's values, with how many each holds. */
export function folderItems(
  pages: PageView[],
): { value: string; label: string; count: number }[] {
  return folderGroups(pages).map((g) => ({
    value: g.folder,
    label: g.folder,
    count: g.pages.length,
  }));
}

/** The reviews the chosen states and folders leave; none chosen leaves all. */
export function pageFilters(
  pages: PageView[],
  states: string[],
  folders: string[],
): PageView[] {
  return pages.filter(
    (p) =>
      (!states.length || states.includes(p.state)) &&
      (!folders.length || folders.includes(p.folder)),
  );
}

/** One group per folder, in the list's order. A folder holding a review that
 * waits on the reader is edged. */
export function folderGroups(
  pages: PageView[],
): { folder: string; pages: PageView[]; edge: '' | 'signal' }[] {
  const by = new Map<string, PageView[]>();
  for (const p of pages) {
    by.set(p.folder, [...(by.get(p.folder) ?? []), p]);
  }
  return [...by].map(([folder, held]) => ({
    folder,
    pages: held,
    edge: held.some((p) => p.state === 'you') ? 'signal' : '',
  }));
}

/** The left panel's sections, by where each review stands. */
export function stateGroups(
  pages: PageView[],
): { key: string; title: string; pages: PageView[] }[] {
  return [
    { key: 'you', title: 'Waiting on you' },
    { key: 'agent', title: 'Revising' },
    { key: 'approved', title: 'Approved' },
  ].map((g) => ({ ...g, pages: pages.filter((p) => p.state === g.key) }));
}

/** The reviews whose file name holds words, in any case; no words, all. */
export function findReviews(pages: PageView[], words: string): PageView[] {
  const want = words.trim().toLowerCase();
  return pages.filter((p) => p.name.toLowerCase().includes(want));
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** An approved row's line: when (today HH:MM, yesterday, else Mon D) and how
 * many rounds. */
export function approvedMeta(
  p: Pick<PageView, 'approvedAt' | 'rounds'>,
  now: Date,
): string {
  const at = new Date(p.approvedAt ?? 0);
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const when =
    days === 0
      ? `${pad(at.getHours())}:${pad(at.getMinutes())}`
      : days === 1
        ? 'yesterday'
        : `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return `approved ${when} · ${p.rounds} round${p.rounds === 1 ? '' : 's'}`;
}
