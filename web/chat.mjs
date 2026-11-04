// chat.mjs — CHAT TALKS TO THE AGENT, AND NEVER TO THE DOCUMENT.
//
// The Chat tab is a conversation with the agent, built from the kit's thread:
// its note box (`Message the agent…`, then `Send`) posts a message, the agent
// is woken with it as a `chat` wake, and its galley_reply shows under the
// message with the kit's states. What only a browser can see, and so what this
// gate measures, at 1440×900 against a real `galley serve`:
//
//   · The box, its placeholder, its Send button and the hint under it.
//   · Enter sends: the message shows with the pill `sent`.
//   · A read of /_galley/wait is woken with reason `chat` and the words, and
//     the pill turns `with the agent`.
//   · A `working` reply shows its line under the pill; an `answered` reply in
//     markdown shows as the agent's message, rendered (`<strong>`).
//   · A Revise still shows its line, `Revise · round 1`, in the same thread.
//   · The document's words never change through any of it.
//   · After approve the box is gone and the messages stay.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/chat.mjs

import { served } from './gateserve.mjs';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, counts, launchOrSkip, sleep, until } from './build/probe.mjs';

const GALLEY = process.env.GALLEY || 'bin/galley';
const HERE = realpathSync(mkdtempSync(join(tmpdir(), 'galley-chat-')));
const DOC = join(HERE, 'doc.md');
const WORDS = '# Chat me\n\nA paragraph the agent explains.\n';
writeFileSync(DOC, WORDS);

const PLACEHOLDER = 'Message the agent…';
const HINT =
  "The agent reads it now and answers here. It doesn't change the document; instructions and Revise do.";
const PANEL = '.kit-rail-panel[aria-label="Chat"]';

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

