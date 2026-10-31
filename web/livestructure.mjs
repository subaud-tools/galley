// livestructure.mjs — A STRUCTURAL ROUND CUTS THE PAGE AND RELOADS THE
// REVIEWER, WITHOUT LOSING THE ROUND'S WORDS.
//
// `galley edit page.html` re-extracts the page EVERY round, so the template
// rides the loop instead of being frozen at open (spec: "HTML pages — the
// template rides the loop"). A structural change is then just something the
// agent does while answering: it edits the page's .html, galley re-extracts,
// and the reviewer's live editor RELOADS on the re-derived content.
//
// NO OTHER GATE CAN SEE THIS, AND THE GO TESTS CANNOT SEE THE HALF THAT
// MATTERS MOST. internal/serve/pagemode_test.go drives the whole pipeline —
// merge, reload claim, handoff window, the overlapping-projection races — but
// it asserts against the CRDT in process. It has no browser bound to that
// document, so it cannot say whether the reviewer's EDITOR came back: whether
// the cut prose left the screen, whether the caret survived the replacement,
// whether the next keystroke still lands. page.mjs opens a page-backed review
// but its agent only ever edits content.md; the .html is never touched, so the
// structural path it now guards is never entered. This gate is the only place
// the browser-visible half of the feature is proven. Its four claims:
//
//   THE CUT STAYS CUT, AND THE EDITOR FOLLOWS — the agent deletes a whole
//   <section> from page.html; the re-rendered page has no wrapper and no prose
//   left of it, AND the reviewer's live editor no longer shows that prose. The
//   file half alone would be green with a browser still displaying a document
//   that no longer exists.
//
//   THE EDITOR IS STILL AN EDITOR AFTERWARDS — the reload is a full model
//   replacement (the restore path), which orphans undo and moves the caret. So
//   the reviewer types after it and the keystroke registers, the caret is a
//   real position in the new document rather than a detached one, and undo does
//   not resurrect the section that was cut.
//
//   A RESTRUCTURE DOES NOT EAT THE ROUND'S WORDS (C1) — the agent answers in
//   BOTH layers in one round: a wording change in content.md and a structural
//   edit to page.html. Both survive into the reloaded editor and into the page.
//   This is the failure the internals were fixed for — a reload taken straight
//   off the page replaced the agent's content edits with the page's own words,
//   silently — and a browser bound to the document is where it was visible.
//
//   A CONTENT-ONLY ROUND AFTER ONE DOES NOT CHURN — the next wording round
//   renders and re-extracts to the same split, so it reloads NOTHING. Idem-
//   potence is a Go-side property; "the reviewer's screen did not wobble" is
//   this one. The evidence is mechanical: galley announces every reload on
//   stderr, and that count must not move across a content round.
//
// THE REVIEWER NEVER TOUCHES HTML. Everything the reviewer half does goes
// through the editor and the composer; the .html writes are all the agent's,
// in the agent child. Asserted rather than asserted-by-narration: the reviewer
// half records every path it writes, and the document it is shown is checked
// for page markup that would mean the split leaked.
//
// THE RACES ARE NOT REPRODUCED HERE, DELIBERATELY. The handoff-close TOCTOU,
// overlapping projections and the stale agent page-write are pinned by
// deterministic Go tests with a seam for the interleaving; a browser gate can
// only produce them by luck, and a gate that reports a race by luck is a flake
// with a reputation. This one exercises the ORDINARY sequence end to end.
//
// HOW THE AGENT IS PLAYED. The same shape page.mjs uses: this file re-invoked
// with --agent, blocked on `galley wait`, answering with the CLI verbs and the
// FILE. It answers three rounds in turn — structural, both-layers, content —
// and reports through a JSONL journal so the reviewer half can read its
// progress while it is still blocked. No model, no tokens.
//
// THE RED RUN was done at the source, not with a switch, because the thing to
// break is galley's and not the agent's: making pageRenderer.reload return
// without applying the model (and, separately, making the drift path skip
// merge) turns §2 and §4 red respectively while every file-level check stays
// green — which is the point of asserting the editor and not only the bytes.
//
// Running it:
//
//   just build
//   GALLEY="$PWD/bin/galley" node web/livestructure.mjs
//
// It needs a chromium for playwright to drive: `npx playwright install
// chromium` once, or GALLEY_CHROME=<executable>. There is a `just
// livestructure` recipe, it is in `just gates`, and it is a step of its own in
// ci.yml.

