// revise.mjs — ONE REVISE, WALKED END TO END THROUGH THE REAL BINARY AND PAGE.
//
// A Revise is a message the reviewer sends: it is sent, the agent's harness
// reports it landed, the agent says it is working, and it is answered — or the
// turn ends with no reply and the reviewer sends it again, or the reviewer
// takes the document back. The Go tests pin each move against the server in
// process (report_test.go, resend_test.go, handoff_test.go); none of them has a
// page bound to the document, so none can say whether the pill beside Revise
// and the button itself followed. This gate walks the whole lifecycle once and
// at every step reads BOTH halves: the server's revise state (GET
// /_galley/revise, the payload the page polls) and the page (the pill's state,
// the line under it, and whether Revise can be pressed). A check that fails
// says which half disagreed.
//
// THE WALK:
//
//   open → the reviewer files an instruction and presses Revise (sent) → the
//   harness reports it landed (with the agent) → the agent acks working → a
//   press with nothing new while the agent has it sends nothing (#119) → the
//   agent answers (answered) → a second Revise, landed, and the turn ends with
//   no reply → Revise again sends the same instruction again → answered → a
//   third Revise is cancelled from the page, and its instruction is back on
//   the page → Revise & Approve sends it again, and the answer closes the
//   review.
//
// HOW THE AGENT IS PLAYED. This file re-invoked with --agent, as page.mjs and
// livestructure.mjs do. It is two things, as a real session under galley's
// channel is: a reader always blocked on GET /_galley/wait (the channel), and
// a turn that runs the real CLI verbs — `galley report`, `galley ack`, `galley
// revise` — and edits the file. The reader uses the endpoint rather than
// `galley wait` because only the endpoint's reply carries the wake's report
// token, which is what `galley report landed` names; that is also what the
// channel reads. The turn runs exactly the commands the reviewer half hands
// it, one at a time, so every step happens when the check before it has seen
// the state it expects, and nothing here waits on the clock.
//
// `galley report` delivers to the editors the session owns, so the editor is
// started with --owner, and the session's presence (which --owner requires) is
// a record in a registry of this run's own (GALLEY_LIVE_DIR) naming this
// process. Nothing reaches the machine's real registry.
//
// THE RACES ARE NOT REPRODUCED HERE. The lease and resend races are pinned by
// deterministic Go tests (lease_race_test.go, resend_test.go); a browser gate
// could only produce them by luck. This walks the ordinary sequence.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/revise.mjs
//
// It needs a chromium for playwright to drive: `npx playwright install
// chromium` once, or GALLEY_CHROME=<executable>. There is a `just revise`
// recipe, it is in `just gates`, and it is a step of its own in ci.yml.

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GALLEY = process.env.GALLEY || 'bin/galley';
const PORT = Number(process.env.PORT || 8278);
const SESSION = 'revise-gate-session';

const FIRST = 'The first paragraph is where the reviewer asks for a change.';
const FIRST_NEW = 'The first paragraph changed because the reviewer asked.';
const SECOND = 'The second paragraph waits for an answer that never comes.';
const SECOND_NEW = 'The second paragraph got its answer on the second try.';
const THIRD = 'The third paragraph is asked about and then taken back.';
const THIRD_NEW = 'The third paragraph was taken back and then sent again.';
const FIXTURE = `# Revise lifecycle\n\n${FIRST}\n\n${SECOND}\n\n${THIRD}\n`;

const ASK_1 = 'say that it changed because the reviewer asked';
const ASK_2 = 'say that it got its answer on the second try';
const ASK_3 = 'rewrite this one too';
const WORKING = 'rewording the first paragraph';
const ANSWERED_1 = 'reworded the first paragraph';
const ANSWERED_2 = 'reworded the second paragraph';
const ANSWERED_3 = 'reworded the third paragraph';

// The process environment with the harness's session ids taken out, so the
// session a child reports for is this run's and never the one running it.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.AGENT_SESSION_CHILD;
  return env;
}

// --- the agent half ---------------------------------------------------------

