// share.mjs — AFTER APPROVAL THE SEND BAR HOLDS SHARE.
//
// After approval the reviewer hands the document to a reader. Revise leaves the
// send bar when the review seals, and `Share ▾` is there instead; its menu
// downloads the branded HTML or the Markdown, and on macOS puts either file on
// the clipboard to paste as an attachment. The `HTML preview ↗` button beside
// History opens the same rendered page while the review is live.
//
// What only a browser can see, and so what this gate measures:
//
//   · Share is on the send bar after the seal, and Revise is not.
//   · The menu's items, verbatim and in order: the two downloads everywhere,
//     the two Shares on macOS only.
//   · Download HTML and Download Markdown are downloads named doc.html and
//     doc.md.
//   · The approved bar reads `Approved HH:MM` and nothing more.
//   · Share HTML writes <doc>.html beside <doc>.md and says so on the status
//     line, and the line clears itself SHARE_REPLY_MS later, while `Approved`
//     stays where it was; Share Markdown says so too. On macOS this really sets the
//     clipboard, to the file; nothing here reads it back.
//   · The preview link answers.
//   · Share's menu, opened from the bar at the window's foot, lies wholly inside
//     the window.
//   · A page under review (page mode) offers Download HTML and Share HTML, for
//     the page itself, and has no preview link.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/share.mjs

import { served } from './gateserve.mjs';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARE_LABEL,
  SHARE_DOWNLOAD_HTML,
  SHARE_DOWNLOAD_MD,
  SHARE_SHARE_HTML,
  SHARE_SHARE_MD,
  PREVIEW_LABEL,
  SHARE_REPLY_MS,
  sharedLine,
} from './share.ts';
import { check as kitCheck, counts, launchOrSkip } from './build/probe.mjs';

// The server offers the Shares only where it can put a file on the clipboard.
const MAC = process.platform === 'darwin';

const GALLEY = process.env.GALLEY || 'bin/galley';
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PAGE = join(
  HERE_DIR,
  '..',
  'internal',
  'htmlpage',
  'testdata',
  'galley-tools-index.html',
);

// The scaffolding's check, with the detail written as JSON as this gate always
// has: most details here are objects.
const check = (name, ok, detail) =>
  kitCheck(
    name,
    ok,
    detail === undefined ? '' : JSON.stringify(detail, null, 1),
  );

// realpath: macOS's tmpdir is a symlink, and the server reports the path it
// resolved.
const HERE = realpathSync(mkdtempSync(join(tmpdir(), 'galley-share-')));
// An empty config home, so a theme on this machine cannot change the page.
const CONFIG = join(HERE, 'config');
const DOC = join(HERE, 'doc.md');
const SAVED = join(HERE, 'doc.html');
writeFileSync(
  DOC,
  '# Share me\n\nA paragraph for the reader.\n\n## Section one\n\nMore words.\n',
);
const PAGE_DIR = join(HERE, 'site');
const PAGE = join(PAGE_DIR, 'index.html');
cpSync(FIXTURE_PAGE, PAGE);

const children = [];
let browser = null;
process.on('exit', () => {
  try {
    const proc = browser && browser.process();
    if (proc) proc.kill('SIGKILL');
  } catch {
    // Already gone.
  }
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  try {
    rmSync(HERE, { recursive: true, force: true });
  } catch {
    // A tmpdir left behind is nothing; a throwing exit handler is not.
  }
});

function serve(target) {
  const child = spawn(GALLEY, ['edit', target, '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG, GALLEY_HOME: '' },
  });
  let said = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (b) => {
      said = (said + b).slice(-8000);
    });
  }
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM') {
      console.log(`      [server exited] code=${code}\n${said.trim()}`);
    }
  });
  children.push(child);
  return served(child);
}

