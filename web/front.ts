// front.ts — the front page at /: every open review with its state, narrowed by
// the status pills and the folder filter and grouped by folder, kept current
// from the server's events.

import { filterRow, groupList, h, statusPills } from '/_kit/kit.js';
import {
  folderGroups,
  folderItems,
  pageFilters,
  statePills,
} from './pagelist.ts';
import { connect, reviewRow } from './shell.ts';
import type { PageView } from './wire.d.ts';

const states: string[] = [];
const folders: string[] = [];
const folded: string[] = [];
let held: PageView[] = [];

const root = h('div', { class: 'kit-main gly-front' });

/** Chooses or unchooses value; '' (All) clears the list. */
function toggle(list: string[], value: string): void {
  const at = list.indexOf(value);
  if (!value) list.length = 0;
  else if (at >= 0) list.splice(at, 1);
  else list.push(value);
  draw(held);
}

function draw(pages: PageView[]): void {
  held = pages;
  if (!pages.length) {
    root.replaceChildren(
      h(
        'p',
        { class: 'kit-empty' },
        'No reviews open. A session opens one with galley_open.',
      ),
    );
    return;
  }
  const groups = folderGroups(pageFilters(pages, states, folders));
  root.replaceChildren(
    statusPills({
      pills: statePills(pages),
      chosen: states,
      onToggle: (v) => toggle(states, v),
      label: 'Where it stands',
    }),
    filterRow({
      label: 'Folder',
      items: folderItems(pages),
      chosen: folders,
      onToggle: (v) => toggle(folders, v),
    }),
    groupList({
      groups: groups.map((g) => ({
        key: g.folder,
        title: g.folder,
        rows: g.pages.map((p) => reviewRow(p, false, false)),
        empty: 'Nothing here.',
        edge: g.edge || undefined,
      })),
      folded,
      onFold: (key, on) => {
        const at = folded.indexOf(key);
        if (on && at < 0) folded.push(key);
        if (!on && at >= 0) folded.splice(at, 1);
      },
    }),
  );
}

const b = connect({
  page: '',
  status: 'Open reviews',
  draw,
  // Nothing typed here to lose, so a new server's page is a reload away.
  reload: () => location.reload(),
  refused: () =>
    root.replaceChildren(
      h(
        'p',
        { class: 'kit-empty' },
        'Signed out. Open a review from your session to sign in here.',
      ),
    ),
});
document.getElementById('app')?.append(b.el, root);