// channelLoop is the reader: blocked on the wait at all times, as galley's
// channel is, and every wake journaled with its reason, its instructions and
// its report token. It ends when the editor says it closed.
async function channelLoop(base, say, tokens) {
  let fp = '';
  let n = 0;
  for (;;) {
    const q = fp ? `&since=${encodeURIComponent(fp)}` : '';
    let body;
    try {
      const res = await fetch(`${base}/_galley/wait?timeout=20s${q}`);
      body = await res.json();
    } catch (e) {
      say({ step: 'reader-lost', err: String(e) });
      process.exit(0);
    }
    fp = body.fingerprint || fp;
    if (body.reason === 'timeout') {
      continue;
    }
    n += 1;
    tokens[n] = body.report || '';
    say({
      step: 'wake',
      n,
      reason: body.reason,
      report: body.report || '',
      instructions: ((body.pending || {}).instructions || []).map(
        (i) => i.text,
      ),
    });
    // The review is over on approve and the editor is gone on closed: a
    // reader stops on either, as the channel does.
    if (body.reason === 'closed') {
      process.exit(0);
    }
    if (body.reason === 'approve') {
      return;
    }
  }
}

// runCommand is one step of the agent's turn, with the real CLI.
function runCommand(cmd, doc, tokens) {
  const galley = (...args) => {
    const r = spawnSync(GALLEY, args, { encoding: 'utf8', env: cleanEnv() });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
  };
  switch (cmd.do) {
    case 'report':
      return cmd.event === 'turn-ended'
        ? galley('report', 'turn-ended')
        : galley('report', cmd.event, tokens[cmd.wake] || 'no-token');
    case 'ack':
      return galley('ack', doc, '--state', cmd.state, '--note', cmd.note);
    case 'revise':
      return galley('revise', doc);
    case 'edit': {
      const before = readFileSync(doc, 'utf8');
      writeFileSync(doc, before.replace(cmd.from, cmd.to));
      return { code: before.includes(cmd.from) ? 0 : 1, out: '', err: '' };
    }
    default:
      return { code: 2, out: '', err: `unknown command ${cmd.do}` };
  }
}

async function agentMain(base, doc, journalPath, commandsPath) {
  const say = (line) =>
    appendFileSync(journalPath, `${JSON.stringify(line)}\n`);
  const tokens = [];
  void channelLoop(base, say, tokens);
  let done = 0;
  for (;;) {
    const lines = readFileSync(commandsPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    while (done < lines.length) {
      const cmd = JSON.parse(lines[done]);
      const r = runCommand(cmd, doc, tokens);
      done += 1;
      say({ step: 'did', i: done, code: r.code, err: r.err.trim() });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

if (process.argv[2] === '--agent') {
  await agentMain(
    process.argv[3],
    process.argv[4],
    process.argv[5],
    process.argv[6],
  );
}

// --- the reviewer half ------------------------------------------------------

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok    ${name}`);
    return;
  }
  failures += 1;
  console.log(
    `FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail, null, 1)}`}`,
  );
}

const HERE = mkdtempSync(join(tmpdir(), 'galley-revise-'));
const DOC = join(HERE, 'lifecycle.md');
const JOURNAL = join(HERE, 'agent.jsonl');
const COMMANDS = join(HERE, 'commands.jsonl');
const DEBUG = join(HERE, 'debug.jsonl');
const LIVE = join(HERE, 'live');
writeFileSync(DOC, FIXTURE);
writeFileSync(JOURNAL, '');
writeFileSync(COMMANDS, '');
// The session's presence: this process stands in for the channel, so the
// editor's --owner names a live session and `galley report` reaches it.
mkdirSync(join(LIVE, 'sessions'), { recursive: true });
writeFileSync(
  join(LIVE, 'sessions', `${SESSION}.json`),
  JSON.stringify({ v: 1, session: SESSION, pid: process.pid }),
);
process.env.GALLEY_LIVE_DIR = LIVE;
process.env.AGENT_SESSION_ID = SESSION;

