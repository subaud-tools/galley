// restart.mjs — A SERVER RESTART MID-REVISE LOSES NOTHING.
//
// `galley serve` holds every open review, and it is restarted whenever a new
// galley is installed, so this happens in the middle of real reviews. The Go
// tests pin each half against a server in process (TestRestartReloadsLiveDocuments,
// TestARestartMidWindowResumesInsteadOfLaundering); none has a page open on the
// document, so none can say the tab came back by itself. This gate stops and
// starts the real server under two open pages: one holding an unsent comment
// and a hand edit, the other with a Revise window open.
//
// The agent is --on-revise and `galley ack`, and the Revise is pressed before
// the stop, so nothing here depends on how soon a channel re-polls after a
// restart.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/restart.mjs

import { served } from './gateserve.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  cleanup,
  counts,
  launchOrSkip,
  onCleanup,
  until,
} from './build/probe.mjs';

const GALLEY = process.env.GALLEY || 'bin/galley';

const QUOTE = 'This sentence draws a comment nobody has sent.';
const COMMENT = 'is this still true?';
const TYPED = ' And these words were typed by hand.';
const ASKED = 'This sentence goes to the agent.';
const ASK = 'reword it';
const WORKING = 'rewording the sentence';
const ANSWER = 'This sentence came back from the agent.';
const ANSWERED = 'reworded the sentence';

const dir = mkdtempSync(join(tmpdir(), 'galley-restart-'));
onCleanup(() => rmSync(dir, { recursive: true, force: true }));
const notes = join(dir, 'notes.md');
const round = join(dir, 'round.md');
writeFileSync(notes, `# Unsent\n\n${QUOTE}\n`);
writeFileSync(round, `# In the window\n\n${ASKED}\n`);

const galley = (...args) => spawnSync(GALLEY, args, { encoding: 'utf8' });

const edit = (doc) =>
  served(
    spawn(GALLEY, ['edit', doc, '--no-open', '--on-revise', 'true'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
const notesAt = await edit(notes);
const roundAt = await edit(round);

const browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});
// One context, as one browser's tabs share one cookie.
const context = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
});
const open = async ({ url }) => {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  return page;
};
const notesPage = await open(notesAt);
const roundPage = await open(roundAt);

// A selection made through the editor (rounds-ux.mjs has the measured reason).
const select = (page, phrase) =>
  page.evaluate((want) => {
    const editor = window.galleyEdit.editor;
    let from = null;
    editor.state.doc.descendants((node, pos) => {
      const i = node.isTextblock ? node.textContent.indexOf(want) : -1;
      if (i !== -1) from = pos + 1 + i;
    });
    editor.commands.focus();
    editor.commands.setTextSelection({ from, to: from + want.length });
    editor.view.focus();
  }, phrase);

const pending = async ({ base }) =>
  (
    (await (await fetch(`${base}/_galley/pending`)).json()).instructions || []
  ).map((i) => i.text);

async function comment(page, at, quote, ask) {
  await page.bringToFront();
  await select(page, quote);
  await page.click('.gly-composer .gly-comment-button');
  await page.fill('.gly-composer .gly-composer-text', ask);
  await page.click('.gly-composer .gly-composer-send');
  return until(async () => (await pending(at)).includes(ask), 15000);
}

const docText = (page) =>
  page.evaluate(() => window.galleyEdit.editor.state.doc.textContent);

const message = async ({ base }) => {
  const s = await (await fetch(`${base}/_galley/revise`)).json();
  return { state: s.message?.state, line: s.message?.line, handoff: s.handoff };
};
const pill = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.gly-msg .kit-pill');
    return el ? el.dataset.state : null;
  });

// --- the state a restart must keep ------------------------------------------

check(
  'the unsent comment is filed',
  await comment(notesPage, notesAt, QUOTE, COMMENT),
);
await notesPage.evaluate(
  ([quote]) => {
    const editor = window.galleyEdit.editor;
    let end = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.includes(quote)) {
        end = pos + 1 + node.content.size;
      }
    });
    editor.commands.focus();
    editor.commands.setTextSelection(end);
    editor.view.focus();
  },
  [QUOTE],
);
await notesPage.keyboard.type(TYPED);
check(
  'the hand edit is saved',
  await until(() => readFileSync(notes, 'utf8').includes(TYPED), 15000),
);