import { served, serverLog } from './gateserve.mjs';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GALLEY = process.env.GALLEY || 'bin/galley';

// THE FIXTURE IS WRITTEN HERE RATHER THAN COPIED FROM testdata. This gate
// deletes named regions of it and counts what is left, so it needs a page whose
// sections it can name and whose shell regions it can count — a real launch
// page's structure is free to move and would take these assertions with it.
// The shape is what the claims need: a <nav> nobody edits, three <section>s,
// and a <figure> standing BETWEEN two paragraphs (its own shell region, so
// removing it changes the extracted markdown without deleting any prose —
// which is what makes the both-layers round a merge and not a deletion).
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Field notes</title></head>
<body>
<nav class="top"><a href="/">home</a></nav>
<section id="intro">
<h1>Field notes</h1>
<p class="eyebrow">A page two parties revise in rounds</p>
<p>The reviewer highlights a sentence and says what is wrong with it.</p>
</section>
<section id="breakout">
<h2>Breakout</h2>
<p>Everything in this breakout was written to be cut.</p>
<p>A second breakout paragraph nobody will miss.</p>
</section>
<section id="closing">
<h2>Closing</h2>
<p>When the round comes back the page is rendered again.</p>
<figure class="shot"><img src="shot.png" alt=""></figure>
<p>The shell the reviewer never edits rides along verbatim.</p>
</section>
</body></html>
`;

// The prose of the section round 1 cuts: it must leave the page AND the editor.
const BREAKOUT_PROSE = 'Everything in this breakout was written to be cut.';
const BREAKOUT_SECOND = 'A second breakout paragraph nobody will miss.';
const BREAKOUT_OPEN = '<section id="breakout">';

// The <figure> round 2 cuts alongside its wording change. It is SHELL: the
// reviewer never sees it as prose, only as a ⟦ shell N ⟧ stand-in, so its
// removal shows up in the editor as one fewer marker.
const FIGURE = '<figure class="shot">';

// The paragraphs each round works on. Round 2 is the both-layers round: the
// agent rewrites the closing sentence in content.md and cuts the figure from
// the .html, and the reload at the boundary must keep BOTH.
const CLOSING_OLD = 'When the round comes back the page is rendered again.';
const CLOSING_NEW =
  'When the round comes back galley renders the page from the markdown again.';
const EYEBROW_OLD = 'A page two parties revise in rounds';
const EYEBROW_NEW = 'A page two parties revise in rounds, structure and all';
const INTRO_PROSE =
  'The reviewer highlights a sentence and says what is wrong with it.';

// What the reviewer types with their own hands after the structural reload —
// the proof the editor is still an editor and not a detached view.
const TYPED = ' The reviewer typed this after the reload.';

// The asks and the agent's notes, one per round.
const ASK_1 = 'cut this whole breakout section, wrapper and all';
const ASK_2 = 'say galley renders it, and drop the screenshot';
const ASK_3 = 'add that the structure is reviewed too';
const NOTE_1 = 'cut the breakout section from the page';
const NOTE_2 = 'reworded the closing line and dropped the figure';
const NOTE_3 = 'named the structure in the eyebrow';

// --- the agent half ---------------------------------------------------------
//
// One process, three rounds, the CLI verbs and two files. Round 1 edits only
// the .html (structural), round 2 edits BOTH layers, round 3 edits only
// content.md (the ordinary content round). It reports each step through the
// journal so the reviewer half can wait on facts rather than on the clock.

// armRevise blocks until a Revise round with instructions arrives, threading
// the fingerprint cursor forward so a non-Revise wake (or the agent's own echo)
// is skipped rather than answered. Extracted from agentMain to keep each piece
// under the complexity ratchet.
function armRevise(round, since, waitFor, say) {
  const deadline = Date.now() + 150000;
  for (;;) {
    const arg = since
      ? ['--since', since, '--timeout', '60s']
      : ['--timeout', '60s'];
    const got = waitFor(...arg);
    if (got.parsed) {
      since = got.parsed.fingerprint || since;
      const handed = (got.parsed.pending || {}).instructions || [];
      if (got.parsed.reason === 'revise' && handed.length) {
        return { woke: { ...got, handed }, since };
      }
      say({ step: `skipped-${round}`, reason: got.parsed.reason });
    }
    if (Date.now() > deadline) {
      say({ step: `gave-up-${round}`, code: got.code, err: got.err.trim() });
      return { woke: null, since };
    }
  }
}

// answerRound is the agent's answer for each round — the layer is its choice:
// round 1 structural only (cut a <section> in the .html, nothing in content.md);
// round 2 both layers (wording in content.md, structure in the .html); round 3
// content only. Returns whether it changed anything.
function answerRound(round, doc, htmlPath, edit, sleep) {
  if (round === 1) {
    // Structural only: the whole <section>, wrapper and all, cut from the
    // .html. Nothing goes to content.md, so the page is the whole authority.
    return edit(htmlPath, /<section id="breakout">[\s\S]*?<\/section>\n/, '');
  }
  if (round === 2) {
    // Both layers: wording through content.md (imported mid-window), structure
    // through the .html, words first then the cut — the ordinary order.
    const words = edit(doc, CLOSING_OLD, CLOSING_NEW);
    sleep(1200);
    const structure = edit(
      htmlPath,
      /<figure class="shot">[\s\S]*?<\/figure>\n/,
      '',
    );
    return words && structure;
  }
  return edit(doc, EYEBROW_OLD, EYEBROW_NEW);
}

function agentMain(doc, htmlPath, journalPath) {
  const say = (line) =>
    appendFileSync(journalPath, `${JSON.stringify(line)}\n`);
  const galley = (...args) => {
    const r = spawnSync(GALLEY, args, { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
  };
  const sleep = (ms) =>
    spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const waitFor = (...extra) => {
    const r = galley('wait', doc, '--json', ...extra);
    let parsed = null;
    try {
      parsed = JSON.parse(r.out);
    } catch {
      // Exit 3 (timed out) / exit 4 (editor stopped) print nothing on stdout.
    }
    return { ...r, parsed };
  };
  const edit = (file, from, to) => {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(from, to);
    writeFileSync(file, after);
    return after !== before;
  };

  // ARMING ACROSS ROUNDS NEEDS THE CURSOR. A wait re-armed with no --since
  // returns AT ONCE carrying the agent's own last write (wait.go: the cursor is
  // stale because the loop wrote between two waits), so the fingerprint of the
  // last wake is threaded forward and a wake that is not a Revise is skipped
  // rather than answered — otherwise round 2 would "answer" round 1's echo.
  let since = null;
  for (const round of [1, 2, 3]) {
    say({ step: `armed-${round}` });
    const arm = armRevise(round, since, waitFor, say);
    since = arm.since;
    if (!arm.woke) {
      return;
    }
    const woke = arm.woke;
    say({
      step: `woke-${round}`,
      reason: woke.parsed.reason,
      instructions: woke.handed.map((i) => ({ text: i.text, quote: i.quote })),
    });

    // THE ANSWER — the layer is the agent's choice per instruction (see
    // answerRound): wording in content.md, structure in the .html.
    const changed = answerRound(round, doc, htmlPath, edit, sleep);
    say({ step: `wrote-${round}`, changed });

    // Space the writes from the ack so the watcher's import and the debounced
    // projection land inside the window, the way a real agent's do.
    sleep(1500);
    const note = [NOTE_1, NOTE_2, NOTE_3][round - 1];
    const acked = galley('ack', doc, '--state', 'answered', '--note', note);
    say({ step: `acked-${round}`, code: acked.code, err: acked.err.trim() });
  }
  say({ step: 'done' });
}

if (process.argv[2] === '--agent') {
  agentMain(process.argv[3], process.argv[4], process.argv[5]);
  process.exit(0);
}

// --- the reviewer half ------------------------------------------------------

// Imported here, after the --agent branch, so the child this file runs
// as keeps node's own signal handling.
const {
  check: kitCheck,
  counts,
  launchOrSkip,
  until: poll,
} = await import('./build/probe.mjs');
// The scaffolding's check, with the detail written as JSON as this gate always
// has: most details here are objects.
const check = (name, ok, detail) =>
  kitCheck(
    name,
    ok,
    detail === undefined ? '' : JSON.stringify(detail, null, 1),
  );

const HERE = mkdtempSync(join(tmpdir(), 'galley-livestructure-'));
const PAGE = join(HERE, 'page.html');
const DOC = join(HERE, '.galley', 'pages', 'page', 'content.md');
const JOURNAL = join(HERE, 'agent.jsonl');

// EVERY WRITE THE REVIEWER HALF MAKES, RECORDED. The claim "the reviewer never
// touches HTML" is only worth making if it is measured: this list is asserted
// to hold no .html at the end, and it is the only writer in this process.
const reviewerWrote = [];
const reviewerWrite = (path, body) => {
  reviewerWrote.push(path);
  writeFileSync(path, body);
};
reviewerWrite(PAGE, FIXTURE);
reviewerWrite(JOURNAL, '');

const server = spawn(GALLEY, ['edit', PAGE, '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
let serverSaid = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (b) => {
    serverSaid = (serverSaid + b).slice(-8000);
  });
}
server.on('exit', (code, signal) => {
  // A SIGTERM ends `galley edit` gracefully, with code 0: this gate's own shutdown.
  if (signal === 'SIGTERM' || code === 0) {
    return;
  }
  console.log(
    `      [server exited] code=${code} signal=${signal}\n${serverSaid.trim()}`,
  );
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

const { base, url } = await served(server);

const journal = () =>
  readFileSync(JOURNAL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const said = (step) => journal().find((l) => l.step === step) || null;
const heard = async (step, ms) => (await poll(() => said(step), ms)) || null;

browser = await launchOrSkip({
  required: true,
  ...(process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.ProseMirror', { timeout: 15000 });
await page.waitForTimeout(1000);
await page.click('.ProseMirror');

// THE EDITOR'S OWN DOCUMENT, not the DOM's text: it is the model the reviewer
// is bound to, and the reload replaces exactly that.
const docText = () =>
  page.evaluate(() => window.galleyEdit.editor.state.doc.textContent);
const markers = async () => ((await docText()).match(/⟦ shell/g) || []).length;

// POLL FOR THE FACT THE CHECK IS ABOUT, never for the clock: the editor's
// document reaching a state, or the page on disk reaching one. Both read
// synchronously each time round, so a truthy first tick cannot pass for a
// settled one.
const editorUntil = async (pred, ms) => {
  const started = Date.now();
  for (;;) {
    let text = '';
    try {
      text = await docText();
    } catch {
      // Mid-navigation; try again.
    }
    if (pred(text) || Date.now() - started > ms) return text;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const pageUntil = async (pred, ms) => {
  const started = Date.now();
  for (;;) {
    let cur = '';
    try {
      cur = readFileSync(PAGE, 'utf8');
    } catch {
      // Between writes; try again.
    }
    if (pred(cur) || Date.now() - started > ms) return cur;
    await new Promise((r) => setTimeout(r, 200));
  }
};
// Every reload galley announced so far. The no-churn claim is a delta on this.
const reloads = () =>
  (serverLog().match(/was restructured — the editor reloads on/g) || []).length;

const pendingLive = async () =>
  await (await fetch(`${base}/_galley/pending`)).json();
const pendingUntil = async (pred, ms) => {
  const started = Date.now();
  for (;;) {
    let n = -1;
    try {
      n = ((await pendingLive()).instructions || []).length;
    } catch {
      // The server is mid-round; try again.
    }
    if (pred(n)) return true;
    if (Date.now() - started > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
};

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
      throw new Error(
        `fixture: nothing in the document reads ${JSON.stringify(want)}`,
      );
    }
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + want.length });
    editor.view.focus();
    if (!editor.isFocused) {
      throw new Error(
        'fixture: the editor did not take focus — a keystroke would go nowhere',
      );
    }
    return { from: at, to: at + want.length };
  }, phrase);

// The round, from the reviewer's side and nowhere near a file: highlight the
// prose, file the instruction on it, press Revise and pick the verdict.
const instructAndSend = async (quote, ask) => {
  await select(quote);
  await page.waitForTimeout(300);
  await page.click('.gly-composer .gly-comment-button');
  await page.fill('.gly-composer .gly-composer-text', ask);
  await page.click('.gly-composer .gly-composer-send');
  // WAIT FOR THE INSTRUCTION TO BE PENDING, not for the clock: the verdict
  // button only DISCLOSES its two exits while something is outstanding (at zero
  // its face is Approve and the press has no menu to open), so pressing early
  // would send nothing and hang on a menu that never appears.
  const filed = await pendingUntil((n) => n > 0, 15000);
  if (!filed) {
    throw new Error(
      `the instruction ${JSON.stringify(ask)} never became pending`,
    );
  }
  await page.click('#gly-revise');
  await page.waitForSelector('.gly-verdict-menu .gly-verdict-revise', {
    timeout: 10000,
  });
  await page.click('.gly-verdict-menu .gly-verdict-revise');
};
const editableAgain = async () => {
  await page
    .waitForFunction(() => window.galleyEdit.editor.isEditable === true, null, {
      timeout: 30000,
    })
    .catch((e) => {
      console.log(
        `      [page] waitForFunction(editable) stalled: ${e.message}`,
      );
    });
};

// --- §1 the page opened as a derived review, with its shell as markers -------

{
  const text = await docText();
  const seen = await markers();
  check(
    'the editor shows the page prose and stands in for the shell it cannot carry',
    text.includes(BREAKOUT_PROSE) && text.includes(CLOSING_OLD) && seen === 5,
    { breakout: text.includes(BREAKOUT_PROSE), markers: seen },
  );
  check(
    'and the reviewer is shown markdown, never the page markup',
    !/<section|<nav|<figure|<\/p>/.test(text),
    text.slice(0, 200),
  );
}

agent = spawn(
  process.execPath,
  [process.argv[1], '--agent', DOC, PAGE, JOURNAL],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
agent.stderr.on('data', (b) => {
  const line = String(b).trim();
  if (line && !line.startsWith('galley: free trial')) {
    console.log(`      [agent] ${line}`);
  }
});
check(
  'the agent armed on the derived document',
  !!(await heard('armed-1', 10000)),
  journal(),
);
await page.waitForTimeout(1500);

// --- §2 THE STRUCTURAL ROUND: the cut stays cut, and the editor follows ------

const beforeStructural = reloads();
await instructAndSend(BREAKOUT_PROSE, ASK_1);

// THE ROUND IS THE REVIEWER'S UNTIL THE SEND, AND THE AGENT'S AFTER IT. The
// editor locks for the length of the window, which is also the answer to "what
// happens to an instruction filed after the send" (I3): from the browser there
// is no way to file one, because there is nothing to file it into. The
// internals drop such an instruction if one arrives by another route (a reload
// carries no `extra`, so pending marks go with the old model); here the door is
// shut, and this is the check that pins it.
const lockedDuringRound = await page
  .waitForFunction(() => window.galleyEdit.editor.isEditable === false, null, {
    timeout: 30000,
  })
  .then(() => true)
  .catch(() => false);

const woke1 = await heard('woke-1', 60000);
check(
  'pressing Revise woke the agent with the cut-the-section ask',
  !!woke1 && (woke1.instructions || []).some((i) => i.text === ASK_1),
  woke1 || journal(),
);
check(
  'and the editor locked for the round — no instruction can be filed after the send',
  lockedDuringRound === true,
  { locked: lockedDuringRound },
);
check(
  'the agent answered structurally — it edited the page, not the markdown',
  !!(await heard('wrote-1', 30000)) && said('wrote-1').changed === true,
  said('wrote-1') || journal(),
);

{
  // (a) THE PAGE. The section is gone wrapper and all — not emptied, which is
  // the exact failure the frozen template left behind (a blank box where the
  // words used to be).
  const settled = await pageUntil((p) => !p.includes(BREAKOUT_OPEN), 30000);
  check(
    'the section is gone from the page — wrapper and all, not an empty box',
    !settled.includes(BREAKOUT_OPEN) &&
      !settled.includes(BREAKOUT_PROSE) &&
      !settled.includes(BREAKOUT_SECOND),
    {
      wrapper: settled.includes(BREAKOUT_OPEN),
      prose: settled.includes(BREAKOUT_PROSE),
    },
  );
  check(
    'and the shell the reviewer never edited rides along verbatim',
    settled.includes('<nav class="top">') && settled.includes(FIGURE),
    {
      nav: settled.includes('<nav class="top">'),
      figure: settled.includes(FIGURE),
    },
  );

  // (b) THE EDITOR, AFTER THE ROUND CLOSES. The reload is a ROUND BOUNDARY and
  // not a moment during one: while the handoff window is open the .md is the
  // agent's, so the merge and the reload both wait for the projection the close
  // cuts. So this waits for the ack before it reads the editor at all —
  // asserting earlier would be asserting about the middle of a round.
  check(
    'the agent committed the structural round with one terminal ack',
    ((await heard('acked-1', 60000)) || {}).code === 0,
    said('acked-1') || journal(),
  );
  await editableAgain();

  // The live document reloaded on the re-extracted content: the cut prose left
  // the SCREEN, not only the file. Without the reload the file check above is
  // still green with the reviewer editing a document that no longer exists.
  const text = await editorUntil((t) => !t.includes(BREAKOUT_PROSE), 30000);
  check(
    "the reviewer's live editor reloaded — the cut prose is off the screen too",
    !text.includes(BREAKOUT_PROSE) && !text.includes(BREAKOUT_SECOND),
    text.slice(0, 400),
  );
  check(
    'and the rest of the document came back whole, with the markers renumbered',
    text.includes(CLOSING_OLD) &&
      text.includes(INTRO_PROSE) &&
      (await markers()) === 4,
    { closing: text.includes(CLOSING_OLD), markers: await markers() },
  );
  check(
    'galley announced the reload rather than swapping the document silently',
    reloads() === beforeStructural + 1,
    { before: beforeStructural, now: reloads() },
  );
}

// --- §3 THE EDITOR IS STILL AN EDITOR AFTER THE REPLACEMENT ------------------
//
// The reload is a full model load — the restore path — so the caret goes to the
// start and the browser's undo stack is orphaned. That is accepted AT A ROUND
// BOUNDARY, but only if the editor is still usable on the other side, and only
// a browser can say.

{
  const caret = await page.evaluate(() => {
    const view = window.galleyEdit.editor.view;
    const { from } = view.state.selection;
    const $from = view.state.doc.resolve(from);
    return {
      from,
      size: view.state.doc.content.size,
      // A caret in a detached node has no textblock parent to report.
      parent: $from.parent ? $from.parent.type.name : null,
      editable: window.galleyEdit.editor.isEditable,
    };
  });
  check(
    'the caret landed on a real position in the reloaded document, not a detached node',
    caret.editable === true &&
      caret.from >= 0 &&
      caret.from <= caret.size &&
      !!caret.parent,
    caret,
  );

  // THE KEYSTROKE IS THE CLAIM. Typing into the reloaded document and seeing it
  // in the model is the only proof the browser is bound to the document galley
  // reloaded rather than to the one it replaced.
  await select(INTRO_PROSE);
  await page.evaluate(() => {
    const editor = window.galleyEdit.editor;
    editor.commands.setTextSelection(editor.state.selection.to);
  });
  await page.keyboard.type(TYPED);
  const typed = await editorUntil((t) => t.includes(TYPED.trim()), 10000);
  check(
    'the reviewer can type into the reloaded document and it registers',
    typed.includes(TYPED.trim()),
    typed.slice(0, 300),
  );

  // AND IT REACHES THE PAGE. The loop still runs after a structural round —
  // which is what adopting the restructured page is for: without it the drift
  // stands forever and the reviewer's next keystroke is never rendered. Read
  // BEFORE the undo below, which would take the keystroke back out again.
  const typedThrough = await pageUntil((p) => p.includes(TYPED.trim()), 30000);
  check(
    "the reviewer's own typing rendered back into the page",
    typedThrough.includes(TYPED.trim()),
    { has: typedThrough.includes(TYPED.trim()) },
  );

  // UNDO MUST NOT RESURRECT THE CUT. The stack is orphaned across the reload;
  // what matters is that walking back through it cannot restore a section the
  // page no longer has, which would put the document and the page into
  // disagreement with nothing to reconcile them. It walks back further than the
  // keystrokes above on purpose — past the reload, into whatever the browser
  // still holds from before it.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press(`${mod}+z`);
    await page.waitForTimeout(150);
  }
  const undone = await docText();
  check(
    'and undo after the reload cannot bring the cut section back',
    !undone.includes(BREAKOUT_PROSE) && !undone.includes(BREAKOUT_SECOND),
    undone.slice(0, 300),
  );
  // Undo walked the reviewer's own sentence back out along the way. Type it
  // again, by hand, and let it reach the page: §4 claims a later restructure
  // does not undo the round before it, and that claim is about this sentence —
  // so it has to be in the document AND settled into content.md before the next
  // round hands that file to the agent.
  if (!undone.includes(TYPED.trim())) {
    await select(INTRO_PROSE);
    await page.evaluate(() => {
      const editor = window.galleyEdit.editor;
      editor.commands.setTextSelection(editor.state.selection.to);
    });
    await page.keyboard.type(TYPED);
  }
  const settledTyped = await pageUntil((p) => p.includes(TYPED.trim()), 30000);
  check(
    "the reviewer's sentence stands in the document and in the page",
    settledTyped.includes(TYPED.trim()) &&
      (await docText()).includes(TYPED.trim()),
    { page: settledTyped.includes(TYPED.trim()) },
  );

  // I3, PINNED: the round's instruction was discharged at the send, so there is
  // nothing in the rail for the reload to drop. This is the assumption the
  // reload's no-`extra` model load rests on, asserted where it is visible.
  const cards = await page.evaluate(
    () => document.querySelectorAll('.gly-rail-band .gly-thread').length,
  );
  const pendingNow = await pendingLive();
  check(
    'the round left no instruction behind for the reload to lose',
    cards === 0 && (pendingNow.instructions || []).length === 0,
    { cards, pending: pendingNow.instructions },
  );
}

// --- §4 BOTH LAYERS IN ONE ROUND (C1): the words survive the restructure -----

{
  const before = reloads();
  const markersBefore = await markers();
  await instructAndSend(CLOSING_OLD, ASK_2);

  const woke2 = await heard('woke-2', 90000);
  check(
    'the second round reached the agent as its own round',
    !!woke2 && (woke2.instructions || []).some((i) => i.text === ASK_2),
    woke2 || journal(),
  );
  check(
    'and the agent answered in both layers — content.md AND the page',
    !!(await heard('wrote-2', 40000)) && said('wrote-2').changed === true,
    said('wrote-2') || journal(),
  );
  await heard('acked-2', 60000);
  await editableAgain();

  // THE PAGE HOLDS BOTH. The agent's words are in the page because the merge
  // poured this round's content into the structure it had just been given; the
  // figure is gone because the structure is the agent's.
  const settled = await pageUntil(
    (p) => p.includes(CLOSING_NEW) && !p.includes(FIGURE),
    40000,
  );
  check(
    "the page carries the round's new wording AND the structural cut",
    settled.includes(CLOSING_NEW) &&
      !settled.includes(FIGURE) &&
      !settled.includes(CLOSING_OLD),
    {
      wording: settled.includes(CLOSING_NEW),
      figure: settled.includes(FIGURE),
    },
  );

  // AND SO DOES THE EDITOR — the C1 claim. A reload taken straight off the page
  // put the page's own words back over the agent's content edit, silently; here
  // the reloaded document must show the new wording and one fewer stand-in.
  const text = await editorUntil(
    (t) => t.includes(CLOSING_NEW) && !t.includes(CLOSING_OLD),
    40000,
  );
  check(
    "the reloaded editor kept the round's words while taking the new structure",
    text.includes(CLOSING_NEW) &&
      !text.includes(CLOSING_OLD) &&
      (await markers()) === markersBefore - 1,
    {
      wording: text.includes(CLOSING_NEW),
      markers: await markers(),
      was: markersBefore,
    },
  );
  check(
    'the earlier round still holds — a second restructure does not undo the first',
    !text.includes(BREAKOUT_PROSE) && text.includes(TYPED.trim()),
    text.slice(0, 400),
  );
  check(
    'and the reload was announced once for this round, not per projection',
    reloads() === before + 1,
    { before, now: reloads(), log: serverLog().slice(-600) },
  );
}

// --- §5 A CONTENT-ONLY ROUND AFTER ONE: no churn -----------------------------

{
  const before = reloads();
  const markersBefore = await markers();
  await instructAndSend(EYEBROW_OLD, ASK_3);

  const woke3 = await heard('woke-3', 90000);
  check(
    'the third round reached the agent',
    !!woke3 && (woke3.instructions || []).some((i) => i.text === ASK_3),
    woke3 || journal(),
  );
  await heard('acked-3', 60000);
  await editableAgain();

  const settled = await pageUntil((p) => p.includes(EYEBROW_NEW), 40000);
  check(
    'a content round after a structural one still renders into the page',
    settled.includes(EYEBROW_NEW) &&
      settled.includes('<p class="eyebrow">') &&
      !settled.includes(FIGURE),
    { wording: settled.includes(EYEBROW_NEW) },
  );
  const text = await editorUntil((t) => t.includes(EYEBROW_NEW), 40000);
  check(
    'and the editor shows it',
    text.includes(EYEBROW_NEW),
    text.slice(0, 300),
  );

  // NO CHURN. Render then re-extract settles on the same split, so nothing is
  // reloaded and nothing renumbers — the reviewer's screen does not wobble
  // between rounds. Read after a settle so a late projection is included.
  await page.waitForTimeout(2500);
  check(
    'the content round reloaded nothing — idempotence, seen from the browser',
    reloads() === before,
    { before, now: reloads(), log: serverLog().slice(-600) },
  );
  check(
    'and the shell stand-ins did not renumber under the reviewer',
    (await markers()) === markersBefore,
    { before: markersBefore, now: await markers() },
  );
  const again = await docText();
  check(
    'the document is stable across the settle — no second swap behind the round',
    again === text,
    { drifted: again !== text },
  );
}

// --- §6 THE REVIEWER NEVER TOUCHED HTML, AND THE RECORD AGREES ---------------

await browser.close();
server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));

{
  check(
    'the reviewer half never wrote HTML — every .html write in this run was the agent’s',
    reviewerWrote.filter((p) => p.endsWith('.html')).length === 1 &&
      reviewerWrote[0] === PAGE &&
      reviewerWrote.length === 2,
    reviewerWrote,
  );

  // THE THREE FILES, WITH NOTHING RUNNING. The page is the record; content.md
  // is what the next round would open on. They must agree about the structure
  // AND about the words, which is the whole feature in one read.
  const settledPage = readFileSync(PAGE, 'utf8');
  const settledContent = readFileSync(DOC, 'utf8');
  check(
    'the settled page: two rounds of structure, two rounds of words, shell intact',
    !settledPage.includes(BREAKOUT_OPEN) &&
      !settledPage.includes(FIGURE) &&
      settledPage.includes(CLOSING_NEW) &&
      settledPage.includes(EYEBROW_NEW) &&
      settledPage.includes(TYPED.trim()) &&
      settledPage.includes('<nav class="top">'),
    {
      breakout: settledPage.includes(BREAKOUT_OPEN),
      figure: settledPage.includes(FIGURE),
      closing: settledPage.includes(CLOSING_NEW),
      eyebrow: settledPage.includes(EYEBROW_NEW),
      typed: settledPage.includes(TYPED.trim()),
      nav: settledPage.includes('<nav class="top">'),
    },
  );
  check(
    'and the derived document is the same document in markdown, stand-ins and all',
    !settledContent.includes(BREAKOUT_PROSE) &&
      settledContent.includes(CLOSING_NEW) &&
      settledContent.includes(EYEBROW_NEW) &&
      settledContent.includes('⟦ shell 1 ⟧'),
    settledContent.split('\n').filter(Boolean).slice(0, 12),
  );
  check(
    'the agent ran all three rounds and exited on its own',
    !!said('done'),
    journal(),
  );
}

console.log(
  counts().fails === 0
    ? '\nall live-structure checks passed'
    : `\n${counts().fails} FAILED`,
);
process.exit(counts().fails === 0 ? 0 : 1);
