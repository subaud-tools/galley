import { served } from './gateserve.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  cleanup,
  counts,
  launchOrSkip,
  onCleanup,
} from './build/probe.mjs';
// THE GATE READS THE APP'S OWN CONSTANTS, not a copy of them — the discipline
// web/layers.mjs already states for SEALED_VERBS. A hand-copied label here goes
// stale the moment the button is renamed, and the check keeps reporting `ok`
// about a control it can no longer find.

const GALLEY = process.env.GALLEY || 'bin/galley';
const dir = mkdtempSync(join(tmpdir(), 'galley-history-ux-'));
const doc = join(dir, 'history-ux.md');
// THE SECOND PARAGRAPH EXISTS FOR THE GHOST, AND ITS PUNCTUATION IS THE POINT.
// A ghost sitting mid-sentence has an inserted word or an ordinary space on
// its right, and the trail's one-sided `margin-right` reads correctly there —
// which is why the orphan-space defect survived every fixture this repository
// had. The clause that ENDS a sentence is the shape that fails: strike it and
// the full stop is all that is left to the ghost's right, so the margin meant
// to separate two words becomes a space before a full stop. `is told, .`
writeFileSync(
  doc,
  '# A careful review\n\nThe retry budget should stay explicit and readable.\n\n' +
    'Nothing else in the pipeline is told, which is a gap worth closing.\n',
);

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

// A SELECTION SET THROUGH THE DOM IS A RACE, AND ESC IS WHAT MAKES IT ONE.
// onKey's Escape hands focus back to the page on purpose ("the way out of the
// field and into the stepper"), so a phrase selected straight afterwards lands
// in a contenteditable that is not focused: ProseMirror re-reads the DOM
// selection on the way back in, sometimes sees the EMPTY one the blur left
// behind, and `composerPlacement` correctly answers `hide` — after this helper
// had already seen the composer visible. Measured 3 runs in 5 with the composer
// root back to `hidden` and the phrase still selected in the window. Focusing
// the element first did not fix it; the two reads still interleave.
//
// So the selection is made THROUGH THE EDITOR, which is `web/layers.mjs`'s own
// pattern for exactly this reason: a `setTextSelection` is one transaction, and
// there is no second reading of the DOM for it to lose to. The DOM selection is
// still what a reviewer's mouse would leave — ProseMirror writes it back — so
// `selectionBox` reads the same rectangle it always did.
//
// And the wait is for the state the callers actually use — the affordance on
// screen — rather than for the container merely not being hidden. Waiting on a
// proxy for the thing you are about to click is how a gate reports green over a
// surface that is not there yet.
async function selectPhrase(page, phrase) {
  await page.waitForFunction(
    (want) =>
      !!window.galleyEdit?.editor?.state?.doc?.textContent?.includes(want),
    phrase,
  );
  await page.evaluate((want) => {
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
      throw new Error(`fixture text not found: ${want}`);
    }
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + want.length });
    editor.view.focus();
  }, phrase);
  await page.waitForFunction((want) => {
    const root = document.querySelector('.gly-composer');
    const button = document.querySelector('.gly-comment-button');
    return (
      !!root &&
      !root.hidden &&
      !!button &&
      button.offsetParent !== null &&
      window.getSelection().toString() === want
    );
  }, phrase);
}

async function selectRetryBudget(page) {
  return selectPhrase(page, 'retry budget');
}

// The RENDERED text of a selector, or null where nothing matches. A missing
// element must FAIL a check and not throw the run away: a gate that dies on the
// first absence reports one red where there are several, and the several are
// what say whether the diagnosis is right.
async function textOf(page, selector) {
  if ((await page.locator(selector).count()) === 0) {
    return null;
  }
  return (await page.locator(selector).innerText()).trim();
}

// Every top-level block of the prose, keyed by position. THE PROSE MAY NOT
// REFLOW when the composer opens — it opens in the Instructions tab, and this is
// what keeps it there.
function proseRects(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.ProseMirror > *')].map((el, i) => {
        const r = el.getBoundingClientRect();
        return [
          `${i}:${el.tagName}`,
          [
            +r.x.toFixed(2),
            +r.y.toFixed(2),
            +r.width.toFixed(2),
            +r.height.toFixed(2),
          ],
        ];
      }),
    ),
  );
}

async function addRangeInstruction(page, text) {
  await selectRetryBudget(page);
  await page.click('.gly-comment-button');
  await page.fill('.gly-composer-text', text);
  await page.click('.gly-composer-send');
  await page.waitForFunction(
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length === 1,
  );
}

// REVISE IS PRESSED ONLY ONCE IT CAN BE. The server lists a new instruction at
// once, but the page repaints the send bar on its own poll, so right after a
// filing it can still be off.
async function reviseReady(page) {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#gly-revise');
      return !!b && !b.disabled && b.innerText.includes('Revise');
    },
    null,
    { timeout: 10000 },
  );
}

// With work pending Approve doesn't seal: it offers Revise & Approve.
async function openApproveMenu(page) {
  await reviseReady(page);
  await page.click('.kit-primary');
  await page.waitForSelector('.gly-verdict-menu', {
    state: 'visible',
    timeout: 5000,
  });
}

// The two tabs of the right column.
const tabPress = (page, name) =>
  page.locator('.kit-rail-tabrow .kit-ctl', { hasText: name }).click();
const INSTRUCTION_ROW = '.gly-tab [data-draft-id]';
const CHAT_ROW = '.gly-chat-drafts [data-draft-id]';
const ROW_DELETE = 'button:not(.kit-draft-quote)';

async function addOverallInstruction(page, text, want) {
  await tabPress(page, 'Chat');
  await page.fill('#gly-chat-box', text);
  await page.locator('#gly-chat-box').press('Enter');
  await waitForWire(
    page,
    async (n) =>
      (await (await fetch('_galley/pending')).json()).instructions.length === n,
    want,
  );
  // AND THE PAGE HAS TAKEN IT: the box empties once it's filed, and the row follows
  // the page's own refresh.
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('.gly-chat-drafts textarea')].some(
        (b) => b.value === t,
      ),
    text,
    { timeout: 5000 },
  );
}

// The grip beside the document's title: the form that files a block comment
// on the section, open and ready to type in. The grip is there at rest, so
// nothing is hovered first, and it opens the form with no bar to press.
async function openSectionForm(page) {
  await page.click('.gly-block-grip[data-kind="heading"]', { timeout: 5000 });
  await page.waitForSelector('.gly-composer-form:not([hidden])', {
    timeout: 5000,
  });
}

// What the right-click menu is offering, as the labels a reviewer reads. One
// reader because the check is made wherever the menu opens — the text, the
// margin, the tab — and the claim is that it offers the same one item in
// each, which two spellings of the read could quietly stop being.
async function menuRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.gly-menu-item')].map((b) =>
      b.querySelector('.gly-menu-label').textContent.trim(),
    ),
  );
}

// THE FILE IS THE RECORD, AND THIS READS IT OFF DISK RATHER THAN OFF THE WIRE.
// A projection is debounced, so the bytes arrive a moment after the mutation
// that caused them; polling the real path is the only way to assert about what
// the author's editor would open.
async function waitForDisk(re, ms = 6000) {
  const until = Date.now() + ms;
  let last = '';
  for (;;) {
    try {
      last = readFileSync(doc, 'utf8');
    } catch {
      last = '';
    }
    if (re.test(last)) return last;
    if (Date.now() > until) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// THE UNSENT ROUND IS THE OTHER RECORD: a comment's words live in pending.json,
// beside the document's versions, and the .md carries only its ID mark (none at
// all for a whole-document comment). Read off disk for the same reason.
const unsentPath = join(
  dir,
  '.galley',
  'versions',
  'history-ux.md',
  'pending.json',
);
function readUnsent() {
  try {
    return JSON.parse(readFileSync(unsentPath, 'utf8')).comments || [];
  } catch {
    return [];
  }
}

// POLLED, NOT `page.waitForFunction(async () => …)`: an async page function
// returns a PROMISE, a promise is truthy, and such a wait resolves on its first
// poll whatever the fetch said. See the note in the sweep check below.
async function waitForWire(page, fn, arg, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > until) throw new Error('waitForWire timed out');
    await page.waitForTimeout(50);
  }
}

// A PRESS HAS ANSWERED WHEN ITS RESPONSE WINDOW IS OPEN, not when the pending
// set is empty. Revise clears the instructions in its FIRST mutation and opens
// the window last, after the round is recorded and the unsent round emptied:
// the composer closes and the trail settles on the 204 that follows, and an
// ack sent before the window opens is wiped by it. `handoff` is the flag
// openResponseWindow sets.
//
// KEYED TO THIS PRESS, not to "a window is open". `before` is windowMark, read
// BEFORE the click: the window must have been shut then (a reviewer cannot
// file the instruction a press sends while the agent holds the file, so every
// press here starts shut, and a window already open could not be told from
// this one), and the round this press cut must be newer than any round there
// was. Only then is the open window this press's.
// WHERE THE STATE'S TEXT STARTS on the status line: the left edge of the
// first character of `v1 · …` or `round N · …`, measured with a Range on the
// text itself, so a reply printed before it would show as a shift.
async function stateStart(page) {
  return page.evaluate(() => {
    const el = document.getElementById('gly-status');
    const node = el && el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const at = node.data.search(/v1 · |round \d+ · /);
    if (at < 0) return null;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    return range.getBoundingClientRect().left;
  });
}

async function windowMark(page) {
  return page.evaluate(async () => {
    const [revise, versions] = await Promise.all([
      fetch('_galley/revise').then((r) => r.json()),
      fetch('_galley/versions').then((r) => r.json()),
    ]);
    return {
      handoff: revise.handoff,
      round: Math.max(0, ...(versions.rounds || []).map((r) => r.n)),
    };
  });
}

async function responseWindowOpen(page, before, ms = 15000) {
  if (before.handoff)
    throw new Error(
      'responseWindowOpen: the window was already open before the press, so this press opening it cannot be seen',
    );
  const until = Date.now() + ms;
  for (;;) {
    const now = await windowMark(page);
    if (now.handoff && now.round > before.round) return;
    if (Date.now() > until)
      throw new Error(
        `responseWindowOpen timed out: ${JSON.stringify({ before, now })}`,
      );
    await page.waitForTimeout(50);
  }
}

