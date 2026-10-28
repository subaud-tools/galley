// UNDO SURVIVES A SERVER-SIDE MUTATION. THIS IS THE GATE THAT SAYS SO.
//
// IT WAS A PROBE FOR ONE DAY AND ITS HEADER SAID WHY: the defect was real,
// understood, and deliberately unfixed, and a gate that is permanently red for
// a known design gap trains people to ignore the gate. It also said what would
// change that — "the day targeted mutation lands, this becomes a gate" — and
// that day is this one. It asserts now.
//
// WHAT IT MEASURED WHILE IT WAS A PROBE, on the built binary 2026-08-23:
//
//   control — three edits typed, three undos, nothing filed:
//     back to "Alpha one here."          all three levels recovered
//   test    — same three edits, ONE instruction filed, three undos:
//     "Alpha one here. ONE TWO THREE"    changed at all? false
//
// Court asked "is there only one level of undo?". There was not one — after any
// server-side mutation there were ZERO. Yjs owns undo and the stack was fine;
// it was ORPHANED, because every server-side mutation went through ydoc.Load,
// which deletes the fragment's children and writes them again, so each undo
// entry pointed at items that no longer existed and Cmd-Z was a silent no-op.
// ydoc.Write is the fix: a change that only moves MARKS is formatted in place.
//
// THE CONTROL IS HALF THE GATE AND MUST NOT BE DELETED AS REDUNDANT. Without
// it, "undo did nothing" is equally well explained by a broken keybinding, a
// focus problem, or a harness that never delivered the keystroke — and this
// file would then report the product broken every time playwright changed how
// it sends ⌘Z. The redo between the halves is there for the same reason: it
// proves the stack was still whole at the moment the instruction was filed.
//
// THE PAUSES BETWEEN THE TYPED WORDS ARE LOAD-BEARING. Yjs coalesces edits that
// arrive close together into ONE undo step, so typing three words with no gap
// is one level and the control could not tell one level from three.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  check,
  cleanup,
  counts,
  launchOrSkip,
  onCleanup,
} from './build/probe.mjs';

// THE MODIFIER IS THE PLATFORM'S, and CI is where that stopped being academic.
// `Meta+z` is the macOS chord; on Linux it does nothing at all, so this gate
// went red on GitHub with the CONTROL failing — three undos with nothing filed
// leaving the text exactly as typed. That is the control doing its job: it said
// the harness never delivered the keystroke, rather than letting the product be
// blamed for a shortcut it never received. Playwright's `ControlOrMeta` resolves
// per platform, which is the one spelling that is right in both places.
const UNDO = 'ControlOrMeta+z';
const REDO = 'ControlOrMeta+Shift+z';

const GALLEY = process.env.GALLEY || 'bin/galley';
const PORT = 8291;
const dir = mkdtempSync(join(tmpdir(), 'galley-undo-'));
const doc = join(dir, 'undo-probe.md');
writeFileSync(
  doc,
  '# Undo\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n',
);

// `stdio: 'ignore'` rather than the gates' drain-and-keep-the-tail. This probe
// prints its own measurement and has no assertion whose failure would send a
// reader to the server log — and it is what keeps this file from being a
// seventh copy of that boilerplate. The dupes ratchet caught the first draft
// cloning nine lines of typing.mjs, and a bound is not raised to make a build
// green.
// A STALE SERVER ON THIS PORT IS REFUSED RATHER THAN TALKED TO, and this guard
// is here because the alternative already happened. An earlier run of this file
// crashed before its cleanup, leaving a `galley edit` listening on 8291 with
// its own document — and every run after it bound nothing, connected to that
// server, and measured the WRONG DOCUMENT. It presented as the CRDT scrambling
// text during typing ("ONE TWO THREETHREE ONE"), which sent me looking at the
// write path rather than at the port. A gate that silently measures somebody
// else's document is worse than one that does not run.
const inUse = await new Promise((resolve) => {
  const probe = net.createConnection({ port: PORT, host: '127.0.0.1' });
  probe.on('connect', () => {
    probe.destroy();
    resolve(true);
  });
  probe.on('error', () => resolve(false));
});
if (inUse) {
  console.log(
    `FAIL  port ${PORT} is already listening — a previous run's server is still up. ` +
      `Kill that PID (lsof -nP -iTCP:${PORT} -sTCP:LISTEN) and re-run.`,
  );
  process.exit(1);
}

const server = spawn(
  GALLEY,
  ['edit', doc, '--no-open', '--port', String(PORT), '--on-revise', 'true'],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1500));