check('the Revise is filed', await comment(roundPage, roundAt, ASKED, ASK));
await roundPage.click('#gly-revise');
await roundPage.waitForSelector('.gly-verdict-menu .gly-verdict-revise');
await roundPage.click('.gly-verdict-menu .gly-verdict-revise');
check(
  'the press reached the server',
  await until(async () => (await message(roundAt)).state === 'sent', 15000),
);
const acked = galley('ack', round, '--state', 'working', '--note', WORKING);
check(
  '`galley ack --state working` exited 0',
  acked.status === 0,
  acked.stderr,
);
check(
  'the Revise window is open',
  await until(async () => {
    const m = await message(roundAt);
    return m.handoff && m.state === 'working';
  }, 15000),
  JSON.stringify(await message(roundAt)),
);

// --- the restart ------------------------------------------------------------

// A mark on each tab that only a reload wipes.
for (const page of [notesPage, roundPage]) {
  await page.evaluate(() => {
    window.beforeRestart = true;
  });
}
// `galley serve` is the server itself, so the start is a child of its own.
const stopped = galley('serve', '--stop');
check('`galley serve --stop` exited 0', stopped.status === 0, stopped.stderr);
check(
  'the server is down',
  await fetch(`${notesAt.base}/_galley/pending`).then(
    () => false,
    () => true,
  ),
);
spawn(GALLEY, ['serve', '--no-open'], { stdio: 'ignore' });

// --- both documents came back, and both tabs by themselves ------------------

for (const [name, page] of [
  ['the comment and edit', notesPage],
  ['the Revise', roundPage],
]) {
  check(
    `the tab holding ${name} reloaded by itself`,
    await until(
      () =>
        page.evaluate(
          () => !window.beforeRestart && !!window.galleyEdit?.editor,
        ),
      30000,
    ),
  );
}

const pendingAfter = await until(async () => {
  const list = await pending(notesAt);
  return list.includes(COMMENT) ? list : null;
}, 15000);
check('the unsent comment is still pending', !!pendingAfter);
check(
  'and its card is back on the page',
  await until(
    () =>
      notesPage.evaluate(
        (ask) =>
          [...document.querySelectorAll('.gly-rail-band .gly-thread')].some(
            (t) => t.textContent.includes(ask),
          ),
        COMMENT,
      ),
    15000,
  ),
);
check(
  'the hand edit is in the editor',
  await until(async () => (await docText(notesPage)).includes(TYPED), 15000),
  await docText(notesPage),
);
check(
  'and on disk',
  readFileSync(notes, 'utf8').includes(TYPED),
  readFileSync(notes, 'utf8'),
);

const resumed = await message(roundAt);
check(
  'the Revise window is resumed, with the agent still holding it',
  resumed.handoff && resumed.state === 'working' && resumed.line === WORKING,
  JSON.stringify(resumed),
);
check(
  'and the page says so',
  await until(async () => (await pill(roundPage)) === 'working', 15000),
  await pill(roundPage),
);

// --- the agent's answer lands on the restarted server -----------------------

writeFileSync(round, readFileSync(round, 'utf8').replace(ASKED, ANSWER));
const answered = galley(
  'ack',
  round,
  '--state',
  'answered',
  '--note',
  ANSWERED,
);
check(
  '`galley ack --state answered` exited 0',
  answered.status === 0,
  answered.stderr,
);
check(
  'the answer settles the Revise',
  await until(async () => {
    const m = await message(roundAt);
    return !m.handoff && m.state === 'answered' && m.line === ANSWERED;
  }, 20000),
  JSON.stringify(await message(roundAt)),
);
check(
  'the page shows it answered',
  await until(async () => (await pill(roundPage)) === 'answered', 15000),
  await pill(roundPage),
);
check(
  "the agent's words are in the reviewer's editor",
  await until(async () => (await docText(roundPage)).includes(ANSWER), 20000),
  await docText(roundPage),
);

await cleanup();
console.log(`\n${counts().passes} passed, ${counts().fails} failed`);
process.exit(counts().fails ? 1 : 0);