const approve = (base) =>
  fetch(`${base}/_galley/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict: 'approve' }),
  });

const { base, url: docURL } = await serve(DOC);
const { base: pageBase, url: pageURL } = await serve(PAGE);

browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});

async function open(url) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  await page.waitForTimeout(1000);
  return page;
}

const shareVisible = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.gly-share');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return !el.hidden && r.width > 0 && r.height > 0;
  });
// Approval reaches the page on its next poll; wait for the seal edge to swap
// Share in, and let the check that follows report it if it never did.
const shareShown = (page) =>
  page
    .waitForFunction(
      () => {
        const el = document.querySelector('.gly-share');
        return !!el && !el.hidden && el.getBoundingClientRect().width > 0;
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
const menuItems = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.kit-share-menu button')]
      .filter((b) => b.getBoundingClientRect().height > 0)
      .map((b) => b.textContent),
  );
const pick = (page, label) =>
  page
    .click(`.kit-share-menu button:has-text("${label}")`, { timeout: 5000 })
    .catch(() => {});
// The suggested filename of the download one press of label starts.
async function downloadName(page, label) {
  await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    pick(page, label),
  ]);
  return download ? download.suggestedFilename() : null;
}
// Where the sealed state's text starts: the left edge of the `A` of
// `Approved`, measured with a Range on the text itself, so a reply that moved
// it would show.
const approvedStart = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('gly-seal');
    const node = el && el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const word = 'Approved';
    const at = node.data.indexOf(word);
    if (at < 0) return null;
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + word.length);
    const [first] = r.getClientRects();
    return first ? first.left : null;
  });
// The status line, once it says want or after ten seconds.
async function statusSays(page, want) {
  await page
    .waitForFunction(
      (w) =>
        (document.getElementById('gly-status')?.textContent || '').includes(w),
      want,
      { timeout: 10000 },
    )
    .catch(() => {});
  return page.evaluate(
    () => document.getElementById('gly-status')?.textContent || '',
  );
}

// --- a markdown review -------------------------------------------------------

{
  const page = await open(docURL);

  check(
    'before approval the Share button is not on the bar',
    !(await shareVisible(page)),
  );
  const preview = await page.evaluate(() => {
    const b = document.querySelector('.gly-stages .gly-preview-open');
    if (!b) return null;
    const before = (x, y) =>
      !!x &&
      !!y &&
      !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      text: b.textContent,
      shown: b.getBoundingClientRect().width > 0,
      afterHistory: before(document.querySelector('.gly-versions-open'), b),
    };
  });
  check(
    'the HTML preview button is beside History',
    !!preview &&
      preview.text === PREVIEW_LABEL &&
      preview.shown &&
      preview.afterHistory,
    preview,
  );
  const opened = await page.evaluate(() => {
    const calls = [];
    const real = window.open;
    window.open = (...a) => {
      calls.push(a);
      return null;
    };
    document.querySelector('.gly-stages .gly-preview-open')?.click();
    window.open = real;
    return calls;
  });
  check(
    'pressing it opens /_galley/render in a new tab, without an opener',
    opened.length === 1 &&
      opened[0][0] === `${new URL(base).pathname}/_galley/render` &&
      opened[0][1] === '_blank' &&
      String(opened[0][2] || '').includes('noopener'),
    opened,
  );
  // THE KIT'S TIP, NOT THE BROWSER'S TITLE: on hover and on keyboard focus,
  // and a press still goes to the button.
  {
    const tipOf = (sel) =>
      page.evaluate((s) => {
        const b = document.querySelector(s);
        const t = b?.parentElement?.querySelector(':scope > .kit-tip');
        return {
          title: b?.getAttribute('title') ?? null,
          text: t?.textContent ?? null,
          shown: !!t && getComputedStyle(t).display !== 'none',
          described: !!t && b?.getAttribute('aria-describedby') === t.id,
          expanded: b?.getAttribute('aria-expanded') ?? null,
        };
      }, sel);
    const PREVIEW = '.gly-stages .gly-preview-open';
    await page.hover(PREVIEW);
    const hovered = await tipOf(PREVIEW);
    check(
      'HTML preview has no native title, and the kit tip says what it does on hover',
      hovered.title === null &&
        hovered.text ===
          'the branded page Download HTML saves, refreshed on every save' &&
        hovered.shown &&
        hovered.described,
      hovered,
    );
    await page.mouse.move(0, 0);
    await page.locator('.gly-versions-open').focus();
    const door = await tipOf('.gly-versions-open');
    await page.keyboard.press('Tab');
    const focused = await tipOf(PREVIEW);
    check(
      'and on keyboard focus',
      focused.shown &&
        (await page.evaluate(
          (s) => document.activeElement === document.querySelector(s),
          PREVIEW,
        )),
      focused,
    );
    check(
      "History's tip leaves its own aria-expanded alone",
      door.expanded === 'false' && door.title === null && !!door.text,
      door,
    );
    const pressed = await page.evaluate(() => {
      window.__opened = [];
      window.open = (...a) => {
        window.__opened.push(a);
        return null;
      };
    });
    void pressed;
    await page.keyboard.press('Enter');
    await page.mouse.click(
      ...(await page
        .locator(PREVIEW)
        .boundingBox()
        .then((r) => [r.x + r.width / 2, r.y + r.height / 2])),
    );
    check(
      'Enter and a click on it still open the preview',
      (await page.evaluate(() => window.__opened.length)) === 2,
      await page.evaluate(() => window.__opened),
    );
  }
  {
    const res = await fetch(`${base}/_galley/render`);
    const body = await res.text();
    check(
      'the preview answers with the rendered document',
      res.status === 200 && body.includes('Section one'),
      { status: res.status },
    );
  }
  const approved = await approve(base);
  check('the approve was accepted', approved.ok, approved.status);
  await shareShown(page);
  check('after approval the Share button is showing', await shareVisible(page));
  check(
    'and it is on the send bar',
    await page.evaluate(
      () => !!document.querySelector('.kit-sendbar .gly-share'),
    ),
  );
  const label = await page.evaluate(
    () => document.querySelector('.gly-share')?.textContent || '',
  );
  check('the Share button reads its label', label === SHARE_LABEL, label);
  const sealText = await page.evaluate(
    () => document.getElementById('gly-seal')?.textContent || '',
  );
  check(
    'the approved bar says Approved and the time, and nothing about restarting',
    /^Approved \d\d:\d\d$/.test(sealText) &&
      !sealText.includes('restart galley edit'),
    sealText,
  );
  const reviseGone = await page.evaluate(() => {
    const el = document.getElementById('gly-revise');
    return !el || el.getBoundingClientRect().width === 0;
  });
  check('Revise has left the send bar', reviseGone);

  await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
  const items = await menuItems(page);
  const want = MAC
    ? [SHARE_DOWNLOAD_HTML, SHARE_DOWNLOAD_MD, SHARE_SHARE_HTML, SHARE_SHARE_MD]
    : [SHARE_DOWNLOAD_HTML, SHARE_DOWNLOAD_MD];
  check(
    `the menu holds ${MAC ? 'the downloads then the Shares' : 'the downloads and no Share (not macOS)'}, verbatim`,
    JSON.stringify(items) === JSON.stringify(want),
    items,
  );
  const seat = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.kit-share-menu')].find(
      (el) => el.getBoundingClientRect().height > 0,
    );
    const r = m?.getBoundingClientRect();
    const bar = document.querySelector('.kit-sendbar')?.getBoundingClientRect();
    return r && bar
      ? {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          barBottom: bar.bottom,
          w: window.innerWidth,
          h: window.innerHeight,
        }
      : null;
  });
  check(
    'with the bar at the foot of the window, the open menu lies wholly inside the window',
    !!seat &&
      seat.top >= 0 &&
      seat.left >= 0 &&
      seat.right <= seat.w &&
      seat.bottom <= seat.h,
    seat,
  );
  await page.click('.gly-share', { timeout: 5000 }).catch(() => {});

  check(
    'Download HTML downloads doc.html',
    (await downloadName(page, SHARE_DOWNLOAD_HTML)) === 'doc.html',
  );
  check(
    'Download Markdown downloads doc.md',
    (await downloadName(page, SHARE_DOWNLOAD_MD)) === 'doc.md',
  );

  if (MAC) {
    const startBefore = await approvedStart(page);
    await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
    await pick(page, SHARE_SHARE_HTML);
    const line = sharedLine(SAVED);
    const status = await statusSays(page, line);
    const startWith = await approvedStart(page);
    check(
      'Share HTML says the file is ready to paste',
      line === 'doc.html copied · paste to attach' && status.includes(line),
      status,
    );
    await page.waitForTimeout(SHARE_REPLY_MS + 1000);
    const cleared = await page.evaluate(
      () => document.getElementById('gly-status')?.textContent || '',
    );
    check(
      `the copied line clears itself after ${SHARE_REPLY_MS}ms`,
      !cleared.includes(line),
      cleared,
    );
    const startAfter = await approvedStart(page);
    check(
      'Approved starts at one x before, during and after the copied line',
      startBefore !== null &&
        [startWith, startAfter].every(
          (x) => x !== null && Math.abs(x - startBefore) <= 1,
        ),
      { startBefore, startWith, startAfter },
    );
    check('doc.html is beside doc.md', existsSync(SAVED), SAVED);
    if (existsSync(SAVED)) {
      const html = readFileSync(SAVED, 'utf8');
      check(
        'the saved page is the document, without the preview refresh',
        html.includes('A paragraph for the reader.') &&
          !html.includes('/_galley/saved'),
      );
    }
    await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
    await pick(page, SHARE_SHARE_MD);
    const mdStatus = await statusSays(page, sharedLine(DOC));
    check(
      'Share Markdown says the .md is ready to paste',
      mdStatus.includes('doc.md copied · paste to attach'),
      mdStatus,
    );
  }
}

// --- a page under review ------------------------------------------------------

{
  const page = await open(pageURL);
  check(
    'a page review has no HTML preview button',
    (await page.locator('.gly-preview-open').count()) === 0,
  );
  const approved = await approve(pageBase);
  check('the page approve was accepted', approved.ok, approved.status);
  await shareShown(page);
  check('the page review shows Share after approval', await shareVisible(page));
  await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
  const items = await menuItems(page);
  const want = MAC
    ? [SHARE_DOWNLOAD_HTML, SHARE_SHARE_HTML]
    : [SHARE_DOWNLOAD_HTML];
  check(
    `a page review offers ${MAC ? 'Download HTML and Share HTML' : 'only Download HTML (not macOS)'}`,
    JSON.stringify(items) === JSON.stringify(want),
    items,
  );
  await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
  check(
    'Download HTML downloads the page itself',
    (await downloadName(page, SHARE_DOWNLOAD_HTML)) === 'index.html',
  );
  if (MAC) {
    const before = readFileSync(PAGE, 'utf8');
    await page.click('.gly-share', { timeout: 5000 }).catch(() => {});
    await pick(page, SHARE_SHARE_HTML);
    const status = await statusSays(
      page,
      'index.html copied · paste to attach',
    );
    check(
      'Share HTML puts the page on the clipboard and says so',
      status.includes('index.html copied · paste to attach'),
      status,
    );
    check(
      'Share HTML leaves the page as it was',
      readFileSync(PAGE, 'utf8') === before,
    );
  }
}

console.log(
  counts().fails === 0
    ? '\nall share checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