const child = spawn(GALLEY, ['edit', DOC, '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(child);
const { base, url } = await served(child);

const postJSON = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const wait = async (timeout = '10s') => {
  const res = await fetch(`${base}/_galley/wait?timeout=${timeout}`);
  return res.ok ? res.json() : { reason: `http-${res.status}` };
};
const unchanged = () => readFileSync(DOC, 'utf8') === WORDS;

browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.ProseMirror', { timeout: 15000 });
await page.click('.kit-rail-tabrow button:has-text("Chat")');

const box = page.locator(`${PANEL} textarea`);
check(
  `the Chat tab has a box saying ${PLACEHOLDER}`,
  (await box.count()) === 1 &&
    (await box.getAttribute('placeholder')) === PLACEHOLDER,
);
const send = page.locator(`${PANEL} .kit-note-line .kit-btn`);
check(
  'the box has a button saying Send',
  (await send.count()) === 1 && (await send.innerText()).trim() === 'Send',
);
// Instructions and Chat open in one shape, so switching tabs moves nothing:
// the tab row stays put, each tab's box sits at the same height, and its button
// sits under the box at its right edge. Chat's label says who it is with.
{
  const shape = (tab) =>
    page.evaluate((tab) => {
      const at = (e) => e?.getBoundingClientRect().toJSON() ?? null;
      const panel = document.querySelector(
        `.kit-rail-panel[aria-label="${tab}"]`,
      );
      const box = panel.querySelector('textarea');
      const btn = panel.querySelector('.kit-note-line .kit-btn');
      return {
        row: at(document.querySelector('.kit-rail-tabrow')),
        label: panel.querySelector('.kit-label')?.textContent ?? '',
        heading: !!panel.querySelector('.kit-thread-name'),
        box: at(box),
        btn: at(btn),
      };
    }, tab);
  const tabTo = async (tab) => {
    await page.click(`.kit-rail-tabrow button:has-text("${tab}")`);
    await page.waitForTimeout(100);
  };
  await tabTo('Instructions');
  const ins = await shape('Instructions');
  await tabTo('Chat');
  const chat = await shape('Chat');
  const under = (s) =>
    s.box &&
    s.btn &&
    s.btn.top >= s.box.bottom &&
    Math.abs(s.btn.right - s.box.right) <= 1;
  check(
    'switching Instructions to Chat leaves the tab row and the box where they were',
    !!ins.row &&
      !!chat.row &&
      ins.row.top === chat.row.top &&
      !!ins.box &&
      !!chat.box &&
      ins.box.top === chat.box.top &&
      ins.box.left === chat.box.left &&
      ins.box.width === chat.box.width,
    JSON.stringify({ ins, chat }),
  );
  check(
    "Chat's label reads With the agent, with no heading, and Send sits under its box at the right, as Add instruction does",
    chat.label === 'With the agent' &&
      !chat.heading &&
      under(chat) &&
      under(ins),
    JSON.stringify({ ins, chat }),
  );
}
check(
  'the hint is under the box',
  (
    await page
      .locator(`${PANEL} .gly-chat-hint`)
      .innerText({ timeout: 2000 })
      .catch(() => '')
  ).trim() === HINT,
);

// The pill of the reviewer's message holding `words`.
const pillOf = (words) =>
  page.evaluate(
    ({ panel, words }) => {
      const msg = [
        ...document.querySelectorAll(`${panel} .kit-thread-msg.user`),
      ].find((m) => m.textContent.includes(words));
      return {
        pill: msg?.querySelector('.kit-pill')?.textContent ?? '',
        line: msg?.querySelector('.kit-msg-line')?.textContent ?? '',
      };
    },
    { panel: PANEL, words },
  );

await box.fill('Why this title?');
await box.press('Enter');
check(
  'Enter sends, and the message shows sent',
  await until(async () => (await pillOf('Why this title?')).pill === 'sent'),
  await pillOf('Why this title?'),
);
check('the box is empty once it is sent', (await box.inputValue()) === '');

const woke = await wait();
check(
  'a read of the wait is woken with the chat and its words',
  woke.reason === 'chat' && woke.chat?.text === 'Why this title?',
  JSON.stringify(woke.chat ?? woke.reason),
);
const id = woke.chat?.id ?? 0;
check(
  'the pill turns with the agent',
  await until(
    async () => (await pillOf('Why this title?')).pill === 'with the agent',
    6000,
  ),
  await pillOf('Why this title?'),
);

await postJSON('/_galley/chat/reply', {
  message: id,
  state: 'working',
  text: 'Reading the opening',
});
check(
  'a working reply shows its line under the pill',
  await until(async () => {
    const p = await pillOf('Why this title?');
    return p.pill === 'working' && p.line === 'Reading the opening';
  }, 6000),
  await pillOf('Why this title?'),
);

await postJSON('/_galley/chat/reply', {
  message: id,
  state: 'answered',
  text: 'It names the **topic**.',
});
const agentStrong = () =>
  page.evaluate(
    (panel) =>
      document.querySelector(`${panel} .kit-thread-msg.agent strong`)
        ?.textContent ?? '',
    PANEL,
  );
check(
  'the answer shows as the agent, its markdown rendered',
  await until(async () => (await agentStrong()) === 'topic', 6000),
);
check(
  'the message reads answered',
  (await pillOf('Why this title?')).pill === 'answered',
);
check('chat changed nothing in the document', unchanged());

// A Revise still has its line in the thread.
await postJSON('/_galley/instruct', {
  op: 'comment_document',
  text: 'Tighten it.',
  author: 'user',
});
check(
  'the instruction reaches Revise',
  await until(
    async () =>
      (await page.locator('#gly-revise').innerText()).includes(
        'Revise · send 1',
      ),
    8000,
  ),
);
const revised = wait('15s');
await sleep(300);
await page.click('#gly-revise');
check('the agent is woken with the round', (await revised).reason === 'revise');
const roundLine = () =>
  page.evaluate(
    (panel) => document.querySelector(panel)?.textContent ?? '',
    PANEL,
  );
check(
  'the round line Revise · round 1 is in the thread',
  await until(
    async () => (await roundLine()).includes('Revise · round 1'),
    8000,
  ),
);
await postJSON('/_galley/ack', {
  state: 'answered',
  note: 'Nothing to tighten.',
});
check('the document is still as it was', unchanged());

// Approved: the thread stays and the box goes.
await sleep(1500);
const approved = await postJSON('/_galley/revise', { verdict: 'approve' });
check('the approve is taken', approved.status === 204, approved.status);
check(
  'after approve the box is gone',
  await until(
    async () =>
      !(await page.evaluate(
        (panel) =>
          [...document.querySelectorAll(`${panel} textarea`)].some(
            (t) => t.getBoundingClientRect().height > 0,
          ),
        PANEL,
      )),
    8000,
  ),
);
check(
  'after approve the messages stay',
  (await roundLine()).includes('Why this title?') &&
    (await agentStrong()) === 'topic',
);

console.log(
  counts().fails === 0
    ? '\nall chat checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