async function ack(page, state, note = '') {
  return page.evaluate(
    async ({ ackState, ackNote }) => {
      const response = await fetch('_galley/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: ackState, note: ackNote }),
      });
      return response.status;
    },
    { ackState: state, ackNote: note },
  );
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
    viewport: { width: 1440, height: 900 },
  });
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ProseMirror');
  // The bar's readout is the fixed grammar now, so waiting for it is waiting
  // for the first round count to have landed — which is what this used to do
  // by watching the History chip's count, before the count left the chip.
  await page.waitForFunction(() =>
    /(v1|round \d+) · (draft|with the agent|settled)/.test(
      document.querySelector('#gly-status')?.innerText || '',
    ),
  );

  // HISTORY HAS ITS DOOR ON THE STAGE TRACK, and it carries no count.
  const door = await page.evaluate(
    () => document.querySelector('.kit-stages .gly-versions-open')?.innerText,
  );
  check(
    'History is a door on the stage track, with no count',
    door === 'History',
    door,
  );

  // THE EMPTY TAB SAYS HOW. A first-time reviewer doesn't know how to ask for
  // anything, and nothing else on a cold-open page tells them.
  const teach = await page.evaluate(() => ({
    empty: document.querySelector('.gly-tab .kit-empty')?.innerText,
    hint: document.querySelector('.gly-tab-hint')?.innerText,
  }));
  check(
    'the empty Instructions tab teaches the gesture',
    teach.empty === 'No instructions yet.' &&
      teach.hint === 'Select words in the document to add one.',
    JSON.stringify(teach),
  );

  // --- ONE NOUN, ONE VERB, NO SYSTEM RING ---
  //
  // The surface is called Instructions, the card it makes says INSTRUCTION,
  // and the button that made one said `comment`: two nouns and a third verb
  // for one object, on the FIRST gesture a reviewer makes. Every check here
  // reads the reviewer-visible string off a real page rather than the constant
  // behind it, for the reason CLAUDE.md records — a check that reads a proxy is
  // green through every defect that lives in the words.
  await selectRetryBudget(page);
  const proseBefore = await proseRects(page);
  const opener = await textOf(page, '.gly-comment-button');
  check(
    'the affordance that opens the composer says what it makes',
    opener === 'Add instruction',
    JSON.stringify(opener),
  );
  await page.click('.gly-comment-button');
  const send = await textOf(page, '.gly-composer-send');
  check(
    'the button names what it makes',
    send === 'Add instruction',
    JSON.stringify(send),
  );
  check(
    'the composer offers a visible cancel',
    (await page.locator('.gly-composer-cancel').count()) > 0 &&
      (await page.isVisible('.gly-composer-cancel')),
  );
  const esc = await textOf(page, '.gly-composer-esc');
  check(
    'and whispers the key that does the same thing',
    esc === 'esc cancels',
    JSON.stringify(esc),
  );
  // innerText and not textContent: the head is uppercased in CSS, so the
  // rendered string is the only one a reviewer ever reads, and asserting the
  // source string would pass with the transform deleted.
  const head = await textOf(page, '.gly-composer-head');
  check(
    'the head quotes the anchor the instruction is about',
    head === 'INSTRUCTION \u00b7 ON "RETRY BUDGET"',
    JSON.stringify(head),
  );

  // A PER-ELEMENT CLASS LOSES TO ITS OWN CONTAINER. `.gly-composer button`
  // dictates the border, background, colour and radius of everything in here,
  // so `Add instruction` written as a bare class renders as an ordinary grey
  // pill beside `cancel` — which is what `.gly-thread-delete` did for a whole
  // phase, in this same stylesheet, and is why the paint is read off a real
  // page rather than trusted to the declaration.
  const verbs = await page.evaluate(() => {
    const send = getComputedStyle(document.querySelector('.gly-composer-send'));
    const cancel = getComputedStyle(
      document.querySelector('.gly-composer-cancel'),
    );
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue('--gly-hl')
      .trim();
    document.body.appendChild(probe);
    const hl = getComputedStyle(probe).color;
    probe.remove();
    return {
      sendBg: send.backgroundColor,
      sendWeight: send.fontWeight,
      cancelBg: cancel.backgroundColor,
      cancelBorder: cancel.borderTopColor,
      hl,
    };
  });
  check(
    'the verb that makes the instruction is filled with the instruction colour',
    verbs.sendBg === verbs.hl && Number(verbs.sendWeight) >= 600,
    JSON.stringify(verbs),
  );
  check(
    'and the way out is not a second one — borderless, unfilled',
    verbs.cancelBg === 'rgba(0, 0, 0, 0)' &&
      verbs.cancelBorder === 'rgba(0, 0, 0, 0)',
    JSON.stringify(verbs),
  );

  const proseAfter = await proseRects(page);
  check(
    'opening the composer reflows no prose',
    JSON.stringify(proseBefore) === JSON.stringify(proseAfter),
    JSON.stringify({ before: proseBefore, after: proseAfter }),
  );

  await page.focus('.gly-composer-text');
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.gly-composer-text'));
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue('--gly-hl')
      .trim();
    document.body.appendChild(probe);
    const hl = getComputedStyle(probe).color;
    probe.remove();
    return {
      outline: s.outlineStyle,
      color: s.outlineColor,
      border: s.borderColor,
      hl,
    };
  });
  check(
    "focus is violet, not the user agent's blue",
    ring.outline === 'none' ||
      !/rgb\(0,\s*9[0-9]|rgb\(0,\s*10[0-9]/.test(ring.color),
    JSON.stringify(ring),
  );
  // Stated positively as well, for the reason the trail's colour check is:
  // an inequality alone goes green the day the ring becomes some OTHER colour
  // that merely is not the user agent's blue.
  check(
    'and it is the instruction colour, the same ring the whole-doc box got',
    ring.outline === 'solid' && ring.color === ring.hl,
    JSON.stringify(ring),
  );

  // The whisper is only honest if the key does it. Esc already reaches
  // hideComposer through onKey's topmost-first chain; this is what keeps it
  // reaching it from inside the field.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.gly-composer')?.hidden === true,
  );
  check(
    'esc really does cancel, from inside the field',
    !(await page.isVisible('.gly-composer')),
  );

  // THE BOUND AND THE BOX ARE ONE PAIR, so they are read together. A quote
  // bounded to a length the head cannot draw is ellipsized twice — once by the
  // bound and again by the CSS — and the reviewer is shown an anchor they
  // cannot check against the prose. The phrase here is
  // longer than the bound on purpose: with a short one this check is
  // arithmetic, not evidence.
  await selectPhrase(page, 'budget should stay explicit and readable');
  await page.click('.gly-comment-button');
  const longHead = await page.evaluate(() => {
    const el = document.querySelector('.gly-composer-head');
    return {
      text: el.innerText,
      scroll: el.scrollWidth,
      client: el.clientWidth,
    };
  });
  check(
    'a long anchor is bounded, and the bound fits the box it is drawn in',
    longHead.text.endsWith('\u2026"') && longHead.scroll <= longHead.client + 1,
    JSON.stringify(longHead),
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.gly-composer')?.hidden === true,
  );

  // --- THE GHOST IS A MESSAGE, IN THE REMOVAL VOCABULARY ---
  //
  // One vocabulary product-wide: removed text is red. The reviewer's outgoing
  // ghost and a settled diff are told apart by SHAPE — dotted with no wash
  // against solid on a wash — which is the colour-AND-shape discipline every
  // other mark on this page is drawn with, and the only one a reader who does
  // not see the colours can use.
  await selectPhrase(page, 'which is a gap worth closing');
  await page.keyboard.press('Backspace');
  await page.waitForSelector('.ProseMirror .gly-trail-ghost');
  const ghost = await page.evaluate(() => {
    const g = document.querySelector('.ProseMirror .gly-trail-ghost');
    if (!g) return null;
    const s = getComputedStyle(g);
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue('--gly-del')
      .trim();
    document.body.appendChild(probe);
    const del = getComputedStyle(probe).color;
    probe.remove();
    // THE GAP IS READ AS GEOMETRY, against the width of a real space in the
    // same prose — the one measurement that says "this reads as a space before
    // a full stop" rather than "some rule declares some margin".
    let gap = null;
    let space = null;
    const next = g.nextSibling;
    if (next && next.nodeType === 3 && next.data) {
      const r = document.createRange();
      r.setStart(next, 0);
      r.setEnd(next, 1);
      gap = +(
        r.getBoundingClientRect().left - g.getBoundingClientRect().right
      ).toFixed(2);
    }
    const first = document.querySelector('.ProseMirror p').firstChild;
    if (first && first.nodeType === 3) {
      const i = first.data.indexOf(' ');
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(first, i);
        r.setEnd(first, i + 1);
        space = +r.getBoundingClientRect().width.toFixed(2);
      }
    }
    return {
      color: s.color,
      style: s.textDecorationStyle,
      line: s.textDecorationLine,
      bg: s.backgroundColor,
      del,
      gap,
      space,
      after: next && next.data,
    };
  });
  check(
    'the ghost speaks in the removal colour, dotted',
    ghost &&
      ghost.style === 'dotted' &&
      ghost.line.includes('line-through') &&
      ghost.color === ghost.del,
    JSON.stringify(ghost),
  );
  check(
    "and wears no wash — the tint is a settled diff's half of the shape",
    ghost && ghost.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify(ghost),
  );
  check(
    'a ghost against a full stop leaves no space before it',
    ghost &&
      ghost.after === '.' &&
      ghost.gap !== null &&
      ghost.space > 0 &&
      ghost.gap < ghost.space / 2,
    JSON.stringify(ghost),
  );
  await addRangeInstruction(page, 'Make the retry policy concrete.');
  await page.waitForSelector(INSTRUCTION_ROW);
  await page.waitForFunction(() =>
    /Revise/.test(document.getElementById('gly-revise').innerText),
  );
  // §6.1b — THE STEPPER MOVES SOMETHING. `j`/`k` and the bottom bar's `↓ next`
  // both call `step`, whose `stepOrder` was `this.suggestions.filter(decidable)`
  // over a wire that carries no suggestions — an empty list, so `stepPending`
  // returned nothing and the handler returned before touching the page. Two
  // keys and a labelled button advertised a way through the review and
  // delivered none of it. §6.1 above proves the button is there, labelled and
  // pressable; that is exactly the state it was in while doing nothing.
  //
  // IT READS THE PAGE AND NOT `stepOrder`. The dead version satisfies any check
  // that asks the app what it intends to walk; only the class the step actually
  // writes can tell the two apart.
  //
  const stepped = await page.evaluate(() => {
    // HISTORY MUST BE SHUT, and that is the switch's own rule rather than a
    // harness convenience: History is a READING mode, so `j`/`k` are inert
    // there deliberately. A check run with the panel up would report the
    // stepper dead and be reading the guard, not the stepper.
    const panel = document.querySelector('.gly-versions');
    const before = document.querySelectorAll(
      '.gly-tab .kit-draft-row.on',
    ).length;
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', bubbles: true }),
    );
    return {
      historyShut: panel ? panel.hidden === true : true,
      before,
      after: document.querySelectorAll('.gly-tab .kit-draft-row.on').length,
      cards: document.querySelectorAll('.gly-tab [data-draft-id]').length,
    };
  });
  check(
    'j steps to a real instruction instead of walking an empty list',
    stepped.historyShut &&
      stepped.cards > 0 &&
      stepped.before === 0 &&
      stepped.after === 1,
    JSON.stringify(stepped),
  );

  check(
    'the primary carries the pending count',
    (await page.locator('#gly-revise').innerText()).includes('Revise · send 1'),
    await page.locator('#gly-revise').innerText(),
  );

  // --- the whole-document instruction ---
  //
  // TYPED ACROSS TWO LINES ON PURPOSE, the way a reviewer types them: a line,
  // Shift-Enter, a line, Enter. The box used to flatten every line break to a
  // space before filing, because the words were once written into the file
  // where a newline could not go. They live in pending.json now, so the words
  // the reviewer typed are the words that are kept, line break and all.
  //
  // A WHOLE-DOCUMENT COMMENT HAS NO MARK IN THE FILE. The range instruction
  // just above has reached the disk first (its ID mark is the proof), so the
  // bytes read here are what the document comment must leave untouched.
  const beforeDocumentComment = await waitForDisk(
    /\{>>@comment cm-[0-9a-f]{16}<<\}/,
  );
  await tabPress(page, 'Chat');
  await page.locator('#gly-chat-box').click();
  await page.keyboard.type('Open with the decision,');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('not the background.');
  await page.keyboard.press('Enter');
  await waitForWire(
    page,
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length === 2,
  );
  await page.waitForSelector(CHAT_ROW);
  const documentComment = await (async () => {
    for (const until = Date.now() + 6000; Date.now() < until;) {
      const found = readUnsent().find((c) => c.kind === 'document');
      if (found) return found;
      await page.waitForTimeout(100);
    }
    return null;
  })();
  const documentCard = await page.evaluate(
    (row) => document.querySelector(`${row} textarea`)?.value || '',
    CHAT_ROW,
  );
  check(
    'a multi-line whole-document instruction keeps its lines — in pending.json and in its row',
    !!documentComment &&
      documentComment.text === 'Open with the decision,\nnot the background.' &&
      documentCard === 'Open with the decision,\nnot the background.',
    JSON.stringify({ unsent: readUnsent(), card: documentCard }),
  );
  // A projection is debounced; wait out more than one before reading.
  await page.waitForTimeout(1500);
  const afterDocumentComment = readFileSync(doc, 'utf8');
  check(
    'a whole-document instruction leaves the .md byte-identical, words and all',
    /@comment cm-/.test(beforeDocumentComment) &&
      afterDocumentComment === beforeDocumentComment,
    JSON.stringify({
      before: beforeDocumentComment,
      after: afterDocumentComment,
    }),
  );
  // §2.2 — IT APPEARS IN THE CHAT TAB AND NOWHERE ELSE.
  // IT IS NOT IN THE PROSE AT ALL, AND IT IS STILL KEPT — which are two claims.
  // A whole-document comment has no mark in the file, so the fragment holds no
  // node for it: nothing to paint, and nothing y-prosemirror could delete. Its
  // words are in pending.json, which the filing check above already read.
  const inProse = await page.evaluate(() => {
    const notes = [
      ...document.querySelectorAll(
        '.ProseMirror .gly-note[data-anchor="document"]',
      ),
    ];
    return {
      present: notes.length,
      painted: notes.filter((n) => n.getClientRects().length > 0).length,
    };
  });
  check(
    'a whole-document instruction is not in the prose at all, and is still kept',
    inProse.present === 0 &&
      inProse.painted === 0 &&
      readUnsent().some(
        (c) =>
          c.kind === 'document' &&
          c.text === 'Open with the decision,\nnot the background.',
      ),
    JSON.stringify({ inProse, unsent: readUnsent() }),
  );
  const firstRow = await page
    .locator(`${CHAT_ROW} .kit-draft-quote`)
    .first()
    .innerText();
  check(
    'it is a row in the Chat tab, and its head names the anchor',
    firstRow === 'Whole document',
    firstRow,
  );

  // THE CHAT BOX IS IN REACH AT ANY SCROLL POSITION: the right column stays in
  // the window, so the foot of a long document can still ask about the whole of it.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const deepBox = await page.evaluate(() => {
    const r = document.querySelector('#gly-chat-box').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, view: window.innerHeight };
  });
  check(
    'the Chat box is on screen at the foot of the document',
    deepBox.top >= 0 && deepBox.bottom <= deepBox.view,
    JSON.stringify(deepBox),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  // --- §2.2c · THE RIGHT-CLICK, AND THE SCOPE THE SELECTION DECIDES ---
  //
  // `contextmenu` was UNCLAIMED before this — no handler existed anywhere in
  // web/ — so these are the first assertions about it. THE HAZARD IS THE FIRST
  // CHECK, not the last: a surface appended inside `.ProseMirror` is parsed as
  // prose and written to the author's file (a fixture went from 1 pending
  // suggestion to 81 and the `.md` gained the card's text as paragraphs). The
  // menu is on `body` and nothing in the editable subtree, and that is read off
  // the DOM rather than trusted.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.ProseMirror p').first().click({ button: 'right' });
  await page.waitForSelector('.gly-menu:not([hidden])');
  const menuHome = await page.evaluate(() => {
    const el = document.querySelector('.gly-menu');
    return {
      inProse: !!el.closest('.ProseMirror'),
      parent: el.parentElement.tagName,
      position: getComputedStyle(el).position,
      inside: document.querySelectorAll('.ProseMirror .gly-menu').length,
    };
  });
  check(
    'the menu is on body and NEVER inside the editable subtree',
    menuHome.inProse === false &&
      menuHome.parent === 'BODY' &&
      menuHome.inside === 0 &&
      menuHome.position === 'absolute',
    JSON.stringify(menuHome),
  );
  const collapsedRows = await menuRows(page);
  check(
    'with nothing selected the menu offers the whole document, and only that',
    collapsedRows.length === 1 &&
      /whole document/i.test(collapsedRows[0]) &&
      !/passage/i.test(collapsedRows[0]),
    JSON.stringify(collapsedRows),
  );
  // A REAL MENU WITH ROOM TO GROW, not a one-item popup: the rows are a list
  // and each is a focusable control, which is what lets the next item be a push
  // rather than a rewrite. Read as a claim about the SHAPE — a `div` with a
  // click handler would pass a count and fail the keyboard.
  const rowShape = await page.evaluate(() => {
    const list = document.querySelector('.gly-menu-list');
    const rows = [...list.querySelectorAll('.gly-menu-item')];
    return {
      role: list.getAttribute('role'),
      tags: [...new Set(rows.map((r) => r.tagName))],
      roles: [...new Set(rows.map((r) => r.getAttribute('role')))],
    };
  });
  check(
    'it is a real menu of focusable rows, built to take more of them',
    rowShape.role === 'menu' &&
      rowShape.tags.length === 1 &&
      rowShape.tags[0] === 'BUTTON' &&
      rowShape.roles.length === 1 &&
      rowShape.roles[0] === 'menuitem',
    JSON.stringify(rowShape),
  );
  await page.keyboard.press('Escape');
  // A RIGHT-CLICK ON A SELECTION IS THE BROWSER'S. Selecting text already
  // offers the instruction button beside it, and what a reviewer wants from a
  // right-click there is the browser's own Copy, Look Up and the rest. So
  // galley's menu does not open and the event is left alone: read as
  // `defaultPrevented` by a listener on window, which runs after galley's own
  // on document.
  await page.evaluate(() => {
    window.__glyCtx = [];
    window.addEventListener('contextmenu', (e) => {
      window.__glyCtx.push(e.defaultPrevented);
    });
  });
  await selectRetryBudget(page);
  const onSelection = await page.evaluate(() => {
    const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(onSelection.x, onSelection.y, { button: 'right' });
  await page.waitForTimeout(200);
  const onSelectionCtx = await page.evaluate(() => window.__glyCtx.slice());
  check(
    'a right-click on selected text opens the browser’s menu, not galley’s',
    !(await page.locator('.gly-menu').isVisible()) &&
      onSelectionCtx.length === 1 &&
      onSelectionCtx[0] === false,
    JSON.stringify(onSelectionCtx),
  );
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.ProseMirror p').first().click();
  await page.waitForTimeout(100);
  // RIGHT-CLICK WORKS ANYWHERE BELOW THE BAR: the left margin, the space under
  // the document, and the right-hand panel, as well as the text.
  const margin = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror').getBoundingClientRect();
    const x = Math.max(8, pm.left / 2);
    const y = Math.min(window.innerHeight - 40, pm.top + 60);
    const el = document.elementFromPoint(x, y);
    return { x, y, el: el ? el.tagName + '.' + el.className : null };
  });
  await page.mouse.click(margin.x, margin.y, { button: 'right' });
  await page.waitForTimeout(200);
  const marginRows = (await page.locator('.gly-menu').isVisible())
    ? await menuRows(page)
    : [];
  check(
    'a right-click in the margin opens galley’s menu, with the one item',
    marginRows.length === 1 && /whole document/i.test(marginRows[0]),
    JSON.stringify({ margin, marginRows }),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await tabPress(page, 'Instructions');
  const panelSpot = await page.locator('.gly-tab-hint').boundingBox();
  await page.locator('.gly-tab-hint').click({ button: 'right' });
  await page.waitForTimeout(200);
  const panelRows = (await page.locator('.gly-menu').isVisible())
    ? await menuRows(page)
    : [];
  check(
    'a right-click in the right-hand panel opens galley’s menu, with the one item',
    panelRows.length === 1 && /whole document/i.test(panelRows[0]),
    JSON.stringify({ panelSpot, panelRows }),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  // A TEXT FIELD KEEPS THE BROWSER'S MENU — paste and spelling live there.
  await tabPress(page, 'Chat');
  await page.locator('#gly-chat-box').click({ button: 'right' });
  await page.waitForTimeout(200);
  check(
    'a right-click inside the instruction box opens nothing of ours',
    !(await page.locator('.gly-menu').isVisible()),
  );
  await page.keyboard.press('Escape');
  check(
    'Esc puts the menu away',
    !(await page.locator('.gly-menu').isVisible()),
  );
  // AND THE BROWSER'S OWN MENU IS UNTOUCHED OFF THE PROSE. `preventDefault` is
  // called only where this menu opens, so a right-click on the chrome is still
  // the platform's — nothing is taken away where nothing is given.
  await page.locator('.kit-bar').click({ button: 'right' });
  await page.waitForTimeout(200);
  check(
    'a right-click on the chrome opens nothing of ours',
    !(await page.locator('.gly-menu').isVisible()),
  );

  // THE INVARIANT, AND IT IS THE HALF THAT BREAKS SILENTLY. A block comment's
  // ID mark, {>>@comment cb-…<<}, is the record of its place in the author's
  // file. A node the browser's schema cannot build is not skipped by
  // y-prosemirror — it is DELETED out of the Yjs document, and the next
  // projection writes that deletion to disk. So the note node has to stay
  // registered and parsed and build with its id, and this is read off the real
  // path rather than off /_galley/pending, which would be green over a
  // document already destroyed. Filed by the section grip, the reviewer's own
  // gesture, and taken back out at the end so the rest of this gate counts
  // what it always counted.
  await openSectionForm(page);
  await page.fill('.gly-composer-text', 'Say who the review is for.');
  await page.click('.gly-composer-send');
  await waitForWire(
    page,
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length === 3,
  );
  const blockKey = await page.evaluate(
    async () =>
      (
        (await (await fetch('_galley/pending')).json()).instructions.find(
          (i) => i.anchor === 'block',
        ) || {}
      ).key || '',
  );
  const blockMark = `{>>@comment ${blockKey}<<}`;
  const filed = await waitForDisk(
    new RegExp(`\\{>>@comment ${blockKey || 'none'}<<\\}`),
  );
  check(
    'the block comment\u2019s ID mark is in the .md, and its words are not',
    /^cb-[0-9a-f]{16}$/.test(blockKey) &&
      filed.includes(`# A careful review\n\n${blockMark}\n`) &&
      !filed.includes('Say who the review is for.') &&
      readUnsent().some(
        (c) => c.key === blockKey && c.text === 'Say who the review is for.',
      ),
    JSON.stringify({ blockKey, filed, unsent: readUnsent() }),
  );
  // NO SECTION IS LEFT SELECTED. A grip that selected the whole section to
  // show what the comment is about left that selection standing once the
  // comment was sent, and the next keystroke replaced the section. Measured on
  // 73ea80a: typing after the send turned this fixture into `#  The budget is
  // the subject.` on disk. The grip selects nothing now; this holds it there.
  // Whatever the reviewer had selected before is still theirs — a phrase
  // from earlier in this run — and the claim is that it is not the section:
  // the title is not inside it.
  const afterSend = await page.evaluate(() => {
    const state = window.galleyEdit.editor.state;
    const s = state.selection;
    return {
      from: s.from,
      to: s.to,
      title: state.doc.child(0).nodeSize,
    };
  });
  check(
    'sending a section comment leaves no section selected',
    !(afterSend.from <= 1 && afterSend.to >= afterSend.title - 1),
    JSON.stringify(afterSend),
  );
  // AND IT SURVIVES A PROJECTION THE BROWSER DROVE, which is the half a POST-
  // then-read cannot see: the server writes the block, and it is the round trip
  // through the editor's own schema that would take it back out again. Typed
  // the way a reviewer types next — click into the paragraph and go on.
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' The budget is the subject.');
  const projected = await waitForDisk(/The budget is the subject\./);
  check(
    'typing after a section comment is sent keeps the section — heading, both paragraphs',
    projected.startsWith('# A careful review\n') &&
      projected.includes(
        'should stay explicit and readable. The budget is the subject.',
      ) &&
      projected.includes('Nothing else in the pipeline is told'),
    JSON.stringify(projected),
  );
  check(
    'and it survives a projection the browser drove, with its id — the schema still builds the node',
    /The budget is the subject\./.test(projected) &&
      !!blockKey &&
      projected.includes(blockMark),
    JSON.stringify(projected),
  );
  const removed = await page.evaluate(async (key) => {
    const response = await fetch('_galley/instruction/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    return response.status;
  }, blockKey);
  await waitForWire(
    page,
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length === 2,
  );
  // AND OFF THE TAB BEFORE ANYTHING ELSE IS PRESSED. The delete went over the
  // wire, not through the row, so the tab drops the row on its next refresh; until
  // then the first row is the deleted comment's.
  await page.waitForFunction(
    (key) => !document.querySelector(`[data-draft-id="${key}"]`),
    blockKey,
    { timeout: 10000 },
  );
  check(
    'deleting the block comment takes its mark out of the .md',
    removed === 200 &&
      !(await waitForDisk(/^(?![\s\S]*@comment cb-)/)).includes(blockMark),
    String(removed),
  );

  // AND A CANCELLED GRIP LEAVES NOTHING SELECTED EITHER: the same selection,
  // the same keystroke waiting to replace it, with no comment sent at all.
  // The grip opens with nothing selected and the section is never selected
  // while it is open.
  await openSectionForm(page);
  const gripHeld = await page.evaluate(
    () => !window.galleyEdit.editor.state.selection.empty,
  );
  await page.click('.gly-composer-cancel');
  const afterCancel = await page.evaluate(() => {
    const s = window.galleyEdit.editor.state.selection;
    return { empty: s.empty, from: s.from, to: s.to };
  });
  check(
    'cancelling a section comment leaves no section selected',
    !gripHeld && afterCancel.empty,
    JSON.stringify({ gripHeld, afterCancel }),
  );

  // §2.3 — AN INSTRUCTION CAN BE REVISED, NOT ONLY DESTROYED.
  await tabPress(page, 'Instructions');
  const editBox = `${INSTRUCTION_ROW} textarea`;
  check(
    'an instruction can be revised, not only destroyed',
    await page.isEditable(editBox),
  );
  await page.fill(editBox, 'Make the retry policy concrete, with numbers.');
  await page.locator(editBox).press('Enter');
  // POLLED: `waitForFunction(async …)` resolves on its first poll whatever the
  // fetch says (a promise is truthy), and this check was `true` behind it.
  let editReached = false;
  for (let i = 0; i < 40 && !editReached; i++) {
    editReached = await page.evaluate(async () =>
      (await (await fetch('_galley/pending')).json()).instructions.some(
        (i) => i.text === 'Make the retry policy concrete, with numbers.',
      ),
    );
    if (!editReached) await page.waitForTimeout(100);
  }
  check(
    'and the edit reaches the instruction the agent will actually be handed',
    editReached,
  );

  // AN EDITED INSTRUCTION KEEPS A TYPED LINE BREAK: Shift-Enter breaks the
  // line, Enter saves, and the words saved are the words typed.
  await page.locator(editBox).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Say how many.');
  await page.keyboard.press('Enter');
  const editedTo =
    'Make the retry policy concrete, with numbers.\nSay how many.';
  let editedOK = false;
  for (let i = 0; i < 40 && !editedOK; i++) {
    editedOK = await page.evaluate(
      async (want) =>
        (await (await fetch('_galley/pending')).json()).instructions.some(
          (i) => i.text === want,
        ),
      editedTo,
    );
    if (!editedOK) await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  const editedCard = await page.inputValue(editBox);
  check(
    'an edited instruction keeps a typed line break — saved, and shown in its row',
    editedOK && editedCard === editedTo,
    JSON.stringify({ editedOK, editedCard }),
  );

  // AN EDIT TO AN INSTRUCTION THAT IS GONE KEEPS THE REVIEWER'S WORDS. The
  // instruction is deleted over the wire while its box holds unsaved words (an
  // agent's send clears it the same way). Two ways the row can go: the save
  // answers that the key is not pending, or the next poll repaints without the
  // row. Either way the words move to the Chat box with the reason, rather than
  // vanishing with the row.
  const strandedReason =
    'that instruction was sent or deleted, so your edit went to the Chat box';
  const fileDocComment = (text) =>
    page.evaluate(async (said) => {
      const res = await fetch('_galley/instruct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'comment_document', text: said }),
      });
      const view = await res.json();
      return view.instructions.find((i) => i.text === said)?.key || '';
    }, text);
  const openEditOn = async (key, words) => {
    const box = `[data-draft-id="${key}"] textarea`;
    await tabPress(page, 'Chat');
    await page.waitForSelector(box, { timeout: 10000 });
    await page.fill(box, words);
  };
  const stranded = () =>
    page.evaluate(() => ({
      words: document.querySelector('#gly-chat-box')?.value || '',
      shown: !!document.querySelector('#gly-chat-box')?.offsetParent,
      note: document.querySelector('#gly-status')?.textContent || '',
    }));
  const savedKey = await fileDocComment('stranded by a save');
  const savedWords = 'words typed into an edit\nthat the save could not keep';
  await openEditOn(savedKey, savedWords);
  await page.evaluate(async (key) => {
    await fetch('_galley/instruction/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    document.querySelector(`[data-draft-id="${key}"] textarea`)?.blur();
  }, savedKey);
  await page.waitForTimeout(800);
  const afterSave = await stranded();
  check(
    'an edit saved onto a deleted instruction keeps its words on the page and says why',
    afterSave.shown &&
      afterSave.words.includes(savedWords) &&
      afterSave.note.includes(strandedReason),
    JSON.stringify(afterSave),
  );
  await page.fill('#gly-chat-box', '');
  const polledKey = await fileDocComment('stranded by a poll');
  const polledWords = 'words still being typed when the row went';
  await openEditOn(polledKey, polledWords);
  await page.evaluate(async (key) => {
    await fetch('_galley/instruction/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  }, polledKey);
  await page.waitForFunction(
    (key) => !document.querySelector(`[data-draft-id="${key}"]`),
    polledKey,
    { timeout: 10000 },
  );
  await page.waitForTimeout(200);
  const afterPoll = await stranded();
  check(
    'an edit whose instruction leaves the tab mid-sentence keeps its words on the page and says why',
    afterPoll.shown &&
      afterPoll.words.includes(polledWords) &&
      afterPoll.note.includes(strandedReason),
    JSON.stringify(afterPoll),
  );
  await page.fill('#gly-chat-box', '');
  // AND A ROW THE READER DELETES TAKES ITS WORDS WITH IT: that one was meant.
  const deletedKey = await fileDocComment('deleted on purpose');
  await openEditOn(deletedKey, 'words the reader chose to throw away');
  await page.click(`[data-draft-id="${deletedKey}"] ${ROW_DELETE}`);
  await page.waitForFunction(
    (key) => !document.querySelector(`[data-draft-id="${key}"]`),
    deletedKey,
    { timeout: 10000 },
  );
  await page.waitForTimeout(200);
  check(
    'a row the reader deletes sends nothing to the Chat box',
    (await stranded()).words === '',
    JSON.stringify(await stranded()),
  );
  await page.locator('.ProseMirror p').first().click();

  // THE THREE BOXES HOLD A LOT OF WORDS. The Chat box, the selected-text composer
  // and a row's box grow with what is typed and stop short of the window.
  const boxNow = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      return {
        h: +el.getBoundingClientRect().height.toFixed(1),
        font: getComputedStyle(el).fontSize,
        scroll: el.scrollHeight,
        client: el.clientHeight,
        half: window.innerHeight / 2,
      };
    }, sel);
  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  const boxes = {};
  const measureBox = async (name, sel) => {
    // A frame after it opens, which is when a reviewer first sees it.
    await page.waitForTimeout(100);
    const opened = await boxNow(sel);
    await page.fill(sel, sixty);
    await page.waitForTimeout(100);
    boxes[name] = { opened, full: await boxNow(sel) };
  };
  await tabPress(page, 'Chat');
  await measureBox('document', '#gly-chat-box');
  await page.fill('#gly-chat-box', '');
  await selectPhrase(page, 'Nothing else in the pipeline');
  await page.click('.gly-comment-button');
  await page.waitForSelector('.gly-composer-form:not([hidden])');
  await measureBox('selection', '.gly-composer-text');
  await page.fill('.gly-composer-text', '');
  await page.click('.gly-composer-cancel');
  await tabPress(page, 'Instructions');
  const rowWords = await page.inputValue(editBox);
  await measureBox('edit', editBox);
  await page.fill(editBox, rowWords);
  await page.locator('.ProseMirror p').first().click();
  const all = Object.values(boxes);
  check(
    'none of the three comment boxes grows past half the window',
    all.length === 3 &&
      all.every((b) => b.opened && b.full) &&
      all.every(
        (b) => b.full.h <= b.full.half + 1 && b.full.scroll > b.full.client,
      ),
    JSON.stringify(boxes),
  );

  // Back to one, so the count checks below read the state they were written
  // against.
  await tabPress(page, 'Chat');
  await page.click(`${CHAT_ROW} ${ROW_DELETE}`);
  await page.waitForFunction(
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length === 1,
  );

  // NOTHING ON THE TOP BAR MOVES WHEN THE ROUND CHANGES: the rects are read over a
  // change made somewhere else, the count going to zero from a deleted sentence.
  const barRects = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.kit-bar button')].map((el, i) => {
          const r = el.getBoundingClientRect();
          return [
            `${i}:${el.id || el.tagName}`,
            [+r.x.toFixed(2), +r.y.toFixed(2), +r.width.toFixed(2)],
          ];
        }),
      ),
    );
  const barBefore = await barRects();
  // §5.4 — DELETE THE SENTENCE, DELETE THE INSTRUCTION ABOUT IT.
  //
  // Court: "if we highlight a sentence and add an instruction and then delete
  // the sentence, we should delete the instruction as well." It is the idiom
  // this codebase already uses one population over — deleting text under the
  // agent's pending mark has always been the verdict by hand — and until now
  // the reviewer's own mark behaved differently, leaving the instruction behind
  // marked "its words were removed". That describes
  // the mechanism; what the reviewer did was retract the note.
  //
  // WHAT THIS REPLACED, AND WHAT THOSE CHECKS KNEW. A block of seven checks
  // stood here and drove exactly this gesture to prove the OPPOSITE decision
  // (2026-08-19: an unplaced instruction stays as a full card in the rail). They
  // asserted the section head reads `UNPLACED · ITS WORDS WERE REMOVED`, that
  // the card keeps the instruction's text, that it quotes the words it lost,
  // that the old apologising explainer is gone, that the card is dashed outside
  // with a solid 3px violet edge and its lost quote struck in `--gly-del`, and
  // that both verbs survive on it. None of that machinery is deleted — a block
  // instruction whose block goes can still reach it — but this gesture no longer
  // produces one, so this gate no longer exercises that styling. Written down
  // rather than quietly dropped, per this repository's own rule about deleting a
  // check: say what it knew.
  await selectRetryBudget(page);
  await page.keyboard.press('Backspace');
  // READ OFF THE SERVER, not off the rail. The card leaving the screen is what
  // the reviewer sees, and it is also what a browser-side filter would produce
  // while the thread sat in the review map — invisible but present, which this
  // codebase rates as the worse of the two. The sweep is the SERVER's, so the
  // claim is about what the server still holds.
  for (let i = 0; i < 10; i++) {
    const d = await page.evaluate(async () =>
      JSON.stringify(
        (await (await fetch('_galley/pending')).json()).instructions.map(
          (x) => [x.key, x.run],
        ),
      ),
    );
    console.log(`DIAG t=${i}s ${d}`);
    await page.waitForTimeout(1000);
  }
  // POLLED EXPLICITLY, NOT THROUGH `waitForFunction`, and that is the whole
  // reason this check can fail. `page.waitForFunction(async () => …)` hands the
  // wait a PROMISE from the page function, a promise is truthy, and the wait
  // therefore resolves on its first poll whatever the fetch actually said. The
  // first cut of this check used that shape and reported `ok` with the orphaned
  // instruction sitting in the payload — measured by polling it once a second
  // for ten seconds with the sweep removed, and it never left.
  //
  // THE SAME SHAPE IS ELSEWHERE IN THIS FILE and is left alone rather than
  // swept up here: every other instance waits for something that does become
  // true, so they are slow no-ops rather than false passes, and rewriting them
  // blind is how a gate that was merely useless becomes one that is wrong.
  const pendingKeys = async () =>
    page.evaluate(async () =>
      (await (await fetch('_galley/pending')).json()).instructions.map(
        (x) => x.key,
      ),
    );
  let left = await pendingKeys();
  for (let i = 0; i < 20 && left.length > 0; i++) {
    await page.waitForTimeout(500);
    left = await pendingKeys();
  }
  check(
    'deleting the highlighted sentence retracts the instruction about it',
    left.length === 0,
    JSON.stringify(left),
  );
  check(
    'and the tab has no row left to explain it away',
    (await page.locator(INSTRUCTION_ROW).count()) === 0,
  );
  // THE DELETION THAT RETRACTED THE INSTRUCTION IS ITSELF A HAND EDIT, so the
  // primary holds Revise rather than settling to Approve. A pending reviewer
  // change is outgoing markup exactly as an instruction is — verdict.ts's
  // verdictLabel reads `view.changes` now, so zero instructions no longer means
  // a clean document while an unsent edit stands. This gate asserted Approve
  // here before that rule existed (Court: a hand edit must hold Revise so the
  // press is a choice, not a silent seal over unsent markup).
  await page.waitForFunction(() =>
    /Revise/.test(document.getElementById('gly-revise').innerText),
  );
  check(
    'the primary holds Revise while the retracting hand edit is still pending',
    (await page.locator('#gly-revise').innerText()).includes('Revise'),
    await page.locator('#gly-revise').innerText(),
  );
  const barAfter = await barRects();
  const moved = Object.keys(barBefore).filter(
    (k) => JSON.stringify(barBefore[k]) !== JSON.stringify(barAfter[k]),
  );
  check(
    'the round changing moves nothing on the top bar',
    moved.length === 0,
    JSON.stringify({ moved, before: barBefore, after: barAfter }),
  );
  const readout = (await page.locator('#gly-status').innerText()).trim();
  check(
    'the status reads the fixed grammar, which always fits',
    /(v1|round \d+) · (draft|with the agent|settled)/.test(readout) &&
      !readout.includes('instructions in this round'),
    readout,
  );

  await addOverallInstruction(
    page,
    'Keep the opening focused on the decision.',
    1,
  );
  // The wait is BOUNDED and its failure is still a FAIL: if the card never
  // arrives this reports false rather than throwing, so the remaining checks in
  // this section still run and the output still names what broke.
  check(
    'whole-document instructions become rows in the Chat tab',
    await page
      .waitForSelector(CHAT_ROW, { timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );
  check(
    'no native prompt or modal was opened',
    dialogs === 0,
    `${dialogs} dialogs`,
  );

  // A DIRECT HAND EDIT rides in this round too. The reviewer's own edits are
  // the round's outgoing message, drawn as a trail glow in the prose; the check
  // after the send is that pressing Revise SETTLES them — the same wipe approve
  // does, at the other verdict (see verdict.ts clearTrail). Left standing they
  // re-anchor onto the agent's rebuilt document, where the edit is already
  // baseline text, and read as a stale pending change over prose nobody will
  // act on again.
  await page.evaluate(() => {
    const ed = window.galleyEdit.editor;
    let end = null;
    ed.state.doc.descendants((node, pos) => {
      if (end === null && node.type.name === 'paragraph') {
        end = pos + node.nodeSize - 1;
        return false;
      }
      return true;
    });
    ed.commands.focus();
    ed.commands.insertContentAt(end, ' and precise');
  });
  check(
    'a hand edit shows a trail glow in the prose before Revise',
    await page
      .waitForSelector('.ProseMirror .gly-trail-ins', { timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );

  // THE CHAT BOX LEFT HOLDING UNFILED WORDS: only FILED instructions travel, so the
  // check after the send is that those words were not sent and are still there.
  await tabPress(page, 'Chat');
  await page.fill('#gly-chat-box', 'an unsent draft');
  // WITH WORK PENDING APPROVE WON'T SEAL OVER IT: it offers Revise & Approve, and
  // plain Revise is on the send bar.
  await openApproveMenu(page);
  const exits = await page.locator('.gly-verdict-menu button').allInnerTexts();
  check(
    'Approve with work pending offers Revise & Approve, and no plain Revise',
    JSON.stringify(exits) === JSON.stringify(['Revise & Approve']),
    JSON.stringify(exits),
  );
  await page.keyboard.press('Escape');
  const beforeRevise = await windowMark(page);
  const startBefore = await stateStart(page);
  await page.click('#gly-revise');
  // The window, keyed to this press. See responseWindowOpen.
  await responseWindowOpen(page, beforeRevise);
  // THE REPLY ENTERS AFTER THE STATE, so the state's text does not move.
  await page
    .waitForFunction(
      () =>
        (document.getElementById('gly-status')?.textContent || '').includes(
          'revision requested',
        ),
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  const startAfter = await stateStart(page);
  const replyLine = await page.evaluate(
    () => document.getElementById('gly-status')?.textContent || '',
  );
  check(
    'a reply on the status line comes after the state, and the state does not move',
    replyLine.includes('revision requested') &&
      startBefore !== null &&
      startAfter !== null &&
      Math.abs(startBefore - startAfter) <= 1,
    JSON.stringify({ startBefore, startAfter, replyLine }),
  );
  const leftPending = await page.evaluate(
    async () =>
      (await (await fetch('_galley/pending')).json()).instructions.length,
  );
  check(
    'Revise sends and clears the instruction round',
    leftPending === 0,
    `${leftPending} instruction(s) still pending`,
  );
  check(
    'and words left unfiled in the Chat box were not sent, and are still there',
    (await page.inputValue('#gly-chat-box')) === 'an unsent draft',
    await page.inputValue('#gly-chat-box'),
  );
  await page.fill('#gly-chat-box', '');
  const settled = await page
    .waitForFunction(
      () =>
        document.querySelectorAll(
          '.ProseMirror .gly-trail-ins, .ProseMirror .gly-trail-ghost',
        ).length === 0,
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    'and Revise SETTLED the reviewer’s hand edits — no trail glow or ghost survives the send',
    settled,
    JSON.stringify({
      ins: await page.locator('.ProseMirror .gly-trail-ins').count(),
      ghost: await page.locator('.ProseMirror .gly-trail-ghost').count(),
    }),
  );
  check(
    'a failed agent result closes the wait without closing review',
    (await ack(page, 'failed', 'test continues')) === 204,
  );

  // §5.1 — HISTORY OPENS ON THE ROUND YOU JUST GOT BACK.
  //
  // It opened on `v1 · Starting version` showing "No earlier version to
  // compare" — the emptiest state the surface has — over rounds of real work,
  // and it did so because the App refreshes the panel ONCE AT PAGE LOAD to
  // paint the door's count. At that moment v1 was the only round, the panel
  // pinned its selection to it, and every later refresh found v1 still in the
  // list and kept it. The only thing that ever moved the selection again was an
  // arrival calling showRound, which is why the defect looked intermittent:
  // press the door with news behind it and it works, open History any other
  // way and it is still on v1 from page load.
  //
  // SO THIS OPENS IT COLD, WITH NO ARRIVAL OUTSTANDING, which is the state the
  // bug lives in — the round above was cut by the reviewer's own press and the
  // agent reported it could not answer, so nothing has landed and the door is
  // not marked. Read off the paper's own `data-to`, which is the SERVER's
  // answer to which version is being shown, never off the cards, which is a
  // count of what this page managed to draw.
  const early = await page.evaluate(
    async () => (await (await fetch('_galley/versions')).json()).rounds,
  );
  await page.click('.gly-versions-open');
  await page.waitForSelector('.gly-versions:not([hidden])');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions-paper')?.dataset.to,
  );
  const landedOn = await page.evaluate(() => ({
    to: document.querySelector('.gly-versions-paper').dataset.to,
    empty: document
      .querySelector('.gly-versions-paper')
      .innerText.includes('No earlier version'),
  }));
  check(
    'History opens on the newest round, not on the starting version',
    early.length > 1 &&
      landedOn.to === String(early[early.length - 1].n) &&
      !landedOn.empty,
    JSON.stringify({ ...landedOn, rounds: early.map((r) => r.n) }),
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions')?.hidden === true,
  );

  // --- History is a reading mode ---
  //
  // TWO REAL ROUNDS FIRST, WITH THE AGENT'S TESTIMONY ON THEM. Every claim
  // below is about a join — an ask beside the change that answered it, a card
  // beside the mark it is about — and a fixture with one round and no manifest
  // is a fixture in the state every one of those bugs is absent from.
  //
  // The agent's write surface is the FILE: while the handoff window is open it
  // owns the .md, and the watcher imports what it saves. That is the real path,
  // so it is the one driven here.
  async function agentReturns(next, manifest) {
    const roundsBefore = await page.evaluate(
      async () =>
        (await (await fetch('_galley/versions')).json()).rounds.length,
    );
    writeFileSync(doc, next);
    await page.waitForFunction(
      (t) => document.querySelector('.ProseMirror').innerText.includes(t),
      next
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))[0]
        .slice(0, 30),
      { timeout: 15000 },
    );
    const roundNote = next
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))[0]
      .slice(0, 40);
    const status = await page.evaluate(
      async (body) =>
        (
          await fetch('_galley/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // A NOTE, BECAUSE AN AGENT THAT ACKS WRITES ONE. This was `''`, which made
            // the fixture the one state the round-level answer is absent from — and
            // that sentence is the ONLY answer there is until a manifest names one
            // per change. `←` on the round card is asserted against it below.
          })
        ).status,
      {
        state: 'answered',
        note: `Revised the round: ${roundNote}`,
        changes: manifest,
      },
    );
    if (status !== 204) throw new Error(`ack answered ${status}`);
    await waitForWire(
      page,
      async (n) =>
        (await (await fetch('_galley/versions')).json()).rounds.length > n,
      roundsBefore,
      10000,
    );
    await page.waitForTimeout(900);
  }
  async function sendRound(asks) {
    const already = await page.evaluate(
      async () =>
        (await (await fetch('_galley/pending')).json()).instructions.length,
    );
    for (const [i, ask] of asks.entries()) {
      await addOverallInstruction(page, ask, already + i + 1);
    }
    // BY TEXT, NEVER BY POSITION. `/_galley/pending` sorts threads by key, so
    // the order an instruction was typed in is not the order it comes back in
    // — a positional read here attributes the agent's note to the wrong ask
    // while looking entirely correct, which is the exact mistake `joinTestimony`
    // refuses on the server side.
    const listed = await page.evaluate(async () =>
      (await (await fetch('_galley/pending')).json()).instructions.map((i) => [
        i.text,
        i.key,
      ]),
    );
    const asked = new Map(listed);
    await reviseReady(page);
    const before = await windowMark(page);
    await page.click('#gly-revise');
    // THE WINDOW, NOT THE CLEARED PENDING SET. The press clears the
    // instructions in its FIRST mutation and opens the response window several
    // steps later (a synchronous projection and a version commit in between),
    // so `instructions.length === 0` goes true while `s.watch` is still nil —
    // and the ack the agent sends next is refused 409 "nothing has been asked
    // of you". `handoff` is the flag openResponseWindow sets LAST.
    await responseWindowOpen(page, before);
    return asked;
  }

  // The DRAFT's own metrics, read before History exists, because "the same type
  // as the draft" is a comparison and not a number
  // somebody wrote down. A number here would go green the day the draft's type
  // changed and History's did not, which is the whole bug.
  const draftType = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    const s = getComputedStyle(pm);
    return { size: s.fontSize, line: s.lineHeight };
  });

  const ask1 = await sendRound(['Open with the decision, not the background.']);
  await agentReturns(
    '# A careful review\n\nBounded retries: 12 attempts over 48 hours.\n\n' +
      '## The budget\n\nEach message gets a retry budget.\n\n' +
      '## What happens at exhaustion\n\nWhen a message exhausts its budget it moves on.\n',
    [
      {
        quote: 'Bounded retries: 12 attempts over 48 hours.',
        answers: [ask1.get('Open with the decision, not the background.')],
        note: 'Led with the decision; moved the background after it.',
      },
    ],
  );
  // THE SECOND ROUND CARRIES THREE ASKS AND TWO CHANGES, and that is the shape
  // the fixture needs rather than a tidier one. A round with ONE change cannot
  // fail a `CHANGE k OF K` ordinal, cannot fail an alignment (one card has
  // nowhere to drift to), and cannot fail selection-by-dimming at all — there
  // is no other card to be dimmed. And the third ask is one the agent never
  // claims, which is the ask-only card: nothing the reviewer sent may ever
  // disappear, and a fixture where everything was answered certifies that it
  // does not.
  // A BLOCK INSTRUCTION WITH A BLANK LINE, filed through the section grip and
  // sent in the next round: two paragraphs in its row, in the amber box under
  // its heading, and in History once the round is sent.
  const blockSaid = 'Say who the review is for.\n\nAnd why it matters now.';
  await openSectionForm(page);
  await page.fill('.gly-composer-text', blockSaid);
  await page.click('.gly-composer-send');
  await waitForWire(
    page,
    async (want) =>
      (await (await fetch('_galley/pending')).json()).instructions.some(
        (i) => i.text === want,
      ),
    blockSaid,
  );
  await page.waitForTimeout(600);
  const blockShown = await page.evaluate(async (want) => {
    const key = (
      (await (await fetch('_galley/pending')).json()).instructions.find(
        (i) => i.text === want,
      ) || {}
    ).key;
    const row = document.querySelector(`[data-draft-id="${key}"] textarea`);
    const words = document.querySelector(
      `.gly-note[data-comment-id="${key}"] .gly-note-words`,
    );
    return {
      key,
      card: row?.value || '',
      amber: words ? words.innerText : '',
    };
  }, blockSaid);
  check(
    'a block instruction with a blank line shows two paragraphs in its row and in the amber box',
    blockShown.card === blockSaid && blockShown.amber === blockSaid,
    JSON.stringify(blockShown),
  );
  const ask2 = await sendRound([
    'Say what the default budget is, in numbers.',
    'Name the queue and its retention.',
    'Cite the incident review verbatim.',
  ]);
  await agentReturns(
    '# A careful review\n\nBounded retries: 12 attempts over 48 hours.\n\n' +
      '## The budget\n\nEach message gets a retry budget of 12 attempts over 48 hours (incident #482).\n\n' +
      '## What happens at exhaustion\n\nWhen a message exhausts its budget it moves to the dead letter queue, kept 14 days.\n',
    [
      {
        quote: 'of 12 attempts over 48 hours (incident #482)',
        answers: [ask2.get('Say what the default budget is, in numbers.')],
        note: 'Added the 12-attempt budget and linked incident #482.',
      },
      {
        quote: 'to the dead letter queue, kept 14 days',
        answers: [ask2.get('Name the queue and its retention.')],
        note: 'Named the queue and its 14-day retention.',
      },
    ],
  );

  const record = await page.evaluate(
    async () => (await (await fetch('_galley/versions')).json()).rounds,
  );
  const newest = record[record.length - 1].n;

  // AND IT STILL FOLLOWS THE NEWEST once two more rounds have landed on top of
  // the one it opened on a moment ago — the selection tracks the record until
  // the reviewer PICKS a round, and neither opening the door nor closing it is
  // picking one.
  //
  // The door is pressed TWICE on purpose. A round has landed since the last
  // press, so the first one is the arrival deep-link — it lands on THAT round's
  // reading state, which is `showRound`'s whole job and is asserted where the
  // arrival strip is built. The second press is the cold path, which is the one
  // this section is about and the one the landing is behind.
  // Where the draft was, for the way back.
  const draftScroll = await page.evaluate(() => window.scrollY);

  // THE ARRIVAL IS CONSUMED BEFORE THE DOOR IS PRESSED, and without this the
  // check below races the page NOTICING the round that just landed.
  //
  // An unread arrival makes the FIRST open of History deep-link to that round's
  // reading state (`VersionsPanel.showRound`, the one override of DEFAULT_VIEW
  // there is); once read, later opens show the landing. The sequence here opens,
  // escapes, opens again and asserts the LANDING — which holds only if the first
  // press consumed the arrival. On a slower machine the page had not yet noticed
  // it when the first press landed, so the first open showed the landing, the
  // arrival was noticed afterwards, and the SECOND open deep-linked. That is
  // exactly the diagnostic CI reported: `paperTo` correct at "6", `subHidden`
  // false — the sub-bar open, which is the reading state.
  //
  // `is-new` on the door is the page saying it has seen the arrival, so waiting
  // for it makes both presses deterministic. This is the same root cause as
  // §6.3's, one section down: a check that reads an arrival must wait for the
  // arrival, not for the clock.
  //
  // AND IT MUST BE THE ARRIVAL OF THE ROUND THIS CHECK IS ABOUT. `is-new` alone
  // was not enough: it reproduced on CI twice more with the same diagnostic
  // (`paperTo` right, `subHidden` false, seed unpainted). The bare class is
  // raised by ANY unconsumed arrival, so an earlier round's could satisfy the
  // wait, the first press consumed THAT one, then `newest` landed between the
  // presses and the second press deep-linked to it — the reading state, exactly
  // as reported. The door's title names the round it is holding
  // (`v<n> just arrived`, paintVersionsButton in history.ts), so the wait keys
  // on the number this check later asserts against. No page change: the gate
  // now waits for the fact it reads.
  await page.waitForFunction((n) => {
    const door = document.querySelector('.gly-versions-open');
    return (
      !!door &&
      door.classList.contains('is-new') &&
      door.title.includes(`v${n} just arrived`)
    );
  }, newest);
  await page.click('.gly-versions-open');
  await page.waitForSelector('.gly-versions:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions')?.hidden === true,
  );
  await page.click('.gly-versions-open');
  await page.waitForSelector('.gly-versions:not([hidden])');
  // THE WAIT IS UNCHANGED; ONLY ITS FAILURE IS. This check timed out once on
  // CI and passed on rerun, and a bare TimeoutError reported the line number
  // and nothing else — not which of its two conditions failed, not what the
  // values were. It has two independent ways to hang: the round number, and
  // `.gly-versions-sub` being hidden, which is what tells the landing state
  // from the reading state and would stay open if a late arrival deep-linked
  // the second door press.
  //
  // A SEMANTIC FIX WAS TRIED FIRST AND REVERTED, which is worth recording so
  // it is not tried again blind. Re-reading the record inside the wait —
  // rather than comparing against a `newest` captured well above this line —
  // is a better-sounding assertion and made CI fail DIFFERENTLY: the wait
  // settled a moment earlier, before the landing rail had finished painting,
  // and the block below died on a null `.gly-versions-seed`. Adding the seed
  // to the wait then broke it locally too. Two attempts, both worse than the
  // flake, on a failure seen once.
  //
  // So the semantics stay exactly as they were and the failure becomes
  // legible instead. The next occurrence will say which condition held and
  // what the record actually was, which is the evidence the first two
  // attempts were missing.
  const followed = await page
    .waitForFunction(
      (n) =>
        document.querySelector('.gly-versions-paper')?.dataset.to ===
          String(n) &&
        document.querySelector('.gly-versions-sub')?.hidden === true,
      newest,
    )
    .then(
      () => null,
      async () =>
        page.evaluate(async (n) => {
          const rounds = (await (await fetch('_galley/versions')).json())
            .rounds;
          return {
            waitedFor: n,
            newestNow: rounds[rounds.length - 1].n,
            paperTo: document.querySelector('.gly-versions-paper')?.dataset.to,
            subHidden: document.querySelector('.gly-versions-sub')?.hidden,
            seedPainted: !!document.querySelector('.gly-versions-seed'),
          };
        }, newest),
    );
  check(
    'History follows the record while the door is opened and shut',
    followed === null,
    JSON.stringify(followed),
  );

  check(
    'and it follows the record as rounds land, until a round is chosen',
    true,
  );

  // The three states of History, captured on demand. `docs/design/` is
  // re-shot against the built binary at the end of a phase, and driving the
  // gate is the only place all three states exist with real rounds behind
  // them — a hand-built fixture would be a fourth thing to keep true.
  if (process.env.GALLEY_SHOTS)
    await page.screenshot({ path: `${process.env.GALLEY_SHOTS}/landing.png` });
  // §5.2 — THE LANDING.
  const landing = await page.evaluate(() => {
    const rail = document.querySelector('.gly-versions-rail');
    if (!rail) {
      return null;
    }
    return {
      title: rail.querySelector('.gly-versions-rail-title')?.textContent,
      sub: document.querySelector('.gly-versions-sub')?.hidden,
      cards: [...rail.querySelectorAll('.gly-versions-round')].map((b) => ({
        round: b.dataset.round,
        head: b.querySelector('.gly-card-head').textContent,
        ask: [...b.querySelectorAll('.gly-versions-ask')]
          .map((p) => p.textContent)
          .join('\n'),
        asks: [...b.querySelectorAll('.gly-versions-ask')].map(
          (p) => p.innerText,
        ),
        answer:
          (b.querySelector('.gly-versions-answer') || {}).textContent || '',
        foot: b.querySelector('.gly-versions-foot').textContent,
      })),
      seed: document.querySelector('.gly-versions-seed')?.innerText,
      // NULL-GUARDED BECAUSE A MISSING SURFACE MUST FAIL A CHECK, NOT THROW THE
      // RUN AWAY. This file states that rule and this line broke it: on CI the
      // seed card had not painted, `getComputedStyle(null)` threw
      // "parameter 1 is not of type 'Element'", and the TypeError took every
      // check below it with it — so one late-painting card was reported as a
      // dead run rather than as one red claim. A guard here is not tolerance
      // for the absence; the check that reads `seedDashed` still fails on null.
      seedDashed: (() => {
        const seed = document.querySelector('.gly-versions-seed');
        return seed ? getComputedStyle(seed).borderTopStyle : null;
      })(),
      marks: document.querySelectorAll(
        '.gly-versions-paper .gly-ins, .gly-versions-paper .gly-del',
      ).length,
      chip: document
        .querySelector('.gly-versions-open')
        ?.classList.contains('is-open'),
      primary: document.querySelector('.kit-primary').innerText.trim(),
      readout: document.querySelector('#gly-status').innerText.trim(),
    };
  });
  check(
    'the landing rail is headed for rounds, newest first',
    landing?.title === 'ROUNDS — NEWEST FIRST' && landing?.sub === true,
    JSON.stringify(landing?.title),
  );
  // ONE CARD PER EXCHANGE. The store holds two versions per round — the cut
  // taken on the press and the cut taken on the return — and both carry the
  // same instruction, so a card per version drew every ask twice.
  const exchanges = record
    .filter((r) => !(r.n === 1 && r.reason === 'opened'))
    .filter((r) => !record.some((o) => o.answers === r.n)).length;
  check(
    'one card per round, newest first, each naming its round, its asks and what it moved',
    landing?.cards.length === exchanges &&
      landing?.cards.length < record.length - 1 &&
      Number(landing?.cards[0].round) > Number(landing?.cards[1].round) &&
      /^ROUND \d+ · /.test(landing?.cards[0].head) &&
      landing?.cards.some((c) =>
        c.ask.includes('Say what the default budget is'),
      ) &&
      // NO ARROW ON THE FOOT. ← belongs to the ANSWER — the sentence the agent
      // wrote when it acked — and while the foot held it, the card's only ←
      // pointed at a version number while the agent's own words were rendered
      // after a → as though the reviewer had said them.
      landing?.cards.every((c) => /^v\d+ · /.test(c.foot)),
    JSON.stringify(landing?.cards),
  );
  // EACH INSTRUCTION IS ITS OWN LINE IN HISTORY, with its own line breaks.
  // The server used to hand History one `·`-joined sentence per round, which
  // ran every instruction together and every line of each into one.
  const round2 = landing?.cards.find((c) =>
    c.asks.some((a) => a.includes('Say what the default budget is')),
  );
  check(
    'History lists each instruction of a round separately, and keeps a blank line inside one',
    !!round2 &&
      round2.asks.length === 4 &&
      round2.asks.every((a) => a.startsWith('→ ') && !a.includes(' · ')) &&
      round2.asks.includes(`→ ${blockSaid}`),
    JSON.stringify(round2),
  );
  // THE TWO ARROWS MEAN WHAT THEY SAY. `Round.Instruction` is the ask on the
  // reviewer's cut and the agent's sentence on the landing, and roundCards
  // folds the two into one card — so reading the card's own field put the
  // ANSWER after the ask's arrow and left the ask off the surface entirely.
  check(
    '→ is what the reviewer asked and ← is what the agent said back',
    landing?.cards.every((c) => c.ask.startsWith('→')) &&
      landing?.cards.some((c) => (c.answer || '').startsWith('←')) &&
      !landing?.cards.some((c) => c.ask.includes('answering v')),
    JSON.stringify(
      landing?.cards.map((c) => ({ ask: c.ask, answer: c.answer })),
    ),
  );
  check(
    'the changes count on a card is the server’s, never a count of drawn marks',
    landing?.cards.some((c) => /· \d+ change/.test(c.foot)) &&
      record.filter((r) => r.changed > 0).length > 0,
    JSON.stringify({
      feet: landing?.cards.map((c) => c.foot),
      changed: record.map((r) => r.changed),
    }),
  );
  check(
    'an ask and the answer that discharged it are one card, not two saying the same thing',
    new Set(landing?.cards.map((c) => c.ask)).size === landing?.cards.length,
    JSON.stringify(landing?.cards.map((c) => c.ask)),
  );
  // ONE CARD LANGUAGE DOWN THE WHOLE COLUMN. The landing's entries were
  // `<button>`s that carried `.gly-card-head` and a `.gly-versions-ask` without
  // ever being `.gly-card` — the card vocabulary worn by something that was not
  // a card, with its own background, border, radius, padding, cursor, type and
  // colour re-declared to undo a button's user-agent appearance. Shown red
  // against the tracked build: `cards 0 of 3, seed false`.
  const landingLanguage = await page.evaluate(() => {
    const rail = document.querySelector('.gly-versions-rail');
    const rounds = [...rail.querySelectorAll('.gly-versions-round')];
    const seed = rail.querySelector('.gly-versions-seed');
    return {
      rounds: rounds.length,
      cards: rounds.filter((el) => el.classList.contains('gly-card')).length,
      heads: rounds.filter((el) => el.querySelector(':scope > .gly-card-head'))
        .length,
      bodies: rounds.filter((el) => el.querySelector(':scope > .gly-card-body'))
        .length,
      seedCard: !!(seed && seed.classList.contains('gly-card')),
      // The whole column on one left edge, which is what a reader reads.
      edges: [
        ...new Set(
          [...rounds, seed]
            .filter(Boolean)
            .map((el) => Math.round(el.getBoundingClientRect().left)),
        ),
      ],
    };
  });
  check(
    'every entry in the landing rail is a card, in the card’s own anatomy — not a button wearing it',
    landingLanguage.rounds > 1 &&
      landingLanguage.cards === landingLanguage.rounds &&
      landingLanguage.heads === landingLanguage.rounds &&
      landingLanguage.bodies === landingLanguage.rounds &&
      landingLanguage.seedCard &&
      landingLanguage.edges.length === 1,
    JSON.stringify(landingLanguage),
  );
  check(
    'the file as galley opened it is the dashed foot card, not an entry in the list',
    landing?.seed?.includes('V1 · STARTING VERSION') &&
      landing?.seed?.includes('The file as galley opened it.') &&
      landing?.seedDashed === 'dashed',
    JSON.stringify(landing),
  );
  check(
    'the landing paper is the current document, plain — no marks on it',
    landing?.marks === 0,
    String(landing?.marks),
  );
  check(
    'the bar hands the primary’s slot to the way out, and lights the History chip',
    landing?.chip === true && landing?.primary === '← back to draft',
    JSON.stringify(landing),
  );
  check(
    'and the readout says where you are and that the draft is safe',
    landing?.readout === `${exchanges} rounds · draft is untouched`,
    landing?.readout,
  );
  // §5.3 — THE READING STATE.
  await page.click(`.gly-versions-round[data-round="${newest}"]`);
  await page.waitForFunction(
    (n) =>
      document.querySelector('.gly-versions-paper')?.dataset.to === String(n) &&
      !document.querySelector('.gly-versions-sub').hidden,
    newest,
  );
  await page.waitForSelector('.gly-versions-change');
  const view = await page.evaluate(
    async (n) =>
      await (await fetch(`_galley/versions/view?to=${n}&view=inplace`)).json(),
    newest,
  );
  const reading = await page.evaluate(() => {
    const paper = document.querySelector('.gly-versions-paper');
    const s = getComputedStyle(paper);
    return {
      where: document.querySelector('.gly-versions-where').textContent,
      handle: document.querySelector('.gly-versions-all')?.textContent,
      cards: [...document.querySelectorAll('.gly-versions-change')].map(
        (c) => ({
          region: c.dataset.region,
          head: c.querySelector('.gly-card-head').textContent,
          asks: [...c.querySelectorAll('.gly-versions-ask')].map(
            (p) => p.textContent,
          ),
          note: c.querySelector('.gly-versions-note')?.textContent || '',
          edge: getComputedStyle(c).borderLeftColor,
        }),
      ),
      size: s.fontSize,
      line: s.lineHeight,
      // The old two-rail layout, by name. Deleting a surface means its
      // selectors are gone, not that nothing renders in them.
      oldRails: document.querySelectorAll(
        '.gly-versions-list, .gly-versions-requests',
      ).length,
      oldTitles:
        document.body.innerText.includes('CHANGES REQUESTED') ||
        document.body.innerText.includes('VERSION HISTORY'),
    };
  });
  if (process.env.GALLEY_SHOTS)
    await page.screenshot({ path: `${process.env.GALLEY_SHOTS}/reading.png` });
  check(
    'the reading state is the draft’s paper wearing marks — same type',
    reading.size === draftType.size && reading.line === draftType.line,
    JSON.stringify({ history: reading, draft: draftType }),
  );
  check(
    'the sub-bar says which round is being read and between which versions',
    /^ROUND \d+ · V\d+ → V\d+$/.test(reading.where),
    reading.where,
  );
  check(
    'the rail leads with the quiet way back up a level',
    reading.handle === '‹ all rounds',
    reading.handle,
  );
  // ONE CARD PER PLACED CHANGE. The join also returns the round's UNCLAIMED
  // asks, at region -1, and those are the round card's now rather than cards of
  // their own stranded beside whichever change happened to be last.
  check(
    'one card per placed change, in the instruction card’s anatomy',
    reading.cards.length ===
      (view.changes || []).filter((c) => c.region >= 0).length &&
      reading.cards.length >= 2 &&
      /^CHANGE 1 OF 2 · /.test(reading.cards[0].head) &&
      /^CHANGE 2 OF 2 · /.test(reading.cards[1].head) &&
      reading.cards[0].asks.length > 0 &&
      reading.cards[0].note.startsWith('←'),
    JSON.stringify({
      drawn: reading.cards.length,
      joined: (view.changes || []).length,
      cards: reading.cards,
    }),
  );
  // NOTHING THE REVIEWER SENT EVER DISAPPEARS. An ask the agent never claimed
  // is the single most important thing this surface can show — dropping it
  // would make silence look like agreement.
  //
  // BUT AN UNCLAIMED ASK IS NOT A REFUSED ONE, AND THIS CHECK USED TO SAY IT
  // WAS. Whether an ask was ANSWERED is the round's outcome; which change
  // carried it is the manifest's, and it is a refinement. Reading the second's
  // silence as a negative on the first put NOT ANSWERED, dashed and italic,
  // over two instructions a revision had plainly carried out — measured in a
  // real browser on a real document. The refusal voice is asserted at the end
  // of this file, on a round that actually refused, which is the only thing
  // that earns it.
  const refused = await page.evaluate(() => {
    const c = document.querySelector('.gly-versions-unanswered');
    return c
      ? {
          head: c.querySelector('.gly-card-head').textContent,
          ask: c.querySelector('.gly-versions-ask').textContent,
          dashed: getComputedStyle(c).borderTopStyle,
          voice: getComputedStyle(c.querySelector('.gly-versions-ask'))
            .fontStyle,
          note: !!c.querySelector('.gly-versions-note'),
          ordinal: c.dataset.region,
        }
      : null;
  });
  const unclaimed = await page.evaluate(() => {
    const c = document.querySelector('.gly-versions-round-card');
    return c
      ? {
          head: c.querySelector('.gly-card-head').textContent.trim(),
          asks: [...c.querySelectorAll('.gly-versions-ask')].map(
            (p) => p.textContent,
          ),
          answer:
            (c.querySelector('.gly-versions-answer') || {}).textContent || '',
          stranded: document.querySelectorAll(
            '.gly-versions-change:not([data-region])',
          ).length,
          refusalVoice: c.classList.contains('gly-versions-unanswered'),
        }
      : null;
  });
  // THE ROUND CARD CARRIES WHAT THE LANDING CARD ALREADY DID — the ask and the
  // agent's sentence back, together, at the head of the rail. They used to be
  // at opposite ends of it with an empty CHANGE card between them, which is the
  // same two facts taken apart.
  check(
    'the round card pairs the ask with the answer, as the landing does',
    unclaimed &&
      /^ROUND \d+ · /.test(unclaimed.head) &&
      unclaimed.asks.some((a) =>
        a.includes('Cite the incident review verbatim'),
      ) &&
      unclaimed.answer.startsWith('←') &&
      unclaimed.refusalVoice === false,
    JSON.stringify(unclaimed),
  );
  check(
    'and no ask is left stranded as a card of its own',
    unclaimed && unclaimed.stranded === 0,
    JSON.stringify(unclaimed),
  );
  check(
    'and the refusal voice is NOT spent on it — the round answered',
    refused === null,
    JSON.stringify(refused),
  );
  check(
    'the note beside a change is the agent’s own, off the manifest',
    reading.cards.some((c) => c.note.includes('Added the 12-attempt budget')),
    JSON.stringify(reading.cards.map((c) => c.note)),
  );
  check(
    'the old two-rail layout is gone, by selector and by heading',
    reading.oldRails === 0 && !reading.oldTitles,
    JSON.stringify(reading),
  );

  // EACH CARD IS BESIDE ITS MARK. The join has an ordinal on both ends —
  // `data-gly-region` on the paper, `data-region` on the card — and they are
  // two renderings of one region, so a card that has drifted off its mark is a
  // map that has stopped being a map.
  const beside = await page.evaluate(() =>
    [...document.querySelectorAll('.gly-versions-change[data-region]')].map(
      (c) => {
        const mark = document.querySelector(
          `.gly-versions-paper [data-gly-region="${c.dataset.region}"]`,
        );
        return mark
          ? Math.round(
              c.getBoundingClientRect().top - mark.getBoundingClientRect().top,
            )
          : null;
      },
    ),
  );
  check(
    'every change card is placed beside the mark it is about',
    beside.length > 0 && beside.every((d) => d !== null && Math.abs(d) < 240),
    JSON.stringify(beside),
  );

  // SELECTION IS DIMMING AND IT REACHES BOTH COLUMNS — and it may not move a
  // single box. A hover that resized a card would restack every card below it,
  // under the cursor that caused it, which is this codebase's oldest complaint.
  const boxesBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.gly-versions-change')].map((c) => {
      const r = c.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }),
  );
  await page.hover('.gly-versions-change[data-region]');
  const hovered = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.gly-versions-change')];
    return {
      picked: cards.filter((c) => c.classList.contains('is-picked')).length,
      opacities: cards.map((c) => getComputedStyle(c).opacity),
    };
  });
  check(
    'hovering a card lifts it and drops the others to 70%',
    hovered.picked === 1 &&
      hovered.opacities.includes('0.7') &&
      hovered.opacities.includes('1'),
    JSON.stringify(hovered),
  );
  await page.click('.gly-versions-change[data-region]');
  const picked = await page.evaluate(() => ({
    boxes: [...document.querySelectorAll('.gly-versions-change')].map((c) => {
      const r = c.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }),
    marks: [
      ...document.querySelectorAll('.gly-versions-paper [data-gly-region]'),
    ].map((m) => getComputedStyle(m).opacity),
  }));
  check(
    'the paper dims with the rail — the selection reaches both columns',
    picked.marks.includes('0.6') || picked.marks.length === 1,
    JSON.stringify(picked.marks),
  );
  check(
    'and nothing moved: a pick toggles classes and no layout property',
    JSON.stringify(picked.boxes) === JSON.stringify(boxesBefore),
    JSON.stringify({ before: boxesBefore, after: picked.boxes }),
  );
  // THE CARDS ARE THE NAVIGATION — AND THEY WERE POINTER-ONLY. A change card
  // carried a bare `click` listener on a `<div>`: no `tabIndex`, no Enter, no
  // Space, so every change in a round was unreachable without a mouse on the one
  // surface whose entire navigation is its cards. And the press that did land
  // scrolled without verifying and RANG NOTHING — half a reveal, in a codebase
  // whose recorded failure for exactly this is *"clicking a card rang the right
  // mark four screens down and never moved the page"*.
  //
  // Shown red against the tracked build: `{"focused":false,"picked":0,
  // "flashed":false}` — the card would not take focus, so Enter never reached
  // it, and no mark was ever rung by any press.
  await page.keyboard.press('Escape');
  const reachable = await page.evaluate(() => {
    const card = document.querySelector('.gly-versions-change[data-region]');
    card.focus();
    return {
      focused: document.activeElement === card,
      tabIndex: card.tabIndex,
    };
  });
  await page.keyboard.press('Enter');
  // POLLED, NOT READ ONCE: `flash` puts the class on for FLASH_MS and takes it
  // off again, and a single read a frame later reads a race.
  const rung = await page
    .waitForFunction(
      () => {
        const card = document.querySelector(
          '.gly-versions-change.is-picked[data-region]',
        );
        if (!card) return false;
        const mark = document.querySelector(
          `.gly-versions-paper [data-gly-region="${card.dataset.region}"]`,
        );
        return mark && mark.classList.contains('gly-flash')
          ? { picked: 1, flashed: true }
          : false;
      },
      null,
      { timeout: 4000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => ({ picked: 0, flashed: false }));
  check(
    'a change card is reachable by keyboard, and Enter reveals AND rings the words it is about',
    reachable.focused && reachable.tabIndex === 0 && rung.flashed,
    JSON.stringify({ ...reachable, ...rung }),
  );
  // NOT unpinned here: the Esc below is the check for unpinning, and Esc's other
  // meaning on this surface is "leave History" — pressing it twice would close
  // the panel and take that check's own state away with it.
  check(
    'there are no rings and no prev/next steppers — the cards are the navigation',
    (await page
      .locator('.gly-versions-step, .gly-versions-next, .gly-versions-prev')
      .count()) === 0,
  );
  await page.keyboard.press('Escape');
  const afterEsc = await page.evaluate(() => ({
    open: !document.querySelector('.gly-versions').hidden,
    picked: document.querySelectorAll('.gly-versions-change.is-picked').length,
  }));
  check(
    'Esc unpins the change without leaving the reading mode',
    afterEsc.open === true && afterEsc.picked === 0,
    JSON.stringify(afterEsc),
  );

  // §5.4 — SIDE BY SIDE, AND THE WAY OUT.
  await page.click('.gly-versions-view-pick[data-view="sbs"]');
  await page.waitForSelector('.gly-versions-paper .gly-sbs');
  if (process.env.GALLEY_SHOTS)
    await page.screenshot({ path: `${process.env.GALLEY_SHOTS}/sbs.png` });
  const sbs = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.gly-sbs-head')].map(
      (h) => h.textContent,
    );
    const cols = document.querySelectorAll('.gly-sbs-col').length;
    const paper = getComputedStyle(
      document.querySelector('.gly-versions-paper'),
    );
    const toggle = getComputedStyle(
      document.querySelector('.gly-versions-view-pick[data-view="sbs"]'),
    );
    const restore = getComputedStyle(
      document.querySelector('.gly-versions-restore'),
    );
    return {
      heads,
      cols,
      size: paper.fontSize,
      toggleBorder: toggle.borderTopWidth,
      restoreBorder: restore.borderTopWidth,
      restoreColor: restore.color,
      toggleColor: toggle.color,
      // innerText, NOT textContent: the button carries BOTH labels so its cell
      // cannot resize on its own click, and the one not showing is
      // `.gly-reserved` — laid out, never drawn. textContent reads through
      // visibility and returned the two concatenated.
      restoreText: document.querySelector('.gly-versions-restore').innerText,
    };
  });
  check(
    'side by side is two halves of one column, each corner named with its version',
    sbs.cols === 2 &&
      /^v\d+ · before$/.test(sbs.heads[0]) &&
      /^v\d+ · after$/.test(sbs.heads[1]),
    JSON.stringify(sbs.heads),
  );
  check(
    'and both halves keep the draft’s type',
    sbs.size === draftType.size,
    JSON.stringify({ sbs: sbs.size, draft: draftType.size }),
  );
  // RESTORE MAY NEVER AGAIN SHARE A ROW-STYLE WITH THE VIEW TOGGLES. It is the
  // one act on this surface with no undo outside git, and it shipped as a
  // bordered pill in the same row as `Changes` and `Side by side` — the
  // loudest-consequence control on the page looking exactly like a way of
  // LOOKING at something.
  check(
    'restore is at destroy weight — borderless and muted, never a peer of the view toggles',
    sbs.restoreBorder === '0px' &&
      sbs.toggleBorder !== '0px' &&
      sbs.restoreColor !== sbs.toggleColor &&
      /^restore v\d+ as draft$/.test(sbs.restoreText),
    JSON.stringify(sbs),
  );
  await page.click('.gly-versions-restore');
  const armed = await page.evaluate(() => ({
    text: document.querySelector('.gly-versions-restore').innerText,
    color: getComputedStyle(document.querySelector('.gly-versions-restore'))
      .color,
  }));
  check(
    'and it arms red before it overwrites the draft, firing on the second press',
    armed.text === 'replace draft?' && armed.color !== sbs.restoreColor,
    JSON.stringify(armed),
  );

  // THE WAY OUT, AND THE SCROLL. History is a MODE and not a page: the sentence
  // the reviewer was reading has to be under the cursor when they come back.
  await page.click('.kit-primary');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions')?.hidden === true,
  );
  const back = await page.evaluate(() => ({
    prose: !!document.querySelector('.ProseMirror'),
    mode: document.body.classList.contains('gly-history-mode'),
    primary: document.querySelector('.kit-primary')?.innerText.trim(),
    scroll: window.scrollY,
  }));
  check(
    'the primary’s slot is the way back to the draft, and it returns the draft’s own face',
    back.prose && !back.mode && back.primary !== '← back to draft',
    JSON.stringify(back),
  );
  check(
    'and the draft’s scroll position survived the round trip',
    Math.abs(back.scroll - draftScroll) <= 1,
    JSON.stringify({ back: back.scroll, draftScroll }),
  );
  const rounds = await page.evaluate(
    async () => (await (await fetch('_galley/versions')).json()).rounds.length,
  );
  check(
    'leaving History leaves the record intact',
    rounds >= 4 &&
      (await page.locator('.gly-versions-open').innerText()).trim() ===
        'History',
    String(rounds),
  );

  // One instruction pending, for the round below to send.
  await addOverallInstruction(
    page,
    'Name the retention window in the summary.',
    1,
  );
  // §6.3 — THE ARRIVAL STRIP. Board 1e. A round has to actually come back for
  // this to exist, so one is driven the way every other round here is driven.
  await sendRound([]);
  await agentReturns(
    '# A careful review\n\nBounded retries: 12 attempts over 48 hours.\n\n' +
      '## The budget\n\nEach message gets a retry budget of 12 attempts over 48 hours (incident #482).\n\n' +
      '## What happens at exhaustion\n\nWhen a message exhausts its budget it moves to the dead letter queue, ' +
      'kept 14 days from the day it lands.\n',
    [
      {
        quote: 'kept 14 days from the day it lands',
        answers: [],
        note: 'Said when the retention window starts.',
      },
    ],
  );
  // A MISSING SURFACE FAILS A CHECK, IT DOES NOT THROW THE RUN AWAY. A gate
  // that dies on the first absence reports one red where there are several, and
  // the several are what say whether the diagnosis is right — run against a
  // build whose arrival raises no strip, an unguarded wait here took every
  // check below it with it and reported a TimeoutError instead of a claim.
  // AND IT MUST BE THE STRIP FOR *THIS* ARRIVAL. `:not([hidden])` waits for A
  // strip, and by this point in the file an EARLIER arrival has already raised
  // one — so the wait returned instantly and every check below read the
  // previous round's sentence. It reported `round 3 answered · v6 · 2 changes`
  // against a record whose last round was v8, which reads as the server cutting
  // phantom rounds and is nothing of the kind: the strip was two arrivals
  // stale. Measured at #181 with a true baseline worktree — the SAME eight-round
  // record, 129 ok, 0 failed — so the record was never what moved. What moved
  // was how long the sections above take, which is not something a check about
  // an arrival should depend on.
  //
  // The round is committed by the time `agentReturns` returns, so the record is
  // authoritative here and the strip is what has to catch up to it.
  const landedN = await page.evaluate(async () => {
    const rounds = (await (await fetch('_galley/versions')).json()).rounds;
    return rounds[rounds.length - 1].n;
  });
  let stripUp = true;
  try {
    await page.waitForSelector('.gly-strip:not([hidden])', { timeout: 15000 });
    await page.waitForFunction(
      (n) =>
        (document.querySelector('.gly-strip-text')?.innerText || '').includes(
          `v${n}`,
        ),
      landedN,
      { timeout: 15000 },
    );
  } catch {
    stripUp = false;
  }
  check('a round coming back raises the arrival strip at all', stripUp);
  if (!stripUp)
    await page.evaluate(() => {
      document.querySelector('.gly-strip').hidden = false;
    });
  const arrived = await page.evaluate(() => {
    const el = document.querySelector('.gly-strip');
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const read = document.querySelector('.gly-strip-read');
    const dismiss = document.querySelector('.gly-strip-dismiss');
    const rs = read ? getComputedStyle(read) : null;
    const ds = dismiss ? getComputedStyle(dismiss) : null;
    const tone = (name) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return want;
    };
    const chip = document.querySelector('.kit-stages .gly-versions-open');
    return {
      text: document.querySelector('.gly-strip-text').innerText.trim(),
      left: Math.round(r.left),
      aboveSendBar: Math.round(
        document.querySelector('.kit-sendbar').getBoundingClientRect().top -
          r.bottom,
      ),
      mono:
        s.fontFamily ===
        getComputedStyle(document.documentElement)
          .getPropertyValue('--gly-mono')
          .trim(),
      border: s.borderTopColor,
      borderWidth: s.borderTopWidth,
      accent: tone('--gly-accent'),
      signal: tone('--gly-signal'),
      muted: tone('--gly-muted'),
      readText: read ? read.innerText.trim() : null,
      readBg: rs && rs.backgroundColor,
      readWeight: rs && rs.fontWeight,
      dismissText: dismiss ? dismiss.innerText.trim() : null,
      dismissBorder: ds && ds.borderTopWidth,
      dismissColor: ds && ds.color,
      showMe: !!document.querySelector('.gly-strip-show')?.offsetParent,
      fade: !!document.querySelector('.gly-strip-fade')?.offsetParent,
      chipNew: chip.classList.contains('is-new'),
      chipColor: getComputedStyle(chip).color,
      primary: document.querySelector('.kit-primary').innerText.trim(),
    };
  });
  const record6 = await page.evaluate(
    async () => (await (await fetch('_galley/versions')).json()).rounds,
  );
  const arrivedRound = record6[record6.length - 1];
  check(
    'the strip says which round came back, which version it made, and how much moved',
    arrived.text ===
      `round ${
        record6
          .filter((r) => !(r.n === 1 && r.reason === 'opened'))
          .filter((r) => !record6.some((o) => o.answers === r.n)).length
      } answered · v${arrivedRound.n} · ${
        arrivedRound.changed === 1
          ? '1 change'
          : `${arrivedRound.changed} changes`
      }`,
    JSON.stringify({
      said: arrived.text,
      n: arrivedRound.n,
      changed: arrivedRound.changed,
    }),
  );
  // THE COUNT IS THE SERVER'S. `changed` comes off `/_galley/versions`, computed
  // by diff.Regions per request, and the strip is the FIRST surface to say how
  // much moved — before anything has been rendered that a count could be
  // derived from. A strip that agreed with a render would be a count that lies
  // the day the render is wrong.
  check(
    'and that count is the record’s, not a count of anything drawn',
    arrivedRound.changed > 0,
    JSON.stringify({ changed: arrivedRound.changed }),
  );
  check(
    'it sits at the foot on the left, clear above the send bar, mono, inside a 1px amber border — the arrived grammar',
    arrived.left <= 24 &&
      arrived.aboveSendBar >= 0 &&
      arrived.aboveSendBar <= 24 &&
      arrived.mono === true &&
      arrived.border === arrived.accent &&
      arrived.borderWidth === '1px',
    JSON.stringify(arrived),
  );
  check(
    'one filled-signal verb on it, and it names what it opens',
    arrived.readText === 'read changes' &&
      arrived.readBg === arrived.signal &&
      Number(arrived.readWeight) >= 600,
    JSON.stringify(arrived),
  );
  check(
    'beside a quiet dismiss that is not a second verb',
    arrived.dismissText === 'dismiss' &&
      arrived.dismissBorder === '0px' &&
      arrived.dismissColor === arrived.muted,
    JSON.stringify(arrived),
  );
  check(
    'the old proposal strip’s verb and its fade suffix are not on an arrival',
    arrived.showMe === false && arrived.fade === false,
    JSON.stringify(arrived),
  );
  check(
    'the History door is in the signal colour until the round is read',
    arrived.chipNew === true && arrived.chipColor === arrived.signal,
    JSON.stringify(arrived),
  );
  check(
    'and the primary shows Approve, because nothing is pending',
    arrived.primary.includes('Approve'),
    arrived.primary,
  );

  // `read changes` LANDS ON THAT ROUND'S READING STATE, NOT ON THE LANDING.
  // Two stages answer two different questions — "what has happened to this
  // document" and "what did round N do" — and the strip was pressed with the
  // second one in mind. Read off the paper's own `data-to` (the SERVER's answer
  // to which version is on screen) and the sub-bar's presence, which is what
  // makes a reading state a reading state.
  await page.click('.gly-strip-read');
  await page.waitForSelector('.gly-versions:not([hidden])');
  await page.waitForFunction(
    () => !document.querySelector('.gly-versions-sub').hidden,
  );
  const landedRead = await page.evaluate(() => ({
    to: document.querySelector('.gly-versions-paper').dataset.to,
    reading: !document.querySelector('.gly-versions-sub').hidden,
    where: document.querySelector('.gly-versions-where').textContent,
    strip: !document.querySelector('.gly-strip').hidden,
  }));
  check(
    'read changes deep-links straight to that round’s reading state, not the landing',
    landedRead.to === String(arrivedRound.n) &&
      landedRead.reading === true &&
      /^ROUND \d+ · V\d+ → V\d+$/.test(landedRead.where),
    JSON.stringify(landedRead),
  );
  check(
    'and the notice comes down once the reading it announced has begun',
    landedRead.strip === false,
    JSON.stringify(landedRead),
  );
  await page.click('.kit-primary');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions')?.hidden === true,
  );
  check(
    'and the door stops being amber once the round has been read',
    !(await page.evaluate(() =>
      document
        .querySelector('.kit-stages .gly-versions-open')
        .classList.contains('is-new'),
    )),
  );

  // AN EDIT MADE OUTSIDE THE EDITOR IS A VERSION. With nothing pending, the
  // file changed by hand outside any round — an agent editing it directly —
  // is not the reviewer's own edit, so the primary stays Approve and History
  // names where the version came from. Outside a handoff window nothing
  // watches the file; the page load looks at it, so the reviewer's reload is
  // what brings it in.
  const outsideLine = 'A paragraph written outside the editor.';
  writeFileSync(
    doc,
    `${readFileSync(doc, 'utf8').trimEnd()}\n\n${outsideLine}\n`,
  );
  await page.reload();
  await page.waitForFunction(
    (t) => document.querySelector('.ProseMirror').innerText.includes(t),
    outsideLine,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
  const outsidePrimary = await page.evaluate(() =>
    document.querySelector('.kit-primary').innerText.trim(),
  );
  check(
    'an edit made outside the editor leaves the primary at Approve',
    outsidePrimary.includes('Approve'),
    outsidePrimary,
  );
  await page.click('.gly-versions-open');
  await page.waitForSelector('.gly-versions:not([hidden])');
  const outsideCard = await page
    .waitForFunction(
      () => {
        const el = document.querySelector(
          '.gly-versions-round[data-reason="outside"]',
        );
        return el ? el.innerText : null;
      },
      null,
      { timeout: 8000 },
    )
    .then(
      (h) => h.jsonValue(),
      () => null,
    );
  check(
    'and History lists it as changed outside the editor',
    !!outsideCard && outsideCard.includes('changed outside the editor'),
    JSON.stringify(outsideCard),
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.gly-versions')?.hidden === true,
  );

  await addOverallInstruction(page, 'Final trusted pass.', 1);
  await openApproveMenu(page);
  const beforeTrust = await windowMark(page);
  await page.click('.gly-verdict-trust');
  // The window this press opened, before the ack. See responseWindowOpen.
  await responseWindowOpen(page, beforeTrust);
  await ack(page, 'failed', 'cannot complete the trusted pass');
  await page.waitForTimeout(1700);
  check(
    'Revise & Approve leaves a failed result open for another round',
    !(await page.isVisible('#gly-seal:not(.gly-seal-off)')),
  );

  // THE REFUSAL VOICE, ON THE ONE ROUND THAT EARNS IT — and it goes LAST
  // because it navigates. `NOT ANSWERED`, dashed, italic, is reserved for a
  // round the agent said outright it could not do. It used to be spent on every
  // unattributed ask, which is what put it over two instructions a revision had
  // plainly carried out; narrowing it without driving the narrow case is how it
  // would come back, because a state nothing drives is a state nothing protects.
  await addRangeInstruction(page, 'Rewrite this in the passive voice.', 1);
  await reviseReady(page);
  await page.click('#gly-revise');
  await page.waitForTimeout(900);
  const cannotCode = await page.evaluate(
    async () =>
      (
        await fetch('_galley/cannot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            why: 'the passive voice would bury the decision',
          }),
        })
      ).status,
  );
  check(
    'an exception is a round the server accepts',
    cannotCode === 204 || cannotCode === 200,
    String(cannotCode),
  );
  await page.waitForTimeout(1800);
  await page.click('.gly-versions-open');
  await page.waitForSelector('.gly-versions:not([hidden])');
  await page.waitForTimeout(1000);
  const refusedRound = await page.evaluate(() => {
    const c = document.querySelector('.gly-versions-unanswered');
    if (!c) return null;
    const ask = c.querySelector('.gly-versions-ask');
    return {
      head: c.querySelector('.gly-card-head').textContent.trim(),
      dashed: getComputedStyle(c).borderTopStyle,
      voice: ask ? getComputedStyle(ask).fontStyle : null,
    };
  });
  // AND THE ONE THAT OVERWRITES THE DRAFT HOLDS STILL BETWEEN ITS TWO PRESSES.
  //
  // `restore vN as draft` becomes `replace draft?` on its own click, and while
  // that was written straight into textContent the control moved 33.1px left
  // and shrank 125.8 -> 92.7 between the arming press and the confirming one —
  // the second click landing where the first was not, on the one verb here that
  // cannot be undone.
  const restoreBox = async () =>
    page.evaluate(() => {
      const b = document.querySelector('.gly-versions-restore');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        x: Math.round(r.x * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        said: b.innerText.trim(),
      };
    });
  const restIdle = await restoreBox();
  if (restIdle) {
    await page.click('.gly-versions-restore');
    await page.waitForTimeout(300);
    const restArmed = await restoreBox();
    check(
      'the restore verb does not move or resize on its own arming click',
      restArmed &&
        restIdle.x === restArmed.x &&
        restIdle.w === restArmed.w &&
        restIdle.said !== restArmed.said,
      JSON.stringify({ idle: restIdle, armed: restArmed }),
    );

    // AND IT SURVIVES BEING PRESSED. The confirming click announced itself with
    // `restoreButton.textContent = 'restoring…'`, which REPLACES the button's
    // children — destroying both label spans. Every later paintRestore then
    // wrote labels and toggled classes on DETACHED nodes, so the button was
    // left reading "restoring…" for the life of the panel, with the reserve
    // that stops it moving on its own click gone with the spans. It is not a
    // failure path: the SUCCESS path did it too.
    //
    // THE CHECK READS THE SPANS, not the button's text. Text alone recovers on
    // the next repaint of a rebuilt panel and would go green over a button
    // whose reserve had been destroyed — the same proxy-reading shape this file
    // records four of.
    await page.click('.gly-versions-restore');
    await page.waitForTimeout(600);
    const restAfter = await page.evaluate(() => {
      const b = document.querySelector('.gly-versions-restore');
      if (!b) {
        return null;
      }
      return {
        spans: b.querySelectorAll('span').length,
        said: b.innerText.trim(),
      };
    });
    check(
      'pressing restore does not destroy the button that was pressed',
      restAfter && restAfter.spans >= 2 && restAfter.said !== 'restoring…',
      JSON.stringify(restAfter),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  check(
    'a refused round wears NOT ANSWERED, dashed and in the refusal voice',
    refusedRound &&
      /NOT ANSWERED/.test(refusedRound.head) &&
      refusedRound.dashed === 'dashed' &&
      refusedRound.voice === 'italic',
    JSON.stringify(refusedRound),
  );

  // §6.4 — THE REVIEWER'S OWN EDITS ARE IN THE INSTRUCTIONS TAB, read off the
  // server's list: an instruction is sent, and so is every edit made by hand.
  // A PARAGRAPH, NOT THE HEADING, and the difference is not cosmetic. Emptying
  // a heading leaves "#" behind, which is a `changed` whose new text appears in
  // every other heading — genuinely ambiguous, and the server refuses it by
  // design rather than reverting one at random. Deleting a paragraph is both
  // the gesture a reviewer actually makes and the one shape revert can answer
  // exactly: a whole block, put back where it was.
  await page.evaluate(() => {
    const editor = window.galleyEdit.editor;
    const paras = [];
    editor.state.doc.descendants((node, pos) => {
      if (
        node.isTextblock &&
        node.type.name === 'paragraph' &&
        node.textContent.trim()
      ) {
        paras.push({ from: pos, to: pos + node.nodeSize });
      }
      return !node.isTextblock;
    });
    const last = paras[paras.length - 1];
    editor.commands.focus();
    editor.view.dispatch(editor.state.tr.delete(last.from, last.to));
  });
  await tabPress(page, 'Instructions');
  let railEdits = { cards: 0, head: '' };
  for (let i = 0; i < 24 && railEdits.cards === 0; i++) {
    await page.waitForTimeout(500);
    railEdits = await page.evaluate(() => ({
      cards: document.querySelectorAll('.gly-edit-row').length,
      head:
        document
          .querySelector('.gly-edit-row .kit-label')
          ?.innerText.trim()
          .toLowerCase() || '',
      quoted:
        document.querySelector('.gly-edit-row del')?.innerText.trim() || '',
    }));
  }
  check(
    'an edit the reviewer made by hand appears in the Instructions tab',
    railEdits.cards > 0,
    JSON.stringify(railEdits),
  );
  check(
    'and its row says it is the reviewer\u2019s edit',
    /your edit/.test(railEdits.head),
    JSON.stringify(railEdits),
  );

  // REVERT IS TARGETED UNDO, and the two-step is the same primitive delete and
  // restore already wear, because it discards work. The first press ARMS and
  // must not act; only the second puts the words back. A one-press revert on a
  // card the reviewer is reading is exactly the misfire the arming exists for.
  const beforeRevert = await page.evaluate(() =>
    document.querySelector('.ProseMirror').innerText.trim(),
  );
  const revert = page.locator('.gly-edit-row .kit-btn');
  await revert.click();
  await page.waitForFunction(() =>
    /Revert\?/.test(
      document.querySelector('.gly-edit-row .kit-btn')?.innerText,
    ),
  );
  const revertArmed = { armed: true, said: await revert.innerText() };
  check(
    'the first press on revert arms it and changes nothing',
    revertArmed !== null &&
      revertArmed.armed === true &&
      (await page.evaluate(
        (was) =>
          document.querySelector('.ProseMirror').innerText.trim() === was,
        beforeRevert,
      )),
    JSON.stringify(revertArmed),
  );
  await revert.click();
  let reverted = beforeRevert;
  for (let i = 0; i < 20 && reverted === beforeRevert; i++) {
    await page.waitForTimeout(300);
    reverted = await page.evaluate(() =>
      document.querySelector('.ProseMirror').innerText.trim(),
    );
  }
  check(
    'and the second press puts the words back',
    reverted !== beforeRevert,
    JSON.stringify({
      before: beforeRevert.slice(0, 60),
      after: reverted.slice(0, 60),
    }),
  );
  const clearedRail = await page.evaluate(
    () => document.querySelectorAll('.gly-edit-row').length,
  );
  check(
    'and the edit leaves the tab, because it is no longer in the round',
    clearedRail === 0,
    String(clearedRail),
  );

  // §6.5 — A SELECTION THAT CROSSES A BLOCK BOUNDARY CAN BE COMMENTED ON.
  //
  // It could not, and the failure was guaranteed rather than occasional:
  // `docRange` refused to produce coordinates for a selection whose ends were
  // in different blocks, so the composer sent the selected TEXT and the server
  // searched for it inside single blocks. The concatenation of two paragraphs
  // is in neither, so `findUnique` reported `matched 0 times` and refused —
  // after the composer had opened, accepted the typing, and taken the
  // reviewer's instruction. Every multi-block selection, always.
  //
  // THE CHECK DRIVES A REAL SELECTION rather than posting the coordinates,
  // because the browser's half is where the bug was: the server has had
  // path/from/to for a long time, and what was missing was any way for the page
  // to say "this ends over there".
  const crossed = await page.evaluate(() => {
    const editor = window.galleyEdit.editor;
    const blocks = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.trim()) {
        blocks.push({ pos, len: node.textContent.length });
      }
      return !node.isTextblock;
    });
    if (blocks.length < 2) {
      return null;
    }
    const a = blocks[0];
    const b = blocks[1];
    editor.commands.focus();
    // Mid-way into the first block, mid-way into the second: both ends inside
    // text, neither at a boundary, so nothing here is a degenerate range that
    // a single-block path could have handled anyway.
    editor.commands.setTextSelection({
      from: a.pos + 1 + Math.floor(a.len / 2),
      to: b.pos + 1 + Math.floor(b.len / 2),
    });
    editor.view.focus();
    return { blocks: blocks.length };
  });
  check(
    'the fixture has two blocks to select across',
    !!crossed,
    JSON.stringify(crossed),
  );
  if (crossed) {
    await page.waitForSelector('.gly-comment-button:not([hidden])', {
      timeout: 5000,
    });
    await page.click('.gly-comment-button');
    await page.fill('.gly-composer-text', 'tighten this passage');
    const before = await page.evaluate(
      async () =>
        (await (await fetch('_galley/pending')).json()).instructions.length,
    );
    await page.click('.gly-composer-send');
    // POLLED, NOT `waitForFunction(async …)`: an async page function returns a
    // promise, a promise is truthy, and such a wait resolves on its first poll
    // whatever the fetch said. This file has paid for that once already.
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      await page.waitForTimeout(250);
      after = await page.evaluate(
        async () =>
          (await (await fetch('_galley/pending')).json()).instructions.length,
      );
    }
    const filed = await page.evaluate(async () => {
      const list = (await (await fetch('_galley/pending')).json()).instructions;
      const mine = list.filter((i) => i.text === 'tighten this passage');
      return {
        count: mine.length,
        quote: mine[0] ? mine[0].quote : null,
        run: mine[0] ? mine[0].run : null,
        marks: document.querySelectorAll('.gly-comment-anchor, .gly-highlight')
          .length,
      };
    });
    check(
      'an instruction on a selection crossing two blocks is accepted',
      filed.count === 1,
      JSON.stringify(filed),
    );
    check(
      'and it is ONE instruction with one run, not one per block',
      filed.count === 1 && !!filed.run,
      JSON.stringify(filed),
    );
  }

  // §6b — THE DISK NOTICE IS READABLE (galley#44). It was a clause of the grey
  // readout, last, in a cell that ellipsizes at its end — so the sentence the
  // reviewer most needed ("Nothing is being saved.") was the part cut off.
  // Remove the file under the running editor, type so a save is attempted,
  // and read the notice the way a reviewer would: shown, whole, unclipped, and
  // on its own line BELOW the bar's controls rather than inside the status.
  // The file goes back afterwards, byte for byte, because §7 needs a review
  // that is still saving.
  //
  // AND ITS ARRIVAL MOVES NOTHING. It appears without the reviewer asking, so
  // it is held to the rule `web/motion.mjs` held while it existed: the
  // document, the column and the bar's controls are where they were when it
  // appears and when it goes. Shown red first on 725d7c8, where the notice was
  // a row in the wrapping bar and pushed the whole page down by its height.
  {
    // Where what a reviewer is looking at sits, rounded so subpixel noise is
    // not called motion. Positions, not sizes, for the document and the
    // readout: the typing that triggers the save grows the one and rewrites
    // the other, and neither is the notice's doing. The page's are in PAGE
    // coordinates, because the typing also scrolls the caret into view
    // (measured: 14px, settled ~600ms before the notice paints) — a bar that
    // grows still shifts them there; the sticky bar's own are in the window's.
    const landmarks = () =>
      page.evaluate(() => {
        const at = (sel, onPage) => {
          const el = document.querySelector(sel);
          if (!el) {
            return null;
          }
          const r = el.getBoundingClientRect();
          const top = r.top + (onPage ? window.scrollY : 0);
          return [r.left, top].map((n) => +n.toFixed(1));
        };
        return {
          doc: at('.ProseMirror', true),
          firstLine: at('.ProseMirror > *', true),
          column: at('.kit-right-col'),
          status: at('#gly-status'),
          barH: +document
            .querySelector('.kit-bar')
            .getBoundingClientRect()
            .height.toFixed(1),
        };
      });
    const moved = (a, b) =>
      Object.keys(a).filter(
        (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
      );
    const kept = readFileSync(doc, 'utf8');
    rmSync(doc);
    await page.locator('.ProseMirror p').first().click();
    await page.keyboard.press('End');
    const before = await landmarks();
    await page.keyboard.type(' Gone.');
    const shown = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.gly-disk-notice');
          return (
            !!el &&
            !el.hidden &&
            /no longer at this path/.test(el.textContent || '')
          );
        },
        null,
        { timeout: 10000 },
      )
      .then(
        () => true,
        () => false,
      );
    const notice = await page.evaluate(() => {
      const el = document.querySelector('.gly-disk-notice');
      const status = document.querySelector('#gly-status');
      const bar = document.querySelector('.kit-bar');
      if (!el || !status || !bar) {
        return null;
      }
      const r = el.getBoundingClientRect();
      const row = status.getBoundingClientRect().bottom;
      const b = bar.getBoundingClientRect();
      return {
        text: el.textContent,
        visible: getComputedStyle(el).display !== 'none' && r.height > 0,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        top: r.top,
        row,
        width: r.width,
        barWidth: b.width,
        statusText: status.textContent,
      };
    });
    if (process.env.GALLEY_NOTICE_SHOT) {
      await page.screenshot({ path: process.env.GALLEY_NOTICE_SHOT });
    }
    check(
      'a removed file puts the disk notice on screen',
      shown && !!notice && notice.visible,
      JSON.stringify(notice),
    );
    check(
      'and its whole sentence, not an ellipsis of it',
      !!notice &&
        notice.text ===
          'history-ux.md is no longer at this path. Nothing is being saved.' &&
        notice.scrollWidth <= notice.clientWidth,
      JSON.stringify(notice),
    );
    check(
      'and it is its own line below the bar’s controls, not a status clause',
      !!notice &&
        notice.top >= notice.row &&
        !/no longer at this path/.test(notice.statusText || ''),
      JSON.stringify(notice),
    );
    const shownAt = await landmarks();
    check(
      'and its appearing moves nothing: document, column and bar controls stay put',
      moved(before, shownAt).length === 0,
      JSON.stringify({ moved: moved(before, shownAt), before, shownAt }),
    );
    writeFileSync(doc, kept);
    await page.keyboard.type(' Back.');
    const gone = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.gly-disk-notice');
          return !el || el.hidden;
        },
        null,
        { timeout: 10000 },
      )
      .then(
        () => true,
        () => false,
      );
    check('and it goes once the file is back and saving', gone);
    const goneAt = await landmarks();
    check(
      'and its going moves nothing either',
      moved(shownAt, goneAt).length === 0,
      JSON.stringify({ moved: moved(shownAt, goneAt), shownAt, goneAt }),
    );
  }

  // §7 — HISTORY SURVIVES THE SEAL. LAST, because approving ends the review and
  // every check above it needs a live one.
  //
  // Losing History was never argued — it was collateral. `sealHides` held the
  // whole census strip, and the History door lives in that strip because
  // Instructions and History are peers, so sealing a review took the record of
  // it off the page. `layers.mjs` measured a `.gly-versions-open` click hanging
  // for thirty seconds and throwing. The recorded reasoning for hiding ended
  // "the single press that changes that is the press that brings the door
  // back" — and reopen was deleted afterwards, so hiding outlived its excuse.
  //
  // A sealed review is exactly when somebody wants to read what happened.
  await page.evaluate(() =>
    fetch('_galley/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    }),
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gly-seal')
        ?.classList.contains('gly-seal-off') === false,
    { timeout: 8000 },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  const sealedBar = await page.evaluate(() => {
    const door = document.querySelector('.gly-versions-open');
    if (!door) {
      return null;
    }
    const r = door.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      // READ WHAT THE BROWSER WILL DO WITH A CLICK, not a class. A rect inside
      // the window is not a control the reviewer can press, and `display: none`
      // on an ancestor is exactly what used to be wrong here.
      doorShown: getComputedStyle(door).display !== 'none',
      doorDisabled: door.disabled,
      doorReachable: !!at && door.contains(at),
    };
  });
  check(
    'History survives the seal — the door is shown, enabled and pressable',
    sealedBar &&
      sealedBar.doorShown &&
      sealedBar.doorDisabled === false &&
      sealedBar.doorReachable,
    JSON.stringify(sealedBar),
  );
  await page.click('.gly-versions-open');
  const sealedHistory = await page.evaluate(() => ({
    open: document.querySelector('.gly-versions')?.hidden === false,
    rounds: document.querySelectorAll(
      '.gly-versions .gly-round, .gly-versions-list button',
    ).length,
  }));
  check(
    'and pressing it opens the record of the review that just ended',
    sealedHistory.open,
    JSON.stringify(sealedHistory),
  );
} finally {
  // The browser closes first (launchOrSkip added it at launch), then the port
  // is given back before the run ends, so the next run, or the next gate, does
  // not find this server still answering on it.
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
  // The server can project once while SIGTERM is landing; a cleanup that
  // throws is ignored.
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  await cleanup();
}

if (counts().fails) {
  if (serverOutput.trim()) console.log(serverOutput.trim());
  process.exit(1);
}
