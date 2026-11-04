// kept.mjs — AN APPROVED REVIEW STAYS LISTED, AND OPENS AT ITS APPROVED TEXT.
//
// Two documents on one server. What only a browser can see:
//
//   · Approved, its tab closed and its document swept, a review is still in
//     the left panel, and a row opens it read-only: `Approved HH:MM` and Share
//     in the bar, no Revise, Chat's messages with no box, History's rounds.
//   · The file edited on disk after approval: reopened, the page says so above
//     the document, the editor holds the approved text, and Download Markdown
//     hands over the approved text.
//   · `galley serve --stop` and a fresh start: still listed, still opens.
//   · The left panel at 1440×900: three sections, Approved folded at first and
//     its fold remembered across a reload, the search box and the folder
//     filter narrowing the rows, and each row's ⋯ with Remove from list, which
//     asks first on a review still under way and leaves the file.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/kept.mjs

import { served } from './gateserve.mjs';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'galley-kept-'));
onCleanup(() => rmSync(dir, { recursive: true, force: true }));

const APPROVED_TEXT = 'The approved paragraph.';
const EDITED_TEXT = 'A paragraph edited after approval.';
const MOVED_ON = 'The file has changed since it was approved.';
const REMOVE_OPEN =
  'Remove from list? This ends the review and tells the agent.';