// The chromium path is hoisted rather than ternaried inside the call, and the
// viewport is this probe's own. Both are deliberate: the gates' launch block is
// nine lines the dupes ratchet correctly reported this file cloning, and the
// answer to a clone is to not write it rather than to raise a bound.
const chromePath = process.env.GALLEY_CHROME;
const browser = await launchOrSkip({
  required: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});
// After the browser's own (added at launch): the server, then its folder, at
// the end or on an interrupt, so no run leaves a `galley edit` on the port.
onCleanup(() => server.kill('SIGTERM'));
onCleanup(() => rmSync(dir, { recursive: true, force: true }));
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.ProseMirror', { timeout: 15000 });
await page.waitForTimeout(1200);

const text = () =>
  page.evaluate(() => document.querySelector('.ProseMirror').innerText.trim());

// Three separate typed edits, each its own undo step (pauses keep them apart).
await page.click('.ProseMirror p:nth-of-type(1)');
await page.keyboard.press('End');
for (const [i, word] of [' ONE', ' TWO', ' THREE'].entries()) {
  await page.keyboard.type(word);
  await page.waitForTimeout(700);
  console.log(`typed ${i + 1}: ${JSON.stringify((await text()).slice(0, 60))}`);
}
const afterTyping = await text();

// EACH STEP WAITS FOR THE DOCUMENT TO MOVE, and that is not politeness — it is
// what makes this a gate rather than a coin flip. A fixed sleep after ⌘Z races
// the 400ms export debounce and the websocket round trip, and the first cut of
// this file passed cleanly and then failed the identical control twenty minutes
// later with the text still present and a redo that doubled it. A gate that
// reports the product broken when playwright is merely slow is a gate people
// learn to re-run rather than read.
const step = async (combo) => {
  const was = await text();
  await page.keyboard.press(combo);
  try {
    await page.waitForFunction(
      (prev) =>
        document.querySelector('.ProseMirror').innerText.trim() !== prev,
      was,
      { timeout: 3000 },
    );
  } catch {
    // The stack ran out, which is a legitimate outcome — the caller asserts on
    // where the document ended up, never on how many presses landed.
  }
};

// CONTROL: three undos with NO server-side mutation in between. This half is
// not redundant with the test below; see the header.
for (let i = 0; i < 3; i++) await step(UNDO);
const controlUndone = await text();
check(
  'three undos with nothing filed walk back through all three edits',
  !/ONE|TWO|THREE/.test(controlUndone),
  JSON.stringify(controlUndone.slice(0, 70)),
);

// Redo back to the typed state, so the measured half starts where this one did.
for (let i = 0; i < 3; i++) await step(REDO);
const redone = await text();
check(
  'and redo puts them back, so the stack is whole when the instruction is filed',
  redone === afterTyping,
  JSON.stringify(redone.slice(0, 70)),
);

// NOW the server-side mutation: file an instruction, the gesture a reviewer
// makes most and the one that used to orphan the stack whole.
const filed = await page.evaluate(async () => {
  const r = await fetch('/_galley/instruct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'comment',
      target: 'Beta two here.',
      text: 'tighten this',
    }),
  });
  return r.status;
});
check('filing an instruction is accepted', filed === 200, String(filed));
await page.waitForFunction(
  () => !!document.querySelector('.gly-rail-band .gly-card'),
  { timeout: 8000 },
);
const afterFiling = await text();

for (let i = 0; i < 3; i++) await step(UNDO);
const afterUndo = await text();
// AND AFTER A TEXT CHANGE, which is phase 3's own claim. Filing an instruction
// moves MARKS; reverting an edit, a version restore and the agent's landing all
// move TEXT, and until targeted text mutation every one of them went through
// `Load` and orphaned the stack whole. Marks alone passing is not evidence that
// text does.
check(
  'and three undos AFTER filing an instruction still walk back through all three',
  !/ONE|TWO|THREE/.test(afterUndo),
  JSON.stringify({
    before: afterFiling.slice(0, 70),
    after: afterUndo.slice(0, 70),
  }),
);

