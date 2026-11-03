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
//   · A tab counts from its first moment, with its stream not up yet.
//   · The reader's words outlast a failed request, a Revise pressed before their
//     save came back, and a press that would leave them behind.
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

const ask = async (path) =>
  (
    await fetch(`${origin}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  ).json();

// --- a tab counts at once -----------------------------------------------------
//
// First, while no tab has ever checked in, so "reused" can only mean this one.
// Its stream is held back: what the server knows, it knows from the check-in.
{
  const first = await context.newPage();
  await first.route('**/api/events*', () => {});
  await first.goto(plan.url, { waitUntil: 'commit' });
  const reused = await until(
    async () => (await ask(join(dir, 'alpha', 'plan.md'))).tab === 'reused',
    1000,
  );
  check('a tab counts as open before its stream is up', reused);
  await first.close();
}

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

// A show sent before the stream is up still arrives when it opens.
{
  const early = await context.newPage();
  let release = () => {};
  const opened = new Promise((r) => (release = r));
  await early.route('**/api/events*', async (route) => {
    await opened;
    await route.continue();
  });
  await early.goto(`${origin}/`);
  await early.waitForSelector(ROW);
  const shown = await ask(place('beta', 'shown.md'));
  release();
  check(
    'a front-page tab whose stream is not up yet still moves to a review that opens',
    await until(() => early.url().endsWith(`/api/docs/${shown.id}/`), 5000),
    early.url(),
  );
  await early.close();
}

// --- the reader's words -------------------------------------------------------
const INSTRUCT = '**/_galley/instruct';
const BOX = '#gly-doc-box';
const ROW_BOX = '.gly-doc-drafts .kit-draft-words';
const review = async (name) => {
  const doc = await open(place('words', name));
  const tab = await context.newPage();
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(doc.url);
  await tab.waitForSelector('.ProseMirror');
  await tab
    .locator('.kit-rail-tabrow .kit-ctl', { hasText: 'Instructions' })
    .click();
  return { doc, tab };
};
const asks = async (doc) =>
  (await (await fetch(`${doc.base}/_galley/pending`)).json()).instructions ||
  [];
const fileRow = async ({ doc, tab }, words) => {
  await tab.fill(BOX, words);
  await tab.locator(BOX).press('Enter');
  await until(async () => (await asks(doc)).length === 1);
  await tab.waitForSelector(ROW_BOX);
};
// Would leaving now ask first? Read off the event, since a browser only shows
// its dialog to a page the reader has pressed.
const guarded = (tab) =>
  tab.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
const sealed = async (doc) =>
  !!(await (await fetch(`${doc.base}/_galley/revise`)).json()).sealed;
const rounds = async (doc) =>
  (await fetch(`${doc.base}/_galley/versions`)).text();

// Finding: a failed filing keeps the words, and newer typing beside them.
{
  const { tab } = await review('filing.md');
  await tab.route(INSTRUCT, (route) => route.abort());
  await tab.fill(BOX, 'the first words');
  await tab.locator(BOX).press('Enter');
  await tab.waitForTimeout(500);
  check(
    'a filing the network dropped leaves its words in the whole-document box',
    (await tab.inputValue(BOX)) === 'the first words',
    await tab.inputValue(BOX),
  );
  await tab.unroute(INSTRUCT);

  let refuse = () => {};
  const refused = new Promise((r) => (refuse = r));
  await tab.route(INSTRUCT, async (route) => {
    await refused;
    await route.fulfill({ status: 500, body: 'no' });
  });
  await tab.locator(BOX).press('Enter');
  await tab.locator(BOX).press('End');
  await tab.locator(BOX).pressSequentially(' and newer');
  refuse();
  await tab.waitForTimeout(500);
  const both = await tab.inputValue(BOX);
  check(
    'a refusal overwrites nothing typed while it was on its way',
    both.includes('the first words') && both.includes('and newer'),
    both,
  );
  await tab.unroute(INSTRUCT);

  await tab.fill(BOX, 'accepted words');
  await tab.locator(BOX).press('Enter');
  check(
    'an accepted filing empties the box',
    await until(async () => (await tab.inputValue(BOX)) === ''),
    await tab.inputValue(BOX),
  );
  await tab.close();
}

// Finding: unfiled words stop the page leaving, and stop Approve sealing.
{
  const { doc, tab } = await review('leaving.md');
  check('a page holding nothing leaves freely', !(await guarded(tab)));
  await tab.fill(BOX, 'words nobody has');
  check(
    'a page with unfiled whole-document words asks first',
    await guarded(tab),
  );
  await tab.locator('.kit-primary').click();
  await tab.waitForTimeout(500);
  check(
    'Approve does not seal over unfiled whole-document words',
    !(await sealed(doc)),
    await sealed(doc),
  );
  // The press filed them instead: an instruction now, so Revise's ▾ offers
  // Revise & approve, as for any unsent instruction.
  const more = tab.locator('#gly-revise-more');
  check(
    "it files them, and Revise's ▾ offers Revise & approve",
    await until(() => more.isVisible(), 5000),
  );
  if (await more.isVisible()) {
    await more.click();
    await tab.locator('.kit-share-menu:not([hidden]) button').click();
  }
  check(
    'Revise & approve carries those words',
    await until(
      async () => (await rounds(doc)).includes('words nobody has'),
      3000,
    ),
    await rounds(doc),
  );
  check(
    'and the box has let them go',
    (await tab.inputValue(BOX)) === '',
    await tab.inputValue(BOX),
  );
  await tab.close();

  const rescue = await review('rescued.md');
  await fileRow(rescue, 'a row');
  await rescue.tab.fill(ROW_BOX, 'a row, being rewritten');
  const [{ key }] = await asks(rescue.doc);
  await fetch(`${rescue.doc.base}/_galley/instruction/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  await until(async () =>
    (await rescue.tab.inputValue(BOX)).includes('being rewritten'),
  );
  check(
    'words rescued into the whole-document box ask first too',
    await guarded(rescue.tab),
  );
  await rescue.tab.close();
}

// Finding: Revise waits for a row's save, and a failed save keeps its words.
{
  const slow = await review('slow.md');
  await fileRow(slow, 'old wording');
  const order = [];
  await slow.tab.route(INSTRUCT, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    const res = await route.fetch();
    order.push('saved');
    await route.fulfill({ response: res });
  });
  await slow.tab.route('**/_galley/revise', (route) => {
    if (route.request().method() === 'POST') order.push('revise');
    return route.continue();
  });
  await slow.tab.fill(ROW_BOX, 'new wording');
  await until(() => slow.tab.locator('#gly-revise').isEnabled());
  await slow.tab.locator('#gly-revise').click();
  await until(() => order.includes('revise'), 5000);
  check(
    'Revise waits for the save that was on its way',
    order.join() === 'saved,revise',
    order,
  );
  check(
    'and the round carries the new wording',
    await until(async () => (await rounds(slow.doc)).includes('new wording')),
    await rounds(slow.doc),
  );
  await slow.tab.close();

  const dropped = await review('dropped.md');
  await fileRow(dropped, 'old wording');
  let posts = 0;
  await dropped.tab.route('**/_galley/revise', (route) => {
    if (route.request().method() === 'POST') posts += 1;
    return route.continue();
  });
  await dropped.tab.route(INSTRUCT, (route) => route.abort());
  await dropped.tab.fill(ROW_BOX, 'new wording');
  await dropped.tab.locator(ROW_BOX).blur();
  await dropped.tab.waitForTimeout(2500);
  check(
    'a save the network dropped keeps its words through the polls',
    (await dropped.tab.inputValue(ROW_BOX)) === 'new wording',
    await dropped.tab.inputValue(ROW_BOX),
  );
  check('and the page asks before leaving them', await guarded(dropped.tab));
  await dropped.tab.locator('#gly-revise').click();
  await dropped.tab.waitForTimeout(500);
  check(
    'Revise will not send the old wording over a failed save',
    posts === 0 && (await dropped.tab.inputValue(ROW_BOX)) === 'new wording',
    { posts },
  );
  await dropped.tab.unroute(INSTRUCT);
  await until(() => dropped.tab.locator('#gly-revise').isEnabled());
  await dropped.tab.locator('#gly-revise').click();
  check(
    'and once the server is back, Revise saves them and sends them',
    await until(async () =>
      (await rounds(dropped.doc)).includes('new wording'),
    ),
    await rounds(dropped.doc),
  );
  await dropped.tab.close();
}

check('no page errors', errors.length === 0, errors);

await cleanup();
console.log(
  counts().fails === 0
    ? '\nall switcher checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