const place = (folder, name, body) => {
  mkdirSync(join(dir, folder), { recursive: true });
  const path = join(dir, folder, name);
  writeFileSync(path, `# ${name}\n\n${body}\n`);
  return path;
};
const open = async (path) => {
  const editor = spawn(
    GALLEY,
    ['edit', path, '--no-open', '--on-revise', 'true'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  onCleanup(() => editor.kill('SIGTERM'));
  return served(editor);
};
const until = async (what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await what();
    if (got || Date.now() > end) return got;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const idOf = (doc) => new URL(doc.base).pathname.split('/')[3];

const planPath = place('alpha', 'plan.md', APPROVED_TEXT);
const plan = await open(planPath);
const notes = await open(place('beta', 'notes.md', 'Another review.'));
const origin = new URL(plan.url).origin;
const isOpen = async (doc) => {
  const docs = await (await fetch(`${origin}/api/docs`)).json();
  return docs.some((d) => d.id === idOf(doc));
};

const browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const errors = [];
const tab = async (url) => {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  return page;
};

// --- approve, then close ------------------------------------------------------
{
  const page = await tab(plan.url);
  await fetch(`${plan.base}/_galley/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Is the title right?' }),
  });
  await until(() => page.locator('.kit-primary').isVisible());
  await page.locator('.kit-primary').click();
  check(
    'Approve seals the review',
    await until(
      async () =>
        (await (await fetch(`${plan.base}/_galley/revise`)).json()).sealed,
    ),
  );
  await page.close();
}
await new Promise((r) => setTimeout(r, 8000));
check(
  'with its tab closed, the approved review is swept',
  await until(async () => !(await isOpen(plan))),
);

// The left panel's review rows, and the approved one among them.
const ROWS = '.kit-left-col .kit-group-rows .kit-index-row';
const rowNamed = (page, name) => page.locator(ROWS, { hasText: name });
const keptRow = (page) => rowNamed(page, 'plan.md');
const approvedFolded = (page) =>
  page
    .locator('.kit-left-col .kit-group[data-group="approved"]')
    .evaluate((el) => el.classList.contains('kit-folded'));
const unfoldApproved = async (page) => {
  await page.waitForSelector('.kit-left-col .kit-group[data-group="approved"]');
  if (await approvedFolded(page)) {
    await page
      .locator(
        '.kit-left-col .kit-group[data-group="approved"] .kit-group-head',
      )
      .click();
  }
};
const reopen = async () => {
  const page = await tab(notes.url);
  await unfoldApproved(page);
  await keptRow(page).waitFor({ timeout: 10000 });
  return page;
};

// --- the left panel -----------------------------------------------------------
{
  const page = await tab(notes.url);
  await page.waitForSelector('.kit-left-col .kit-group-head');
  const heads = await page
    .locator('.kit-left-col .kit-group-head')
    .allTextContents();
  check(
    'the left panel has three sections: Waiting on you, Revising, Approved',
    heads.length === 3 &&
      heads[0].startsWith('Waiting on you') &&
      heads[1].startsWith('Revising') &&
      heads[2].startsWith('Approved'),
    heads,
  );
  check('Approved starts folded', await approvedFolded(page));
  await unfoldApproved(page);
  await page.reload();
  await page.waitForSelector('.kit-left-col .kit-group[data-group="approved"]');
  check(
    'unfolded, it stays unfolded after a reload',
    !(await approvedFolded(page)),
  );
  const visible = async () =>
    (await page.locator(ROWS).allInnerTexts()).filter((t) => t.trim());
  await page.fill('.gly-find', 'NOTES');
  check(
    'typing in Find a review narrows the rows to the file name',
    await until(async () => {
      const r = await visible();
      return r.length === 1 && r[0].includes('notes.md');
    }, 5000),
    await visible(),
  );
  check(
    'the search box says Find a review',
    (await page.locator('.gly-find').getAttribute('placeholder')) ===
      'Find a review',
  );
  await page.fill('.gly-find', '');
  await page.locator('.kit-left-col .kit-filter[data-value="alpha"]').click();
  check(
    'choosing a folder narrows the rows',
    await until(async () => {
      const r = await visible();
      return r.length === 1 && r[0].includes('plan.md');
    }, 5000),
    await visible(),
  );
  await page.locator('.kit-left-col .kit-filter[data-value=""]').click();
  await page.close();
}

// What a reopened approved review shows.
const sealedPage = async (page, when) => {
  check(
    `${when}: the row opens the review`,
    await until(() => page.url().endsWith(`/api/docs/${idOf(plan)}/`)),
    page.url(),
  );
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  check(
    `${when}: the bar says Approved HH:MM`,
    await until(async () =>
      /^Approved \d\d:\d\d/.test(
        (await page.locator('#gly-seal').textContent()) || '',
      ),
    ),
    await page.locator('#gly-seal').textContent(),
  );
  check(
    `${when}: Share is in the bar and Revise is not`,
    (await page.locator('.gly-share').isVisible()) &&
      !(await page.locator('#gly-revise').isVisible()),
  );
  check(
    `${when}: the editor takes no typing`,
    (await page.locator('.ProseMirror').getAttribute('contenteditable')) ===
      'false',
  );
};

{
  const page = await reopen();
  check(
    'the left panel still lists the approved review',
    (await keptRow(page).innerText()).includes('approved'),
    await keptRow(page).innerText(),
  );
  await keptRow(page).locator('.kit-index-main').click();
  await sealedPage(page, 'after the sweep');

  await page.click('.kit-rail-tabrow button:has-text("Chat")');
  const PANEL = '.kit-rail-panel[aria-label="Chat"]';
  check(
    "Chat shows the review's messages",
    await until(async () =>
      (await page.locator(`${PANEL} .kit-thread-msg.user`).allInnerTexts())
        .join(' ')
        .includes('Is the title right?'),
    ),
  );
  check(
    'and has no box',
    !(await page.evaluate(
      (panel) =>
        [...document.querySelectorAll(`${panel} textarea`)].some(
          (t) => t.getBoundingClientRect().height > 0,
        ),
      PANEL,
    )),
  );
  await page.click('.gly-versions-open');
  check(
    'History opens its rounds',
    await until(async () =>
      page.evaluate(() => {
        const v = document.querySelector('.gly-versions');
        return !!v && !v.hidden && v.textContent.trim().length > 0;
      }),
    ),
  );
  await page.close();
}

// --- the file moves on --------------------------------------------------------
await new Promise((r) => setTimeout(r, 8000));
await until(async () => !(await isOpen(plan)));
writeFileSync(planPath, `# plan.md\n\n${EDITED_TEXT}\n`);
{
  const page = await reopen();
  await keptRow(page).locator('.kit-index-main').click();
  await sealedPage(page, 'after an edit on disk');
  check(
    'the page says the file has changed since',
    await until(async () =>
      ((await page.locator('#gly-moved-on').textContent()) || '').includes(
        MOVED_ON,
      ),
    ),
  );
  const shown = await page.locator('.ProseMirror').innerText();
  check(
    'the editor holds the approved text',
    shown.includes(APPROVED_TEXT) && !shown.includes(EDITED_TEXT),
    shown,
  );
  const md = await (await fetch(`${plan.base}/_galley/download/md`)).text();
  check(
    'Download Markdown hands over the approved text',
    md.includes(APPROVED_TEXT) && !md.includes(EDITED_TEXT),
    md,
  );
  await page.close();
}

// --- a restart ----------------------------------------------------------------
spawnSync(GALLEY, ['serve', '--stop'], { stdio: 'ignore', timeout: 20000 });
const again = await open(place('beta', 'later.md', 'After the restart.'));
{
  const page = await tab(again.url);
  await unfoldApproved(page);
  await keptRow(page).waitFor({ timeout: 10000 });
  check('after a restart the approved review is still listed', true);
  await keptRow(page).locator('.kit-index-main').click();
  await sealedPage(page, 'after a restart');
  await page.close();
}

// --- Remove from list -----------------------------------------------------------
await new Promise((r) => setTimeout(r, 8000));
await until(async () => !(await isOpen(plan)));
{
  const page = await tab(again.url);
  await unfoldApproved(page);
  await keptRow(page).waitFor({ timeout: 10000 });
  const MENU = '.kit-share-menu:not([hidden])';
  await keptRow(page).locator('.gly-row-more').click();
  await page.locator(`${MENU} button`, { hasText: 'Remove from list' }).click();
  check(
    'Remove from list takes the approved row out',
    await until(async () => (await keptRow(page).count()) === 0, 5000),
  );
  check('and leaves the file', existsSync(planPath));

  const waiting = rowNamed(page, 'notes.md');
  await waiting.locator('.gly-row-more').click();
  await page.locator(`${MENU} button`, { hasText: 'Remove from list' }).click();
  check(
    'on a review still under way it asks first',
    await until(
      async () =>
        (
          (await page
            .locator(`${MENU} .kit-share-heading`)
            .textContent()
            .catch(() => '')) || ''
        ).includes(REMOVE_OPEN),
      5000,
    ),
  );
  check('and the row is still there', (await waiting.count()) === 1);
  await page.locator(`${MENU} button`, { hasText: 'Remove from list' }).click();
  check(
    'confirmed, the review leaves the list',
    await until(async () => (await waiting.count()) === 0, 5000),
  );
  check(
    'and it is closed',
    await until(async () => !(await isOpen(notes)), 5000),
  );
  await page.close();
}

check('no page errors', errors.length === 0, errors);

await cleanup();
console.log(
  counts().fails === 0
    ? '\nall kept checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
