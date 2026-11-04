// keys.mjs — THE PAGE'S KEYS ARE THE KIT'S KEYBOARD LAYER.
//
// galley registers its keys with the kit's createKeys: the Esc chain as Esc
// closers, j/k through the drafts, the menu's ↓/↑, and Find a review as `/`.
// What only a browser can see, and so what this gate measures:
//
//   · With the caret in the document, j, k, / and ? are letters: they go into
//     the text and no page key takes them.
//   · ? opens the kit's overlay, listing galley's keys and its Esc chain.
//   · / focuses Find a review.
//   · ↓ scrolls the page when nothing of galley's is open, and walks galley's
//     menu when it is.
//   · j walks the drafts on the text.
//   · Esc in a grip's composer closes it and puts focus back on the grip.
//   · Esc in History unpins a pinned change first, then closes History.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/keys.mjs

import { served } from './gateserve.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'galley-keys-'));
const doc = join(dir, 'keys.md');
// Long enough that the window scrolls.
const filler = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} is here so the page is taller than the window.`,
).join('\n\n');
const FIRST = 'The retry budget should stay explicit and readable.';
writeFileSync(doc, `# Keys\n\n${FIRST}\n\n${filler}\n`);

const server = spawn(
  GALLEY,
  ['edit', doc, '--no-open', '--on-revise', 'true'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverOutput = '';
server.stdout.on('data', (d) => {
  serverOutput += d;
});
server.stderr.on('data', (d) => {
  serverOutput += d;
});

let browser;

async function waitFor(page, fn, arg, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() > until) return false;
    await page.waitForTimeout(50);
  }
}

// Focus on nothing: the page's keys, not a field's.
const blur = (page) =>
  page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.getSelection()?.removeAllRanges();
  });

// The words selected through the editor, as rounds-ux.mjs does it.
async function selectPhrase(page, phrase) {
  await page.evaluate((want) => {
    const editor = window.galleyEdit.editor;
    let at = null;
    editor.state.doc.descendants((node, pos) => {
      if (at !== null || !node.isTextblock) return at === null;
      const i = node.textContent.indexOf(want);
      if (i !== -1) at = pos + 1 + i;
      return false;
    });
    if (at === null) throw new Error(`fixture text not found: ${want}`);
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + want.length });
    editor.view.focus();
  }, phrase);
  await page.waitForFunction(() => {
    const b = document.querySelector('.gly-comment-button');
    return !!b && b.offsetParent !== null;
  });
}

const pendingCount = (page) =>
  page.evaluate(
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length,
  );

// A round the agent answers by rewriting the file, so History has a change.
async function oneRound(page) {
  await page
    .locator('.kit-rail-tabrow .kit-ctl', { hasText: 'Instructions' })
    .click();
  await page.fill('#gly-doc-box', 'Say how many attempts.');
  await page.click('.gly-tab .kit-note-line .kit-btn');
  await waitFor(page, async () => {
    const r = await (await fetch('_galley/pending')).json();
    return r.instructions.length === 2;
  });
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#gly-revise');
      return !!b && !b.disabled && b.offsetParent !== null;
    },
    null,
    { timeout: 10000 },
  );
  await page.click('#gly-revise');
  const opened = await waitFor(
    page,
    async () => (await (await fetch('_galley/revise')).json()).handoff,
  );
  if (!opened) throw new Error('the round never opened its window');
  writeFileSync(
    doc,
    `# Keys\n\nThe retry budget is 12 attempts over 48 hours.\n\n${filler}\n`,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('.ProseMirror').innerText.includes('12 attempts'),
    null,
    { timeout: 15000 },
  );
  const status = await page.evaluate(
    async () =>
      (
        await fetch('_galley/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'answered', note: 'Said how many.' }),
        })
      ).status,
  );
  if (status !== 204) throw new Error(`ack answered ${status}`);
  await waitFor(
    page,
    async () => !(await (await fetch('_galley/revise')).json()).handoff,
  );
  await page.waitForTimeout(900);
}