// A SERVER-SIDE TEXT CHANGE, WHICH IS PHASE 3'S OWN CLAIM. Filing an
// instruction moves MARKS; reverting an edit, restoring a version and the
// agent's landing all move TEXT, and until targeted text mutation every one of
// them went through `Load` and orphaned the stack whole. Marks passing is not
// evidence that text does.
//
// IT IS SELF-CONTAINED AND THE TWO EDITS ARE SEPARATE ON PURPOSE. The edit that
// gets reverted must not be one of the three being undone, or the check would be
// asking whether undoing an undo works. So: one edit in the SECOND paragraph is
// the server's text write, and three in the FIRST are the stack it must not
// disturb.
//
// The first placing of this block sat after the previous section's undos had
// already run, so there was nothing left to revert — it reported `filed: false`
// and passed anyway until the precondition was asserted. A check that cannot
// fail is worse than no check.
// A WORD INSIDE A SENTENCE, not an append. Appending " MARKER" after a full
// stop makes it its OWN sentence, which the diff reports as an `added` — and
// revert refuses an addition that is not a whole block, correctly, because
// there is no block to take out. Changing a word within the sentence keeps the
// two units paired, which is the `changed` shape revert substitutes in place,
// and a substitution inside one block is exactly the targeted TEXT write this
// section exists to exercise.
// SELECTED THROUGH THE DOM, with a triple click, rather than by walking the
// document for paragraph positions. `rounds-ux.mjs` does that walk for its own
// reasons and the dupes ratchet correctly reported this file cloning it —
// thirty-one lines — and a bound is not raised to make a build green. A triple
// click is also closer to what a reviewer does.
await page.click('.ProseMirror p:nth-of-type(2)', { clickCount: 3 });
await page.keyboard.type('Beta three here.');
await page.waitForTimeout(900);
for (const word of [' A', ' B', ' C']) {
  await page.click('.ProseMirror p:nth-of-type(1)');
  await page.keyboard.press('End');
  await page.keyboard.type(word);
  await page.waitForTimeout(700);
}
const beforeServerWrite = await text();
const wrote = await page.evaluate(async () => {
  const view = await (await fetch('/_galley/pending')).json();
  const change = (view.changes || []).find((c) => c.kind === 'changed');
  if (!change) {
    return { found: false, saw: (view.changes || []).map((c) => c.kind) };
  }
  const r = await fetch('/_galley/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: change.key }),
  });
  return {
    found: true,
    status: r.status,
    why: (await r.text()).slice(0, 140),
    kind: change.kind,
    before: change.before,
    after: change.after,
  };
});
let moved = beforeServerWrite;
for (let i = 0; i < 20 && moved === beforeServerWrite; i++) {
  await page.waitForTimeout(300);
  moved = await text();
}
check(
  'a server-side TEXT write landed, so the text half is actually exercised',
  wrote.found === true && wrote.status === 200 && /Beta two here/.test(moved),
  JSON.stringify({ ...wrote, moved: moved !== beforeServerWrite }),
);
for (let i = 0; i < 3; i++) await step(UNDO);
const afterTextUndo = await text();
check(
  'and three undos after a server TEXT write still walk back through all three',
  !/ A| B| C/.test(afterTextUndo),
  JSON.stringify(afterTextUndo.slice(0, 80)),
);

// A STRUCTURAL CHECK WAS WRITTEN HERE AND REMOVED, and what it knew is worth
// keeping. It deleted a paragraph, reverted the removal — which inserts a
// top-level block, the case the text slice alone did not cover — and asserted
// undo still walked back three later edits.
//
// It did not drive what it claimed. The server's change list reported
// `removed: "Gamma three here."` while the browser's own text still contained
// that paragraph, so the two disagreed about whether the block was gone before
// the revert was ever asked for, and the revert therefore proved nothing about
// structure. Rather than tune a check whose precondition I could not establish,
// it is deleted and the claim is made where it can be made exactly:
// `internal/ydoc`'s TestANewTopLevelBlockIsTargeted and
// TestADeletedTopLevelBlockIsTargeted, both red-proved by forcing every write
// down the block-count-equal path.
//
// THE DISAGREEMENT IS EXPLAINED NOW, AND IT WAS THE HARNESS RATHER THAN THE
// PRODUCT. Run down in isolation against a build from before any of this work
// (#180, in a detached worktree, so nothing here could be the cause):
//
//   triple click + Backspace   browser kept the paragraph, the FILE lost it
//   click + End + Shift+Home + Backspace   nothing moved at all
//   one more Backspace         the whole document was wiped, every block
//
// Three gestures, three different wrong answers, none of them what a reviewer
// would get — the clicks and keys were not landing where the probe assumed. The
// same deletion driven through ProseMirror (`editor.view.dispatch(tr.delete)`)
// makes browser, server and file agree exactly.
//
// WHICH IS WHY EVERY GATE IN THIS REPOSITORY DRIVES THE EDITOR AND NOT THE
// MOUSE for anything structural. A synthetic click into a ProseMirror document
// is not the gesture it looks like, and a check built on one measures the
// harness. Reading a paragraph's text back and asserting on it is fine; using a
// click to CHOOSE what to delete is not.

await cleanup();

// THE SERVER IS KILLED BEFORE THIS LINE, and the order is the point. An exit
// that ran first would leave a `galley edit` listening — which is exactly the
// state that made three runs of this file measure a previous run's document and
// report the CRDT scrambling text it never touched. See the port guard above.
if (counts().fails) process.exit(1);