// THE PORT IS THIS RUN'S, OR THE RUN DOES NOT START: the wait below is for
// `/` answering, and another galley already on the port would answer it
// (galley#10, #128).
const taken = await fetch(`http://127.0.0.1:${PORT}/`).then(
  () => true,
  () => false,
);
if (taken) {
  console.log(
    `port ${PORT} already answers: another galley is serving there (run the gates one at a time, or set PORT)`,
  );
  process.exit(1);
}

const server = spawn(
  GALLEY,
  ['edit', DOC, '--no-open', '--port', String(PORT), '--owner', SESSION],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({ GALLEY_DEBUG: DEBUG }),
  },
);
let serverSaid = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (b) => {
    serverSaid += b;
  });
}
let serverExit = null;
server.on('exit', (code, signal) => {
  serverExit = { code, signal };
});

let agent = null;
let browser = null;
process.on('exit', () => {
  try {
    const proc = browser && browser.process();
    if (proc) proc.kill('SIGKILL');
  } catch {
    // Already gone.
  }
  for (const child of [agent, server]) {
    try {
      if (child) child.kill('SIGTERM');
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

const { chromium } = await (async () => {
  const where = process.env.GALLEY_PW;
  if (where) {
    const { createRequire } = await import('node:module');
    return createRequire(join(where, 'noop.js'))('playwright-core');
  }
  return import('playwright-core');
})();

// until polls pred until it holds, and throws naming the step when it does
// not within ms. Every wait in this file is one of these: on a state, never on
// the clock.
async function until(step, ms, pred) {
  const started = Date.now();
  for (;;) {
    let got;
    try {
      got = await pred();
    } catch {
      got = null;
    }
    if (got) return got;
    if (Date.now() - started > ms) {
      throw new Error(`timed out after ${ms}ms waiting for: ${step}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

const base = `http://127.0.0.1:${PORT}`;
await until('the editor to serve its page', 20000, async () => {
  if (serverExit) {
    throw new Error(`the editor exited: ${serverSaid.trim()}`);
  }
  return (await fetch(`${base}/`)).ok;
}).catch((e) => {
  console.log(`FAIL  ${e.message}\n${serverSaid.trim()}`);
  process.exit(1);
});

const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const wakes = () => lines(JOURNAL).filter((l) => l.step === 'wake');
const revises = () => wakes().filter((w) => w.reason === 'revise');

// readerAttached is whether the agent's reader is blocked on the wait now —
// the last waiter event in galley's own debug record says so. A press with
// no reader and no --on-revise is refused, so each press waits on this.
const readerAttached = () => {
  if (!existsSync(DEBUG)) return false;
  const ev = lines(DEBUG).filter(
    (l) => l.kind === 'agent.attached' || l.kind === 'agent.detached',
  );
  return ev.length > 0 && ev[ev.length - 1].waiting > 0;
};

// tell hands the agent's turn one command and waits for it to be done.
let told = 0;
async function tell(cmd) {
  appendFileSync(COMMANDS, `${JSON.stringify(cmd)}\n`);
  told += 1;
  const i = told;
  return until(`the agent to run ${JSON.stringify(cmd)}`, 30000, () =>
    lines(JOURNAL).find((l) => l.step === 'did' && l.i === i),
  );
}

const serverState = async () =>
  await (await fetch(`${base}/_galley/revise`)).json();
const rounds = async () =>
  (await (await fetch(`${base}/_galley/versions`)).json()).rounds || [];

agent = spawn(
  process.execPath,
  [process.argv[1], '--agent', base, DOC, JOURNAL, COMMANDS],
  { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() },
);
agent.stderr.on('data', (b) => {
  const line = String(b).trim();
  if (line) console.log(`      [agent] ${line}`);
});

browser = await chromium.launch(
  process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.ProseMirror', { timeout: 15000 });
await page.waitForSelector('#gly-revise', { timeout: 15000 });

// What the reviewer sees of the last Revise: the pill's state, the line under
// it, and whether Revise can be pressed.
const pageState = () =>
  page.evaluate(() => {
    const pill = document.querySelector('.gly-msg .kit-pill');
    const line = document.querySelector('.gly-msg .kit-msg-line');
    const revise = document.querySelector('#gly-revise');
    // The face on show: the one label of the button's four not reserved.
    const face = revise
      ? [...revise.querySelectorAll('.gly-revise-label')]
          .filter((l) => !l.classList.contains('gly-reserved'))
          .map((l) => l.innerText)
          .join('')
      : null;
    return {
      pill: pill ? pill.dataset.state : null,
      line: line ? line.textContent : '',
      disabled: revise ? revise.disabled : null,
      face,
    };
  });
const docText = () =>
  page.evaluate(() => window.galleyEdit.editor.state.doc.textContent);

// expect is the check every step makes: the server's revise state and the page
// both reach what the step expects. want.server and want.page are partial: a
// key left out is not checked. On a timeout the failure names the half (or
// halves) that disagreed, with what each showed.
async function expect(step, want, ms = 20000) {
  const matches = (got, w) =>
    !!got && Object.entries(w).every(([k, v]) => got[k] === v);
  const serverView = async () => {
    const s = await serverState();
    return {
      state: s.message ? s.message.state : null,
      line: s.message ? s.message.line : '',
      handoff: s.handoff,
      sealed: s.sealed,
    };
  };
  let seen = { server: null, page: null };
  const ok = await until(step, ms, async () => {
    seen = { server: await serverView(), page: await pageState() };
    return (
      matches(seen.server, want.server || {}) &&
      matches(seen.page, want.page || {})
    );
  }).catch(() => false);
  const halves = [];
  if (!matches(seen.server, want.server || {})) halves.push('server');
  if (!matches(seen.page, want.page || {})) halves.push('page');
  check(
    step,
    !!ok,
    ok ? undefined : { disagreed: halves.join(' and '), want, seen },
  );
}

const select = (phrase) =>
  page.evaluate((want) => {
    const editor = window.galleyEdit.editor;
    let at = null;
    editor.state.doc.descendants((node, pos) => {
      if (at !== null || !node.isTextblock) {
        return at === null;
      }
      const i = node.textContent.indexOf(want);
      if (i !== -1) {
        at = pos + 1 + i;
      }
      return false;
    });
    if (at === null) {
      throw new Error(`nothing in the document reads ${JSON.stringify(want)}`);
    }
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + want.length });
    editor.view.focus();
  }, phrase);

const pendingTexts = async () =>
  (
    (await (await fetch(`${base}/_galley/pending`)).json()).instructions || []
  ).map((i) => i.text);

// file is the reviewer filing an instruction on a sentence, from the page.
async function file(quote, ask) {
  await until('the editor to be editable', 20000, () =>
    page.evaluate(() => window.galleyEdit.editor.isEditable === true),
  );
  await select(quote);
  await page.click('.gly-composer .gly-comment-button');
  await page.fill('.gly-composer .gly-composer-text', ask);
  await page.click('.gly-composer .gly-composer-send');
  await until(`the instruction "${ask}" to be pending`, 15000, async () =>
    (await pendingTexts()).includes(ask),
  );
}

// pressRevise is the reviewer's press on the page. With work pending the press
// discloses the menu and the reviewer picks item ('revise' or 'trust'); with
// nothing pending it is the press itself.
async function pressRevise(item) {
  await until('the agent to be blocked on the wait', 20000, readerAttached);
  await until('Revise to be pressable', 20000, async () => {
    const s = await pageState();
    return s.disabled === false;
  });
  await page.click('#gly-revise');
  if (item) {
    const sel = `.gly-verdict-menu .gly-verdict-${item}`;
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.click(sel);
  }
}

async function revised(n, step) {
  return until(step, 30000, () => revises()[n - 1]);
}

try {
  // --- open -----------------------------------------------------------------
  await expect('open: no Revise yet, and Revise can be pressed', {
    server: { state: null, handoff: false, sealed: false },
    page: { pill: null, disabled: false },
  });

  // --- the first Revise: sent, landed, working, answered --------------------
  await file(FIRST, ASK_1);
  const before1 = (await rounds()).length;
  await pressRevise('revise');
  const wake1 = await revised(1, 'the first Revise to wake the agent');
  check(
    'the first Revise woke the agent with its instruction and a report token',
    wake1.instructions.includes(ASK_1) && wake1.report.length > 0,
    wake1,
  );
  await expect('sent: the server has the message and the page says sent', {
    server: { state: 'sent', handoff: true },
    page: { pill: 'sent', disabled: true },
  });

  const landed1 = await tell({ do: 'report', event: 'landed', wake: 1 });
  check('`galley report landed` exited 0', landed1.code === 0, landed1);
  await expect('landed: the message is with the agent', {
    server: { state: 'with_agent', handoff: true },
    page: { pill: 'with_agent', disabled: true },
  });

  const working = await tell({ do: 'ack', state: 'working', note: WORKING });
  check('`galley ack --state working` exited 0', working.code === 0, working);
  await expect("working: the agent's line is under the pill", {
    server: { state: 'working', line: WORKING, handoff: true },
    page: { pill: 'working', line: WORKING, disabled: true },
  });

  // #119: a press with nothing new while the agent has the Revise sends
  // nothing. The page will not offer the press (Revise is disabled above), so
  // it comes from the other surface a reviewer has, `galley revise`.
  const roundsWorking = (await rounds()).length;
  await until('the agent to be blocked on the wait', 20000, readerAttached);
  const press = await tell({ do: 'revise' });
  check('`galley revise` with nothing new exited 0', press.code === 0, press);
  await expect(
    'a press with nothing new while the agent works leaves it working',
    {
      server: { state: 'working', line: WORKING, handoff: true },
      page: { pill: 'working', line: WORKING, disabled: true },
    },
  );
  check(
    'and it cut no round and woke nobody',
    (await rounds()).length === roundsWorking && revises().length === 1,
    { rounds: (await rounds()).length, was: roundsWorking, wakes: wakes() },
  );

  await tell({ do: 'edit', from: FIRST, to: FIRST_NEW });
  const answered1 = await tell({
    do: 'ack',
    state: 'answered',
    note: ANSWERED_1,
  });
  check(
    '`galley ack --state answered` exited 0',
    answered1.code === 0,
    answered1,
  );
  await expect('answered: the Revise is settled and the page is open again', {
    server: { state: 'answered', line: ANSWERED_1, handoff: false },
    page: { pill: 'answered', line: ANSWERED_1, disabled: false },
  });
  const text1 = await until(
    "the agent's answer to reach the editor",
    20000,
    async () => {
      const t = await docText();
      return t.includes(FIRST_NEW) ? t : null;
    },
  ).catch(() => docText());
  check(
    "the agent's words are in the reviewer's editor",
    text1.includes(FIRST_NEW) && !text1.includes(FIRST),
    text1,
  );
  check(
    'the first Revise cut its round and the answer cut another',
    (await rounds()).length >= before1 + 2,
    { before: before1, now: (await rounds()).length },
  );

  // --- the second Revise: landed, and the turn ends with no reply -----------
  await file(SECOND, ASK_2);
  await pressRevise('revise');
  const wake2 = await revised(2, 'the second Revise to wake the agent');
  check(
    'the second Revise woke the agent with its instruction',
    wake2.instructions.includes(ASK_2),
    wake2,
  );
  await expect('the second Revise is sent', {
    server: { state: 'sent', handoff: true },
    page: { pill: 'sent', disabled: true },
  });
  await tell({ do: 'report', event: 'landed', wake: 2 });
  await expect('and with the agent', {
    server: { state: 'with_agent', handoff: true },
    page: { pill: 'with_agent' },
  });
  const ended = await tell({ do: 'report', event: 'turn-ended' });
  check('`galley report turn-ended` exited 0', ended.code === 0, ended);
  await expect('no reply: the turn ended with the Revise unanswered', {
    server: { state: 'no_reply', handoff: true },
    page: { pill: 'no_reply', disabled: false, face: 'Revise' },
  });

  // --- Revise again: the same instruction is sent again ---------------------
  //
  // FROM THE PAGE. With nothing pending the verdict is Approve, and the press
  // once approved the review here under a `revising · Ns` face. The button
  // says Revise and its press sends the round again (resendsOnPress in
  // verdict.ts, unansweredAsks on the server).
  await pressRevise();
  const wake3 = await revised(3, 'the resend to wake the agent');
  check(
    'Revise after no reply sent the same instruction again',
    wake3.instructions.length === 1 && wake3.instructions[0] === ASK_2,
    wake3,
  );
  await expect('the resent Revise is sent, and the review is not sealed', {
    server: { state: 'sent', handoff: true, sealed: false },
    page: { pill: 'sent', disabled: true },
  });
  await tell({ do: 'report', event: 'landed', wake: 3 });
  await tell({ do: 'edit', from: SECOND, to: SECOND_NEW });
  await tell({ do: 'ack', state: 'answered', note: ANSWERED_2 });
  await expect('the resent Revise is answered', {
    server: { state: 'answered', line: ANSWERED_2, handoff: false },
    page: { pill: 'answered', line: ANSWERED_2, disabled: false },
  });

  // --- the third Revise is cancelled ----------------------------------------
  await file(THIRD, ASK_3);
  await pressRevise('revise');
  const wake4 = await revised(4, 'the third Revise to wake the agent');
  check(
    'the third Revise woke the agent with its instruction',
    wake4.instructions.includes(ASK_3),
    wake4,
  );
  await expect('the third Revise is sent', {
    server: { state: 'sent', handoff: true },
    page: { pill: 'sent', disabled: true },
  });
  await page.waitForSelector('.gly-handoff-cancel:not([disabled])', {
    timeout: 10000,
  });
  await page.click('.gly-handoff-cancel');
  await expect('cancelled: the document is the reviewer’s again, no pill', {
    server: { state: null, handoff: false },
    page: { pill: null, disabled: false },
  });
  check(
    'the cancel left the editor editable',
    await until('the editor to be editable after the cancel', 20000, () =>
      page.evaluate(() => window.galleyEdit.editor.isEditable === true),
    ).catch(() => false),
  );

  // The cancel took the round back, and its instruction with it: the send
  // had deleted it from the page, and the cancel files it again.
  const card = await until(
    'the cancelled instruction to be back on the page',
    20000,
    async () => {
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll('.gly-rail-band .gly-thread')].map(
          (c) => c.textContent,
        ),
      );
      return (await pendingTexts()).includes(ASK_3) &&
        cards.some((c) => c.includes(ASK_3))
        ? cards
        : null;
    },
  ).catch(async () => ({
    pending: await pendingTexts(),
    cards: await page.evaluate(
      () => document.querySelectorAll('.gly-rail-band .gly-thread').length,
    ),
  }));
  check(
    "the cancelled round's instruction is back: pending on the server and a card on the page",
    Array.isArray(card),
    card,
  );

  // --- the review closes ----------------------------------------------------
  //
  // Revise & Approve: the instruction the cancel filed again is what it sends,
  // and the agent's answer approves the review.
  await pressRevise('trust');
  const wake5 = await revised(5, 'Revise & Approve to wake the agent');
  check(
    'Revise & Approve sent the instruction the cancel filed again',
    wake5.instructions.length === 1 && wake5.instructions[0] === ASK_3,
    wake5,
  );
  await tell({ do: 'report', event: 'landed', wake: 5 });
  await tell({ do: 'edit', from: THIRD, to: THIRD_NEW });
  await tell({ do: 'ack', state: 'answered', note: ANSWERED_3 });
  await expect('approved: the answer sealed the review and Revise is done', {
    server: { sealed: true, handoff: false },
    page: { pill: null, disabled: true },
  });
  await until('the agent to hear the approve', 20000, () =>
    wakes().find((w) => w.reason === 'approve'),
  ).then(
    () => check('the agent heard the review close', true),
    () => check('the agent heard the review close', false, wakes()),
  );
} catch (e) {
  check(`the walk reached its end — ${e.message}`, false, {
    journal: lines(JOURNAL),
    server: serverSaid.slice(-1500),
  });
}

await browser.close();
server.kill('SIGTERM');
await until('the editor to stop', 20000, () => serverExit).catch(() => null);
check('the editor stopped when asked', !!serverExit, serverSaid.slice(-600));

console.log(
  failures === 0
    ? '\nall revise-lifecycle checks passed'
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