try {
  const { url } = await served(server);
  browser = await launchOrSkip({
    required: true,
    ...(process.env.GALLEY_CHROME
      ? { executablePath: process.env.GALLEY_CHROME }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 800 },
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => !!window.galleyEdit?.app);

  // --- in the document, the keys are letters ---
  await page.evaluate((first) => {
    const editor = window.galleyEdit.editor;
    let end = null;
    editor.state.doc.descendants((node, pos) => {
      if (end !== null || !node.isTextblock) return end === null;
      if (node.textContent === first) end = pos + 1 + first.length;
      return false;
    });
    editor.commands.focus();
    editor.commands.setTextSelection(end);
    editor.view.focus();
  }, FIRST);
  await page.keyboard.type(' jk/?');
  await page.waitForTimeout(200);
  const typed = await page.evaluate(() => ({
    text: window.galleyEdit.editor.state.doc.textContent,
    overlay: !!document.querySelector('.kit-keys'),
    focus: document.activeElement?.className || '',
  }));
  check(
    'with the caret in the document, j, k, / and ? go into the text',
    typed.text.includes(`${FIRST.slice(0, -1)}. jk/?`) &&
      !typed.overlay &&
      /ProseMirror/.test(typed.focus),
    JSON.stringify({ overlay: typed.overlay, focus: typed.focus }),
  );
  // Put the document back as it was.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check(
    'and Esc in the document leaves it, with nothing open',
    !(await page.evaluate(() =>
      document.activeElement?.classList.contains('ProseMirror'),
    )),
  );

  // --- ? opens the overlay with galley's keys ---
  await blur(page);
  await page.keyboard.press('?');
  const overlay = await page
    .waitForSelector('.kit-keys', { timeout: 3000 })
    .then(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.kit-keys .kit-keys-row')].map((r) =>
          r.innerText.replace(/\s+/g, ' ').trim(),
        ),
      ),
    )
    .catch(() => []);
  const has = (re) => overlay.some((r) => re.test(r));
  check(
    '? opens the overlay listing galley’s keys',
    has(/^j .*next draft/) &&
      has(/^k .*previous draft/) &&
      has(/^↓ .*menu/) &&
      has(/^\/ .*search/),
    JSON.stringify(overlay),
  );
  const escRows = overlay.filter((r) => /^Esc /.test(r));
  check(
    'and its Esc rows are galley’s chain, in order, before leaving the field',
    escRows.length === 5 &&
      /menu/.test(escRows[0]) &&
      /instruction/.test(escRows[1]) &&
      /unpin/.test(escRows[2]) &&
      /History/.test(escRows[3]) &&
      /leave field/.test(escRows[4]),
    JSON.stringify(escRows),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(
    'Esc closes the overlay',
    (await page.locator('.kit-keys').count()) === 0,
  );

  // --- / focuses Find a review ---
  await blur(page);
  await page.keyboard.press('/');
  await page.waitForTimeout(100);
  const found = await page.evaluate(() => ({
    focus: document.activeElement?.getAttribute('aria-label'),
    value: document.activeElement?.value,
  }));
  check(
    '/ focuses Find a review, and types nothing into it',
    found.focus === 'Find a review' && found.value === '',
    JSON.stringify(found),
  );
  await page.keyboard.press('Escape');
  // At 1080 wide or less the left panel is a strip: / brings it out first.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(200);
  await blur(page);
  await page.keyboard.press('/');
  await page.waitForTimeout(200);
  const narrowFound = await page.evaluate(() => {
    const find = document.activeElement;
    const r = find?.getBoundingClientRect();
    return {
      focus: find?.getAttribute('aria-label'),
      shown: !!r && r.width > 0 && r.right <= window.innerWidth,
    };
  });
  check(
    'and at 1000 wide / brings the left panel out to Find a review',
    narrowFound.focus === 'Find a review' && narrowFound.shown,
    JSON.stringify(narrowFound),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForTimeout(200);

  // --- the arrows still scroll ---
  await blur(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(() => window.scrollY);
  check('↓ scrolls the page', scrolled > 0, String(scrolled));
  await page.evaluate(() => window.scrollTo(0, 0));

  // --- the round row stays under the bar (not a key: this fixture is long) ---
  for (const width of [1400, 864]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    await page.evaluate(() =>
      window.scrollTo(
        0,
        (document.documentElement.scrollHeight - window.innerHeight) / 2,
      ),
    );
    await page.waitForTimeout(200);
    const row = await page.evaluate(() => {
      const bar = document.querySelector('.kit-bar').getBoundingClientRect();
      const stages = document.querySelector('.gly-stages');
      const seen = (sel) => {
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        if (!r || !r.width) return false;
        const at = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return !!at && el.contains(at);
      };
      return {
        scrolled: window.scrollY,
        bar: bar.bottom,
        top: stages.getBoundingClientRect().top,
        bg: getComputedStyle(stages).backgroundColor,
        history: seen('.gly-versions-open'),
        preview: seen('.gly-preview-open'),
      };
    });
    check(
      `at ${width} wide, scrolled mid-document, the round row sits under the bar with History and HTML preview in view`,
      row.scrolled > 200 &&
        Math.abs(row.top - row.bar) <= 1 &&
        row.history &&
        row.preview &&
        row.bg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(row),
    );
  }
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));

  // --- the menu's ↓, then Esc closes the menu ---
  const margin = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror').getBoundingClientRect();
    return { x: Math.max(8, pm.left / 2), y: pm.top + 60 };
  });
  await page.mouse.click(margin.x, margin.y, { button: 'right' });
  await page.waitForSelector('.gly-menu', { state: 'visible', timeout: 3000 });
  await page.keyboard.press('ArrowDown');
  const inMenu = await page.evaluate(
    () => !!document.activeElement?.classList.contains('gly-menu-item'),
  );
  const scrollMenu = await page.evaluate(() => window.scrollY);
  check(
    'with galley’s menu open, ↓ walks the menu and not the page',
    inMenu && scrollMenu === 0,
    JSON.stringify({ inMenu, scrollMenu }),
  );
  await page.keyboard.press('Escape');
  check(
    'Esc puts the menu away',
    !(await page.locator('.gly-menu').isVisible()),
  );

  // --- j walks the drafts on the text ---
  await selectPhrase(page, 'explicit and readable');
  await page.click('.gly-comment-button');
  await page.fill('.gly-composer-text', 'Name the number.');
  await page.click('.gly-composer-send');
  await waitFor(page, async () => {
    const r = await (await fetch('_galley/pending')).json();
    return r.instructions.length === 1;
  });
  await page.waitForTimeout(500);
  await blur(page);
  await page.evaluate(() => {
    window.galleyEdit.app.stepped = null;
  });
  await page.keyboard.press('j');
  const stepped = await page.evaluate(() => window.galleyEdit.app.stepped);
  check('j steps to the draft on the text', !!stepped, String(stepped));
  await blur(page);

  // --- Esc in a grip's composer: closed, focus on the grip ---
  await page.click('.gly-block-grip[data-kind="heading"]', { timeout: 5000 });
  await page.waitForSelector('.gly-composer-form:not([hidden])', {
    timeout: 5000,
  });
  await page.focus('.gly-composer-text');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const closed = await page.evaluate(() => ({
    hidden: document.querySelector('.gly-composer')?.hidden,
    grip: !!document.activeElement?.classList.contains('gly-block-grip'),
  }));
  check(
    'Esc in a grip’s composer closes it and puts focus back on its grip',
    closed.hidden === true && closed.grip,
    JSON.stringify(closed),
  );

  // --- Esc in History: unpin, then close ---
  if ((await pendingCount(page)) !== 1) throw new Error('fixture drifted');
  await oneRound(page);
  await page.click('.gly-versions-open');
  // History opens on the round just read, or on its list, which may still be
  // redrawing as the round lands: press the newest round until its changes show.
  for (let i = 0; i < 20; i++) {
    if (await page.locator('.gly-versions-change[data-region]').count()) break;
    await page
      .locator('.gly-versions-round[data-round]')
      .first()
      .click({ timeout: 1000 })
      .catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('.gly-versions-change[data-region]', {
    timeout: 5000,
  });
  await page.click('.gly-versions-change[data-region]');
  await page.keyboard.press('Escape');
  const first = await page.evaluate(() => ({
    open: !document.querySelector('.gly-versions').hidden,
    picked: document.querySelectorAll('.gly-versions-change.is-picked').length,
  }));
  check(
    'Esc in History unpins the change and stays in History',
    first.open && first.picked === 0,
    JSON.stringify(first),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const second = await page.evaluate(() => ({
    hidden: document.querySelector('.gly-versions')?.hidden,
    mode: document.body.classList.contains('gly-history-mode'),
  }));
  check(
    'and the next Esc closes History',
    second.hidden === true && !second.mode,
    JSON.stringify(second),
  );
} finally {
  onCleanup(
    () =>
      new Promise((done) => {
        if (server.exitCode !== null || server.signalCode !== null)
          return done();
        const cap = setTimeout(() => server.kill('SIGKILL'), 10000);
        server.once('exit', () => {
          clearTimeout(cap);
          done();
        });
        server.kill('SIGTERM');
      }),
  );
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  await cleanup();
}

if (counts().fails) {
  if (serverOutput.trim()) console.log(serverOutput.trim());
  process.exit(1);
}
