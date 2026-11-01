// switcher.mjs — ONE TAB HOLDS THE REVIEWS.
//
// Three documents in two folders on one server. What only a browser can see:
//
//   · The front page lists every open review with where it stands, the status
//     pills and the folder filter narrow the list, and it groups by folder.
//   · A review opened while a tab shows another reaches its index by the events,
//     and takes nothing over.
//   · A row navigates, the switcher lists the others and marks this one, and a
//     switch navigates. The left index lists the same reviews.
//   · Opening what a tab shows reuses it, and a tab on the front page moves to
//     a review that opens.
//   · Approve on the bar leaves the bar, and the lists say approved.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/switcher.mjs

import { served } from './gateserve.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  cleanup,
  counts,
  launchOrSkip,
  onCleanup,
} from './build/probe.mjs';

const GALLEY = process.env.GALLEY || 'bin/galley';
const dir = mkdtempSync(join(tmpdir(), 'galley-switcher-'));
onCleanup(() => rmSync(dir, { recursive: true, force: true }));

const place = (folder, name) => {
  mkdirSync(join(dir, folder), { recursive: true });
  const path = join(dir, folder, name);
  writeFileSync(path, `# ${name}\n\nA paragraph about ${name}.\n`);
  return path;
};
const open = async (path) => {
  const editor = spawn(
    GALLEY,
    ['edit', path, '--no-open', '--on-revise', 'true'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  onCleanup(() => editor.kill('SIGTERM'));
  return served(editor);
};
const until = async (what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await what();
    if (got || Date.now() > end) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
};

const plan = await open(place('alpha', 'plan.md'));
await open(place('alpha', 'notes.md'));
const origin = new URL(plan.url).origin;
const token = new URL(plan.url).searchParams.get('t');
const idOf = (doc) => new URL(doc.base).pathname.split('/')[3];

const browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 820 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const ROW = '.kit-group-rows .kit-index-row';
const rows = (on = page) => on.locator(ROW).allInnerTexts();
const count = (sel) => page.locator(sel).count();

// --- the front page ----------------------------------------------------------
await page.goto(`${origin}/?t=${token}`);
await page.waitForSelector(ROW);
check(
  'the front page lists the two open reviews',
  (await rows()).length === 2,
  await rows(),
);

// A REVIEW OPENED WHILE A TAB SHOWS ANOTHER IS LISTED, AND TAKES NOTHING OVER. The
// page's stream is up a moment after load.
await page.locator(`${ROW}[data-card="${idOf(plan)}"] .kit-index-main`).click();
await page.waitForURL(`**/api/docs/${idOf(plan)}/`);
await page.waitForSelector('.ProseMirror');
check('a row on the front page navigates to its review', true);
const pressed = page.locator('.kit-also-btn');
await pressed.waitFor({ state: 'visible', timeout: 10000 });
await page.waitForTimeout(2500);
const report = await open(place('beta', 'report.md'));
check(
  'a third review reaches the index by the events, with no reload',
  await until(async () => (await count('.kit-left-col .kit-index-row')) === 3),
);
check(
  'and it does not take the tab over',
  page.url().endsWith(`/api/docs/${idOf(plan)}/`),
  page.url(),
);

await page.goto(`${origin}/`);
await page.waitForSelector(ROW);
{
  const said = await rows();
  check(
    'each says its name and where it stands',
    ['plan.md', 'notes.md', 'report.md'].every((n) =>
      said.some((r) => r.includes(n) && r.includes('waiting on you')),
    ),
    said,
  );
}
check('it groups by folder', (await count('.kit-group')) === 2);

const folder = page.locator('.kit-filter[data-value="beta"]');
await folder.click();
check(
  'the folder filter narrows the list',
  (await rows()).length === 1 && (await rows())[0].includes('report.md'),
  await rows(),
);
await page.locator('.kit-filter[data-value=""]').click();
check('and All brings them back', (await count(ROW)) === 3);

check(
  'no pill offers a state nothing stands in',
  (await count('.gly-front .kit-stage[data-value="approved"]')) === 0,
);

// --- the switcher and the index -----------------------------------------------
await page.locator(`${ROW}[data-card="${idOf(plan)}"] .kit-index-main`).click();
await page.waitForURL(`**/api/docs/${idOf(plan)}/`);
await page.waitForSelector('.ProseMirror');
check(
  'the left index lists the same three, with this one on',
  (await until(
    async () => (await count('.kit-left-col .kit-index-row')) === 3,
  )) &&
    (
      await page.locator('.kit-left-col .kit-index-row.on').innerText()
    ).includes('plan.md'),
);

await pressed.click();
const menu = await page.locator('.kit-also-row').allInnerTexts();
check(
  'the switcher lists the others and marks this one',
  menu.length === 3 &&
    menu.some((t) => t.includes('plan.md') && t.includes('you are here')) &&
    menu.some((t) => t.includes('notes.md')) &&
    menu.some((t) => t.includes('report.md')),
  menu,
);
await page.locator('.kit-also-row', { hasText: 'report.md' }).click();
await page.waitForURL(`**/api/docs/${idOf(report)}/`);
await page.waitForSelector('.ProseMirror');
check('a switch navigates to the other review', true);
check(
  'and the page is that document',
  (await page.locator('.ProseMirror').innerText()).includes('report.md'),
);

// --- which tab opens ----------------------------------------------------------
const ask = async (path) =>
  (
    await fetch(`${origin}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  ).json();
await page.waitForTimeout(2500);
{
  const again = await ask(join(dir, 'beta', 'report.md'));
  check(
    'opening what a tab already shows reuses that tab',
    again.tab === 'reused',
    again,
  );
}

// --- standing -----------------------------------------------------------------
await until(() => page.locator('.kit-primary').isVisible());
await page.locator('.kit-primary').click();
check(
  'Approve on the bar approves the review, and leaves the bar',
  await until(() => page.locator('.kit-primary').isHidden()),
);
check(
  'and the index says approved',
  await until(async () =>
    (
      await page.locator('.kit-left-col .kit-index-row.on').innerText()
    ).includes('approved'),
  ),
);

const front = await context.newPage();
front.on('pageerror', (e) => errors.push(e.message));
await front.goto(`${origin}/`);
await front.waitForSelector(ROW);
check(
  'the front page tells the three apart by where they stand',
  (await rows(front)).some(
    (r) => r.includes('report.md') && r.includes('approved'),
  ) &&
    (await rows(front)).filter((r) => r.includes('waiting on you')).length ===
      2,
  await rows(front),
);
await front.locator('.kit-stage[data-value="approved"]').click();
check(
  'and the approved pill narrows the list to that one',
  (await rows(front)).length === 1 &&
    (await rows(front))[0].includes('report.md'),
  await rows(front),
);

await page.goto('about:blank');
await front.waitForTimeout(2500);
{
  const moved = await open(place('beta', 'moved.md'));
  check(
    'a tab on the front page moves to a review that opens',
    await until(() => front.url().endsWith(`/api/docs/${idOf(moved)}/`)),
    front.url(),
  );
}
check('no page errors', errors.length === 0, errors);

await cleanup();
console.log(
  counts().fails === 0
    ? '\nall switcher checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
