// ======================= THIS GATE RUNS, AND IS LOAD-BEARING =================
//
// `node web/layers.mjs` is a local gate, by hand, not in `just gates` or CI. It drives a real chromium against a real
// `galley edit` and reads `getComputedStyle`, which is the only way to catch
// the CSS bug class this file exists for: a more-specific selector silently
// beating an intended one, so a rule ships reviewed and never applies. If this
// file goes dark again, say so here the way this note once had to — a banner
// that is wrong in the safe direction still cost four gates staying silently
// dead for weeks, once.
//
// ITS HISTORY, FOR CONTEXT ON THE FIXTURE BELOW: it once WAS dark. Measured
// 2026-08-20 on `main` at 4b5561d, the gate died in its fixture setup —
//
//     Command failed: bin/galley suggest <fixture>.md --comment ... --on ...
//     galley: unknown command "suggest"
//
// — because `galley suggest` and `galley apply` had been deleted by `1cb6937
// review: complete the rounds-only architecture` and `a052b4a feat!: remove
// galley apply`. The agent's write surface became the file itself, and the
// reviewer's surface became an instruction rail rather than a population of
// decidable proposals; this file's fixture was never carried across, so every
// one of its checks went dark with nothing shouting about it.
//
// WHAT THE PALETTE-AND-PRIMARY BRANCH THEN CHANGED UNDER IT, kept here so the
// repair did not resurrect a check for something that was already gone by the
// time it landed: `.gly-revise-trail` and its 23ch reserve were DELETED (the
// trail's clause stopped being written when the rounds-only workflow arrived,
// and the reserve outlived the words); the pending count sits in
// `.gly-revise-count` on the same button, with the same argument; and the
// `.gly-amber` state class became `.gly-on`, because the colour it was named
// for moved to `--gly-signal`. It was not that branch that broke this gate —
// it was already dark — and that branch could not use this gate to hold the
// property it is here for; `web/rounds-ux.mjs` held the nothing-moves
// property over the primary's label in the meantime, see 'the primary
// changing its label moves nothing in the bar' there.
//
// The fixture was since rebuilt against the rounds-only product (the checks
// below read the instruction rail and the sealed/reopened states it actually
// has), which is how the gate is 263/0 now rather than a rewritten claim to
// be dark less convincingly.
// ===========================================================================
//
// layers.mjs — the computed-style gate for the visual system.
//
// IT IS SEQUENCED BY STATE, NOT BY SECTION NUMBER. The blocks run §1b, §1c, §4,
// §4b, §3, §5, §5b, §1, §7, §7a–§7e, and that order is deliberate rather than
// drift: the resting bar colours have to be read BEFORE the overall handle is
// clicked (amber on an open handle is correct and would be read as a
// regression), the panel has to be OPEN before §7's dark-mode loop can read
// `.gly-overall`, and the settled region has to be opened before §4b can read a
// card in it. One instrument, driven through the states in the order the
// product reaches them; the section numbers are the handoff spec's, and they
// are not a running order. Every state a block sets, it also puts back.
//
// docs/design/2026-08-08-handoff-spec.md assigns every element to exactly one
// of three layers, and every change it asks for is PAINT. Paint is invisible to
// motion.mjs, which measures rects, and invisible to probe.mjs, which has no
// DOM at all. It is also where this stylesheet's worst class of bug lives:
// `.gly-card button` (0,1,1) silently beats `.gly-thread-delete` (0,1,0), so a
// rule can be written, reviewed, commented and shipped without ever applying.
// Reading the CSS does not catch that. getComputedStyle does.
//
// Not part of `just verify` — it drives a real chromium against a real
// `galley edit`, neither of which CI has. `just layers` is the gate any change
// to a surface, a card or a verb has to clear before it lands.

import { served } from './gateserve.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// THE GATE READS THE APP'S OWN LIST, not a copy of it. §8's seal and reopen
// blocks are claims about SEALED_VERBS, and a check named for a claim must read
// the selector the claim is about — a hand-copied string here would have gone
// stale the moment `.gly-overall-input` joined the constant, and the reopen
// half would have kept reporting `ok` over a control it never looked at. That
// is exactly how it shipped: the reopen read was rail-scoped, and three
// elements of this list were dead on a reopened page with the gate green.
// probe.mjs already imports this module under node, so the import costs
// nothing new.
import { SEALED_VERBS, SEAL_ONLY_VERBS } from './seal.ts';
const GALLEY = process.env.GALLEY || 'bin/galley';
const WIDE = { width: 1600, height: 1100 };
// Split so §8 can say WHICH selector came back dead, and so a selector that
// matches nothing is a named failure rather than a silent subtraction from a
// group query.
const SEAL_SELECTORS = SEALED_VERBS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

/** A NOTE IS NOT A CHECK, and the difference is whether it can go red.
 *
 * CLAUDE.md's rule for a surface that genuinely cannot be asserted is to print
 * the number as a note OUTSIDE the pass/fail counters rather than asserting it
 * at zero. The same rule catches the opposite failure, which this file shipped:
 * a predicate whose two sides are equal in every reachable state reports `ok`
 * against the exact bug it was written for (§8's `✓ all` sweep did, against the
 * broken tree, in the same run that turned two other checks red). Print it,
 * name why it cannot fail, and put the assertion somewhere that can. */
function note(name, detail) {
  console.log(
    `note  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
  );
}

const HERE = mkdtempSync(join(tmpdir(), 'galley-layers-'));
// THE NAME IS PART OF THE FIXTURE, and `doc.md` made the widest entry in §7a's
// sweep decorative. The document's name renders in `.gly-doc` at the head of
// the bar, so it is one of the widths the bar has to fit — and at six
// characters it left 1600px with room to spare, so the bar never folded there
// and "every control can be pressed at 1600px" PASSED AGAINST THE BROKEN
// BUILD. A probe with a realistic name failed at that same width. A check that
// can only pass is not a check.
//
// Twenty-eight characters is an ordinary filename, not a stress test — this
// file's own name is twelve and the plan documents beside it are longer. It
// used to fold the bar at 1600, which is what let the sweep's top entry fail
// again; then the untracked sentence became a basis-0 bar cell and the
// whole-doc handle dropped "on the whole doc", and the boundary moved.
//
// MEASURED 2026-08-16, against the ONE readout: flat at 1248px (52.2px tall),
// folded at 1246 (91.4px). Re-measured because the previous figures here
// (flat 1240, folded 1230) were taken while the bar still had three readout
// cells and the standing sentence still had a `display: none` below 1340 —
// both gone, and the boundary went the OPPOSITE way from the arithmetic on
// gaps alone: two fewer cells is 24px less bar, but the sentence no longer
// leaves at 1340, so the fold arrives ~16px WIDER rather than narrower. Which
// is exactly why this is measured and not reasoned.
//
// The sweep's 1200/1100/1000/992 widths still walk a folded bar with it, and
// THAT IS ASSERTED NOW rather than left to this comment — see the fold checks
// after the sweep loop. Held by a filename alone it was the fixture hazard
// CLAUDE.md names, in the gate that sweeps eleven widths. 1600 walking a flat
// bar is no longer a fixture hole but the product's own new shape — an
// ordinary name is not SUPPOSED to fold 1600 any more, and motion.mjs carries
// a name long enough to fold its own wide viewport on purpose.
//
// RE-MEASURED 2026-08-20, against the instruction bar. The bar lost its
// `Instructions · N` chip to one filled primary and the whole-document handle
// to the rail, so it is narrower again and a 28-character name folded NOTHING:
// measured flat (52.2px) at every one of the sweep's widths down to 992, which
// left every check in that loop walking the shape the rename was meant to stop
// certifying — and the fold assertion after it is what said so. The walk, on
// this bar: 28 characters folds nothing, 40 folds 1100 and below, FIFTY folds
// 1200 and below while leaving 1600 flat (52.2px), 60 folds 1240 too. Fifty-one
// is what ships. Still an ordinary filename, not a stress test.
//
// One measured oddity worth knowing before anyone "fixes" it: 992 folds and
// 991 does NOT. The narrow rules land at 991 — the bar's gap drops 12px → 8px
// across eight items and `.gly-census-count` leaves entirely — and that buys
// back more than the 1px of window costs. The sweep walks both.
//
// Nothing else reads it: `.gly-doc` is the only place it renders in the bar
// (the census handle counts notes and does not name the file), and the panel
// head that does name it is full-bleed and fixed, so its width is the window's
// either way. Checked before renaming.
const DOC = join(HERE, 'the-visual-layers-handoff-and-its-computed-style.md');
writeFileSync(
  DOC,
  `# Layers

An opening paragraph mentioning the retry budget, which is worth a conversation.

A second paragraph containing the phrase alpha, which someone wants replaced.

A third paragraph naming the phrase gamma, which is also due to change.

A fourth paragraph raising the settled question, which was answered and closed.

A fifth paragraph naming the release note, which somebody has to own.

A sixth paragraph kept plain so the trail pass can strike a word in it.

A seventh paragraph holding the word omega and the word sigma, reserved for a revision.

An eighth paragraph naming the withdrawn phrase, whose highlight goes away under it.

A ninth paragraph reserved for the applied round, which the agent revises outright.

![a figure with a caption](fig.svg)
`,
);

// A figure, because "figures inherit §1 without new rules" is the third of the
// handoff's three unrendered predictions and it cannot be tested against a
// document that has no figure in it. An SVG rather than a raster: it is three
// lines of text, it has an intrinsic size so the box is a real box, and it is
// served from beside the document the way any relative src is.
writeFileSync(
  join(HERE, 'fig.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64">
  <rect width="160" height="64" fill="#c9cee0"/>
  <rect x="12" y="12" width="136" height="40" fill="#8b93b5"/>
</svg>
`,
);

// --- WHAT THE FIXTURE IS BUILT FROM, AND WHY IT CHANGED ----------------------
//
// This whole block used to be `galley suggest`, `galley resolve`, `galley reply`
// and `galley blocks`, run against the .md before the server was started: two
// ins/del proposals, a resolved thread, eight replies deep enough to cap a
// bubble, a block comment on the figure and a comment whose highlight was then
// taken out from under it. `galley suggest` was deleted with the proposal
// machinery (1cb6937) and `galley apply` after it (a052b4a); `resolve`, `reply`
// and `blocks` went with them. The reviewer's side of the loop is INSTRUCTIONS
// now — an immutable round of asks, sent by one press of Revise — and the agent
// writes the file directly.
//
// So the fixture is seeded over `POST /_galley/instruct`, which is the endpoint
// the composer and the whole-document input already post to (entry.ts), and
// which takes the same three shapes `galley suggest` did: `comment` with a
// plain-text `target`, `comment_block` with a block key, and
// `comment_document`. `guard` in serve.go admits a request with no Origin —
// that is the CLI's shape — so node can post it, and the seeding runs against
// the live server rather than against the file, which is the one difference
// that matters: the document is OPEN, so nothing may write the .md behind it.
//
// THREE POPULATIONS THE PRODUCT NO LONGER HAS, and every check that read them
// is deleted at the section it stood in rather than pointed at a substitute:
//
//   the two `--replace` proposals   §5 and §5b are about the substitution card,
//                                   which is a component with no data to build
//                                   it from.
//   the resolved thread             a card carries one verb, delete; there is
//                                   no resolve, so nothing settles, so §4b and
//                                   §7b' read an empty region forever.
//   the eight replies               a card carries no reply box, so §7c's cap
//                                   has nothing to overflow.
//
// The anchorless thread survives and is built differently: a BLOCK comment is
// filed the ordinary way and the reviewer then deletes its mark IN THE EDITOR.
// (Deleting the words under a TEXT comment retracts the comment instead —
// lostanchor.go — so that gesture makes no unplaced card any more.) That has
// to happen with the browser attached, so it is done in-page at §9 rather than
// here.
const galley = (...args) =>
  execFileSync(GALLEY, args, { encoding: 'utf8', stdio: 'pipe' });

// The headings the sections below look their fixtures up by. Read back from the
// server rather than transcribed, for the reason every key here always was: a
// heading is derived from what the comment is anchored to, so a hand-copied one
// stops resolving the day the sentence above it changes and leaves the fixture
// quietly empty — which is the pass-forever shape this repository has recorded
// six of.
const SETTLED_HEADING = 'the settled question';
const RETRY_HEADING = 'the retry budget';
const WITHDRAWN = 'the withdrawn phrase';
const WITHDRAWN_ASK = 'does this still apply?';
const FIGURE_LABEL = 'a figure with a caption';

// --on-revise, and it is §8's alone: handleRevise refuses a verdict outright
// (501) when there is neither a command configured nor a `galley wait` blocked,
// and §8 approves. `true` runs on a Revise PRESS, which no check here makes, so
// nothing else in this pass changes shape for it.
const server = spawn(
  GALLEY,
  ['edit', DOC, '--no-open', '--on-revise', 'true'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);
// THE SERVER'S OUTPUT IS DRAINED, AND SPOKEN FOR ONLY IF IT DIES. Two reasons,
// and the first is not diagnostic at all: a piped stdio nobody reads fills its
// 64KB buffer and BLOCKS the writer, which for a long run turns the server into
// a process that stops answering. The second is that when the server does go
// away, every later `page.evaluate` that fetches fails as `TypeError: Failed to
// fetch` with no hint of why — seen three times in one session, once at 2.4s
// and once at 19.7s into a run, with `code=0` and nothing on either stream,
// which is a SIGTERM from outside this process. Kept quiet on a healthy run so
// the gate's own output stays readable.
const said = [];
const startedAt = Date.now();
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (d) => said.push(String(d)));
}
server.on('exit', (code, sig) => {
  process.stderr.write(
    `\n[the server exited ${Math.round((Date.now() - startedAt) / 100) / 10}s in — code=${code} sig=${sig}]\n` +
      `${said.join('').trimEnd()}\n` +
      '[every check after this point that reads the server is reading nothing]\n',
  );
});
process.on('exit', () => {
  try {
    server.kill('SIGTERM');
  } catch {
    // Already gone; the exit code is what matters.
  }
  try {
    rmSync(HERE, { recursive: true, force: true });
  } catch {
    // ENOTEMPTY, seen once: the server is being SIGTERMed at this exact moment
    // and can write its files back into the directory mid-removal. A tmpdir
    // left behind is nothing; an exit handler that THROWS turns a run where
    // every check passed into a non-zero exit, which is a gate reporting a
    // failure that did not happen.
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

const { base: BASE, url } = await served(server);

// --- the round the reviewer has already filed --------------------------------
//
// FAILURES ARE FATAL. A seeded instruction that quietly 400s is a card no
// section below ever measures, and a gate whose fixture is half there reads
// "nothing overflows", "no card is adrift" and "the region holds nothing" as
// passes.
const instruct = async (body) => {
  const res = await fetch(`${BASE}/_galley/instruct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `fixture: /_galley/instruct refused ${JSON.stringify(body)} — ` +
        `${res.status} ${(await res.text()).trim()}`,
    );
  }
};
const pending = async () =>
  await (await fetch(`${BASE}/_galley/pending`)).json();

// AND IT IS A PARAGRAPH RATHER THAN A LINE, so §7c has a card with real height
// to place. It used to be EIGHT REPLIES DEEP, filed with `galley reply`, and
// that verb is gone with the conversation it belonged to: an instruction is a
// single immutable entry, so the tallest thread this product can hold is one
// long ask. It is a plausible instruction rather than filler, which is the
// difference between a fixture and a stress string.
await instruct({
  op: 'comment',
  target: RETRY_HEADING,
  text:
    'Per host or global? The per-connection reading is what the old client did and it is ' +
    'why the numbers never matched, so say which one this is in the sentence itself rather ' +
    'than leaving it to the reader. While you are in here: the default should probably come ' +
    'down, it should be a config value rather than a constant, and it interacts with the ' +
    'backoff schedule — which is a second conversation, but keep a line about it here so it ' +
    'is not lost. Backoff itself stays exactly as it is for now.',
});
await instruct({ op: 'comment_document', text: 'a note about the whole file' });
// A SECOND HIGHLIGHT, AND IT IS FURTHER DOWN THE PAGE ON PURPOSE. §7c's flip
// case — no room below the mark, so the card goes above it — needs a mark with
// real room ABOVE it, and the retry-budget one sits ~195px from the top of the
// document at every window this file uses. The only way to give that one no
// room below was to make the whole window 260px tall, which is a window where
// the design cannot work at all: the card is floored at a height that fits
// neither side, and a check that ran there was measuring the degradation and
// calling it the rule.
await instruct({
  op: 'comment',
  target: 'the release note',
  text: 'who owns this?',
});
// The sentence the settled thread was resolved on. It carries an ordinary
// instruction now — nothing can settle — and it is kept because §4b's block
// reads the region it would have gone into, and an empty rail is a worse
// fixture than a full one for every check that is not about settling.
await instruct({
  op: 'comment',
  target: SETTLED_HEADING,
  text: 'answered, and kept',
});
// The thread whose highlight the reviewer takes away at §9 — filed here so it
// is an ordinary anchored card for everything before that point.
await instruct({
  op: 'comment',
  target: WITHDRAWN,
  text: WITHDRAWN_ASK,
});

// AND ONE CONVERSATION ON A BLOCK — the shape that has no run BY CONSTRUCTION,
// and the one this fixture would otherwise be missing.
//
// IT IS HERE TO MAKE §10's ORPHAN CHECK CAPABLE OF FAILING. That check asks
// whether an anchorless conversation is in the map, and it asked it as
// `!c.dataset.run` — the discriminator CLAUDE.md records as WRONG, because
// `threadCard` writes `dataset.run = thread.run || ''` and a block or figure
// thread has no run to write. With this thread here the old form reports the
// figure's conversation as an orphan in the map, which is exactly the "one
// wrong predicate, two symptoms" entry arriving inside a check.
//
// THE KEY IS READ BACK from the pending view's own `blocks`, which is where
// `galley blocks` used to get it and where the browser's block grip gets it:
// it is a content hash, so a transcribed one would stop resolving the day the
// caption changes and leave the fixture quietly without a block thread again.
{
  const blocks = (await pending()).blocks || [];
  const figure = blocks.find(
    (b) => b && b.kind === 'image' && (b.label || '').includes(FIGURE_LABEL),
  );
  if (!figure)
    throw new Error(
      `fixture: no image block for "${FIGURE_LABEL}" to comment on`,
    );
  await instruct({
    op: 'comment_block',
    target: figure.key,
    text: 'does this picture still match the text?',
  });
}

{
  const filed = (await pending()).instructions || [];
  if (filed.length !== 6) {
    throw new Error(
      `fixture: ${filed.length} instructions landed, wanted 6 — ` +
        JSON.stringify(filed.map((i) => i.quote)),
    );
  }
}

const browser = await chromium.launch(
  process.env.GALLEY_CHROME
    ? { executablePath: process.env.GALLEY_CHROME }
    : {},
);
const page = await browser.newPage({ viewport: WIDE });
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.gly-tab [data-draft-id]', { timeout: 15000 });
await page.waitForTimeout(1500);

/** Every computed value this pass reads goes through here — one place that
 *  reports a missing element as null rather than throwing halfway down. */
const style = (sel, ...props) =>
  page.evaluate(
    ([s, ps]) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
    },
    [sel, props],
  );

/** The same, for every match — "the destroy weight renders EVERYWHERE a thread
 *  renders" is a claim about all of them, and one passing instance is how a
 *  regression hides. */
const styleAll = (sel, ...props) =>
  page.evaluate(
    ([s, ps]) => {
      const cs = (el) => {
        const c = getComputedStyle(el);
        return Object.fromEntries(ps.map((p) => [p, c.getPropertyValue(p)]));
      };
      return Array.from(document.querySelectorAll(s)).map(cs);
    },
    [sel, props],
  );

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const token = (name) =>
  page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
const rgb = async (name) =>
  page.evaluate(
    (v) => {
      const probe = document.createElement('span');
      probe.style.color = v;
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    },
    await token(name),
  );

// --- §8 · the trail: the reviewer's hand paints as ghost and highlight ------
//
// The trail (2026-08-15 spec) is three new painted surfaces: the deletion
// ghost, the insertion highlight, and the changed region at the rail's foot.
// Paint is what rects cannot see, so each is read from a real browser — and
// each check below was SHOWN FAILING against the pre-trail bundle before it
// was believed (the doctrine: a check must be shown failing first).

{
  // A real reviewer edit: strike one word and type another in its place, so
  // the merged entry carries BOTH halves and every surface below exists.
  //
  // WAIT FOR THE WORD, don't assume it. The document arrives over the websocket
  // and every server-side mutation replaces the whole fragment, so "the editor
  // exists" and "the editor holds the fixture" are two facts and only the second
  // one lets this block do anything. Read as an assumption, this threw
  // `fixture: no "plain" to strike` — a gate that dies on a race rather than
  // reporting a colour, and it dies EVERY time on a loaded machine, which is
  // how it was caught. The predicate is the one the evaluate below computes, so
  // there is no interval here anybody had to guess at.
  await page.click('.ProseMirror');
  await page.waitForFunction(
    () =>
      !!window.galleyEdit?.editor?.state?.doc?.textContent?.includes('plain'),
  );
  await page.evaluate(() => {
    const editor = window.galleyEdit.editor;
    const doc = editor.state.doc;
    let at = null;
    doc.descendants((node, pos) => {
      if (at !== null || !node.isTextblock) {
        return at === null;
      }
      const i = node.textContent.indexOf('plain');
      if (i !== -1) {
        at = pos + 1 + i;
      }
      return false;
    });
    if (at === null) {
      throw new Error('fixture: no "plain" to strike');
    }
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + 'plain'.length });
    editor.view.focus();
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('bare');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);

  // THE ONE CLAIM THIS FILE COULD NOT MAKE, AND THE PRODUCT'S CENTRAL ONE.
  // `.gly-trail-ghost` differed from `.gly-del` by `opacity: 0.75` and nothing
  // else — same colour, same wash, same solid strike — so the reviewer's own
  // applied edit and the agent's pending proposal were the same red
  // strikethrough in the same sentence. Measured on the fixture: a paragraph
  // carrying one agent substitution and one hand edit read as three pending
  // deletions.
  //
  // The two must be apart AT A GLANCE AND WITHOUT A LEGEND, so this reads them
  // both, in one place, and requires them to differ in COLOUR and in SHAPE.
  // Against the tracked build it reports the pair equal on both.
  //
  // Both marks must EXIST for this to mean anything: the fixture's replaces
  // put a `.gly-del` in the prose and the strike above puts a ghost beside it,
  // and a null on either side is a failure rather than a vacuous pass — the
  // null-tolerant guard is the exact shape CLAUDE.md records six of.
  // THE SECOND POPULATION IS NOT IN THE PROSE ANY MORE, AND THE FOUR CHECKS
  // THAT COMPARED THEM ARE DELETED.
  //
  // They read `.gly-trail-ghost` and `.gly-del` from the SAME paragraph and
  // required them to differ in colour, in wash and in shape — because the two
  // had differed by `opacity: 0.75` and nothing else, so the reviewer's own
  // applied edit and the agent's pending proposal were the same red
  // strikethrough in the same sentence, and one paragraph read as three pending
  // deletions.
  //
  // There are no agent marks in the prose. The agent does not propose against
  // the document; it edits the file, its edits arrive as ordinary text, and the
  // before/after lives in History's own paper. `.gly-del` in the live prose has
  // no writer, so `style('.ProseMirror .gly-del', …)` is `null` on every run and
  // every one of those inequalities would be comparing against nothing — which
  // is the null-tolerant guard CLAUDE.md records six of, arriving from the far
  // side. The pair check ("both populations are on screen to be told apart")
  // was the guard against exactly this and it is the one that went red first,
  // which is the guard working.
  //
  // WHAT SURVIVES IS THE GHOST'S OWN VOCABULARY, stated positively — the record
  // grey, the strike, the aria-hidden, and the dotted rule under inserted text —
  // because those are claims about what the reviewer sees rather than about a
  // contrast with something that is not there.
  const ghost = await style(
    '.ProseMirror .gly-trail-ghost',
    'text-decoration-line',
    'text-decoration-style',
    'color',
    'background-color',
    'user-select',
  );
  check(
    "the reviewer's ghost is on screen at all, so what follows is not read off null",
    ghost !== null,
    { ghost },
  );
  note(
    'and no agent mark is in the prose beside it — the agent edits the file',
    await page.evaluate(() => ({
      del: document.querySelectorAll('.ProseMirror .gly-del').length,
      ins: document.querySelectorAll('.ProseMirror .gly-ins').length,
    })),
  );
  // ONE REMOVAL VOCABULARY, AND THE TWO POPULATIONS ARE APART BY SHAPE.
  //
  // This asserted the ghost was `--gly-muted` — the record grey — under
  // CLAUDE.md's "RED IS RESERVED FOR WAITING ON YOU". That entry is SUPERSEDED
  // on the colour and standing on the shape (2026-08-20), and the argument is
  // worth carrying here because the reversal reads as a regression otherwise:
  // the grey existed to keep the reviewer's own edits apart from the agent's
  // undecided PROPOSALS interleaved in the same prose, so that a red strike was
  // genuinely ambiguous about whether it was asking the reviewer for something.
  // The agent's changes are applied now. There are no pending deletions in the
  // draft to be confused with, the only red strike in the prose is the
  // reviewer's own, and a colour reserved against a population that does not
  // exist is a colour spent on nothing — while grey cost the ghost the one
  // thing every reader already knows, which is that removed text is red.
  //
  // So: colour says WHAT HAPPENED to the text, shape says WHETHER IT HAS
  // HAPPENED YET. The outgoing ghost is `--gly-del`, DOTTED, with no wash; a
  // settled diff in History is `--gly-del`, SOLID, on the del wash — and that
  // contrast is asserted in §12, where a real diff is on screen to be read
  // against this one. Here is the ghost's own half, all three properties
  // together, because any one of them alone is satisfied by the design this
  // check used to state.
  check(
    'the ghost is red — there is one vocabulary for removal, and this is it',
    ghost !== null && ghost.color === (await rgb('--gly-del')),
    { ghost, want: await rgb('--gly-del') },
  );
  check(
    'and it is DOTTED and unwashed — shape is what says it has not happened yet',
    ghost !== null &&
      ghost['text-decoration-style'] === 'dotted' &&
      ghost['background-color'] === TRANSPARENT,
    ghost,
  );
  check(
    'it is still struck through — a deletion still reads as one',
    ghost !== null && ghost['text-decoration-line'].includes('line-through'),
    ghost,
  );
  check(
    'and the ghost is aria-hidden — a readout, never content',
    await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror .gly-trail-ghost');
      return !!el && el.getAttribute('aria-hidden') === 'true';
    }),
  );
  const trailIns = await style(
    '.ProseMirror .gly-trail-ins',
    'background-color',
    'border-bottom-color',
    'border-bottom-style',
  );
  // The ins half of the same deletion, for the same reason: `.gly-ins` has no
  // writer in the prose either, so the inequality that used to stand here
  // ("the reviewer's own typing does not wear the agent's ins wash") had
  // nothing on its right-hand side. The positive claim is what is left.
  check(
    "the reviewer's own typing is marked in the prose at all",
    trailIns !== null,
    { trailIns },
  );
  check(
    'it is marked by a record rule instead',
    trailIns !== null &&
      trailIns['border-bottom-style'] === 'dotted' &&
      trailIns['border-bottom-color'] === (await rgb('--gly-muted')),
    { trailIns, want: await rgb('--gly-muted') },
  );

  // THE LOG IS GONE FROM EVERY SURFACE, AND WHAT IT PAINTED IS ASSERTED AS AN
  // ABSENCE. Two checks stood here and each is answered rather than dropped:
  //
  //   `the changed region's head paints as chrome — muted, 11px, clickable`.
  //   Its subject was a disclosure at the rail's foot. The trail is an outgoing
  //   message to the agent, not a history — nobody browses it, so it has no
  //   head to paint. The chrome-voice claim it was one of several instances of
  //   is still asserted on `.gly-settled-head` in §4b.
  //
  //   `a log row quotes old→new in the prose's own red/green`. This was the ONE
  //   declared exemption to "red is reserved for waiting on you": red was legal
  //   in those rows because they sat under a head that said whose hand they
  //   were. With no rows there is nothing to excuse, and the vocabulary itself
  //   is still read on the replace card (§5), which is where the reviewer
  //   learned it. The exemption's own premise — that the GHOST must not borrow
  //   that red — is the inequality asserted directly above, which is the check
  //   that matters and the one that was missing for a whole phase.
  //
  // Asserted here rather than left to probe's bundle strings, because a region
  // can be re-added in the source and a string check only sees the artifact.
  //
  // THE ROUND'S EDIT ROWS ARE NOT THE LOG: an edit row is the reviewer's own edit
  // as it will reach the agent, with its one verb, Revert.
  const logged = await page.evaluate(() => ({
    rows: document.querySelectorAll('.gly-change-adrift').length,
    railChanged: document.querySelectorAll(
      '.gly-changed-head, .gly-changed-list',
    ).length,
    roundRows: document.querySelectorAll('.gly-edit-row').length,
  }));
  check(
    'and the reviewer\u2019s hand is logged on no surface — no log, no log row',
    logged.railChanged === 0 && logged.rows === 0,
    logged,
  );
  check(
    'and the hand edit is in the round as a row of the Instructions tab',
    logged.roundRows >= 1,
    logged,
  );

  // THE TRAIL CLAUSE ON THE VERDICT BUTTON IS GONE, AND FIVE CHECKS GO WITH IT.
  //
  // They read `.gly-revise-trail` for `n edits, m replies`, asserted that the
  // count was the hand edit just made rather than zero, and then measured the
  // SEPARATOR as paint — a Range over the one leading space, because
  // `.gly-revise-trail` is `display: inline-block` and an inline-block starts
  // its own line box, where leading collapsible white space is REMOVED. Every
  // string gate over that label was green while the button printed
  // `Finish ▾· 3 edits, 3 replies`, and this was the pass that could see it.
  //
  // `paintRevise` writes `''` into the element unconditionally, on every tick.
  // The counts came from `outgoingCounts`, which reduces `view.changes` and
  // `view.comments` — two fields the pending payload stopped carrying when it
  // became a list of instructions — so the clause is empty in every reachable
  // state. `printed` returns `null` (there is no text node to take a Range
  // over) and all three separator checks reported `— null`, which is a gate
  // reading nothing and saying so. Printed as a note instead: the number is on
  // the record and outside the pass/fail counters, which is CLAUDE.md's rule
  // for a surface that genuinely cannot be asserted.
  note(
    'the trail clause on the verdict button',
    await page.evaluate(() => ({
      label: (document.querySelector('#gly-revise')?.textContent || '').trim(),
      clause: document.querySelector('.gly-revise-trail')?.textContent || '',
    })),
  );

  // --- STRUCK AND INSERTED ARE TWO WORDS, AND TWO WORDS DO NOT TOUCH --------
  //
  // Measured in a real browser on the shipped build: `alphabeta`, `gammadelta`,
  // `keptleft`, `nothingnobody` — a deletion and the text that replaces it
  // rendered with 0px between them, so each pair reads as one malformed
  // compound. Both populations have it and neither is a diff bug:
  //
  //   THE AGENT'S. The file holds `{~~alpha~>beta~~}` — ONE CriticMarkup span
  //   at ONE position, which is the whole of "one span in the file is one
  //   decision everywhere". There is no space between the halves in the
  //   document and there must never be one: accept writes `beta` into the
  //   author's prose and reject writes `alpha`, and a space put there to make
  //   the pair legible would survive both.
  //
  //   THE REVIEWER'S. The ghost is a WIDGET decoration — ProseMirror's own
  //   "this is not in the document" — drawn at the position the new word now
  //   occupies. `trimAffixes` narrows the stored entry to the changed span, and
  //   on the fixture's own edit that span is `kep`→`lef`: strictly INSIDE one
  //   word, with no space at either end to have been trimmed. The gap is not
  //   something the diff lost; it is a box the document does not contain,
  //   needing its own separation from the text it was inserted before.
  //
  // So the gap belongs to the mark's own box in both cases, and it is read here
  // as GEOMETRY against the width of a real space in the same prose — the one
  // measurement that says "these read as two words" rather than "some rule
  // declares some margin".
  const spacing = await page.evaluate(() => {
    const gap = (a, b) =>
      +(
        b.getBoundingClientRect().left - a.getBoundingClientRect().right
      ).toFixed(2);
    const agent = [];
    for (const del of document.querySelectorAll('.ProseMirror .gly-del')) {
      const next = del.nextElementSibling;
      if (!next || !next.classList.contains('gly-ins')) continue;
      agent.push({
        reads: del.textContent + next.textContent,
        gap: gap(del, next),
      });
    }
    const hand = [];
    for (const ghost of document.querySelectorAll(
      '.ProseMirror .gly-trail-ghost',
    )) {
      const next = ghost.nextElementSibling;
      if (!next || !next.classList.contains('gly-trail-ins')) continue;
      hand.push({
        reads: ghost.textContent + next.textContent,
        gap: gap(ghost, next),
      });
    }
    // A SPACE IN THE SAME PROSE, at the same size and in the same family, so
    // the bound is the reader's own and not a number somebody picked.
    let space = null;
    for (const p of document.querySelectorAll('.ProseMirror p')) {
      const t = p.firstChild;
      if (!t || t.nodeType !== 3) continue;
      const i = t.data.indexOf(' ');
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      space = +r.getBoundingClientRect().width.toFixed(2);
      break;
    }
    return { agent, hand, space };
  });
  // ONE POPULATION, FOR THE REASON THE FOUR CHECKS ABOVE WERE DELETED: there
  // are no `.gly-del`/`.gly-ins` pairs in the prose, so `spacing.agent` is empty
  // on every run and `[].every(...)` is `true` — the agent half of this claim
  // would report `ok` about nothing at all. The reviewer's own ghost-beside-its
  // -replacement is a real pair and is asserted; the agent's is named as absent
  // in the same breath, so the deletion is on the record and not a silence.
  check(
    'the reviewer’s ghost and its replacement are both rendered, so the gap is a real gap',
    spacing.hand.length > 0 && spacing.space > 0,
    spacing,
  );
  check(
    'and they read as two words, not one',
    spacing.hand.every((h) => h.gap >= spacing.space),
    spacing,
  );
  note(
    'agent substitution pairs in the prose (none: the agent edits the file)',
    spacing.agent.length,
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

// --- §11 · clicking marked-up text ---------------------------------------
//
// ONE PLACE FOR AN INSTRUCTION. The tab already draws it, so a second copy in a
// bubble would be two boxes and two deletes for one draft. What the click does
// instead is take the reviewer to the row.
{
  await page.evaluate(() => window.scrollTo(0, 0));
  const hl = page.locator('.ProseMirror .gly-hl').first();
  check('the fixture has a comment highlight to click', (await hl.count()) > 0);
  await hl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hl.click();
  await page.waitForTimeout(400);
  const onComment = await page.evaluate(() => {
    const el = document.querySelector('.gly-bubble');
    const row = document.querySelector('.gly-tab .kit-draft-row.on');
    return {
      bubbleOpen: !!el && !el.hidden,
      rowKey: row ? row.dataset.draftId : null,
      rowShown: !!row && row.offsetParent !== null,
    };
  });
  check(
    'clicking a comment highlight does not open a second copy of its words',
    onComment.bubbleOpen === false,
    onComment,
  );
  check(
    'it takes the reviewer to the row in the Instructions tab',
    onComment.rowKey !== null && onComment.rowShown,
    onComment,
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

// takeBack deletes an instruction a section filed for its own check, and waits
// for the page to have heard, so the sections after it count what they always
// counted.
const takeBack = (key) =>
  page.evaluate(async (k) => {
    await fetch('_galley/instruction/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k }),
    });
    await window.galleyEdit.app.refreshPending();
  }, key);

// --- §1e · a block note's words are a widget, painted by ID -----------------
//
// A block comment's note carries only its ID; the amber box gets the words from
// the instruction data, as a WIDGET DECORATION inside the note (note.ts's
// noteWordDecorations). Paint is what this file is for: the widget has to keep
// the comment's line breaks and wrap a long token, and only a real browser's
// computed style can say it does.
//
// FILED THROUGH THE COMPOSER, the reviewer's own path: the grip beside the
// title, then the form it opens. The note is then found by its ID — the
// pending instruction's key — and by nothing else: no text is matched, and
// nothing is written into the fragment by this check.
//
// AND IT GROWS. The comment is then edited to three lines, the way the card's
// edit box does it, and every other card is measured before and after. The
// note sits under the title, so every mark in the document is below it and
// moves down with the prose. "A click moves nothing but what was clicked" is
// the rule this is measured against; the movement is printed as a note. The comment is
// deleted at the end, so the sections after this one count what they always
// counted.
{
  const before = ((await pending()).instructions || []).length;
  await page.evaluate(() =>
    window.galleyEdit.editor.commands.setTextSelection(1),
  );
  // The title's grip is there at rest and opens the form directly.
  const grip = page.locator('.gly-block-grip[data-kind="heading"]').first();
  await grip.waitFor({ state: 'visible', timeout: 5000 });
  await grip.click();
  await page
    .locator('.gly-composer-form')
    .waitFor({ state: 'visible', timeout: 5000 });
  const FIRST = 'say who this handoff is for';
  await page.fill('.gly-composer-text', FIRST);
  await page.click('.gly-composer-send');
  await page.waitForFunction(
    (n) => (window.galleyEdit.app.comments || []).length === n,
    before + 1,
    { timeout: 10000 },
  );
  const key = ((await pending()).instructions || []).find(
    (i) => i.anchor === 'block' && i.text === FIRST,
  )?.key;
  // Every card in the band but the new one, and for the anchored ones the
  // mark it hangs on, in page coordinates.
  const measure = (id) =>
    page.evaluate(async (k) => {
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      const aside = document.querySelector(
        `.gly-note[data-comment-id="${CSS.escape(k)}"]`,
      );
      const el = aside && aside.querySelector('.gly-note-words');
      const cs = el && getComputedStyle(el);
      return {
        notes: document.querySelectorAll(
          `.ProseMirror .gly-note[data-comment-id="${CSS.escape(k)}"]`,
        ).length,
        text: el ? el.textContent : null,
        whiteSpace: cs ? cs.whiteSpace : null,
        overflowWrap: cs ? cs.overflowWrap : null,
        height: aside ? Math.round(aside.getBoundingClientRect().height) : 0,
      };
    }, id);
  const filed = key ? await measure(key) : null;
  check(
    'a block comment filed through the composer has an ID note in the prose, so this can fail',
    !!key && /^cb-[0-9a-f]{16}$/.test(key) && !!filed && filed.notes === 1,
    { key, filed },
  );
  check(
    "the note shows its comment's words in a widget, found by ID",
    !!filed && filed.text === FIRST,
    filed,
  );
  const GROWN = 'say who this handoff is for:\n\nthe reviewer,\nor the agent';
  await page.evaluate(
    async ({ k, text }) => {
      await fetch('_galley/instruct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'edit', key: k, text, author: 'user' }),
      });
      await window.galleyEdit.app.refreshPending();
    },
    { k: key || '', text: GROWN },
  );
  const grown = key ? await measure(key) : null;
  check(
    "the widget keeps the comment's line breaks and wraps a long token",
    !!grown &&
      grown.text === GROWN &&
      grown.whiteSpace === 'pre-wrap' &&
      grown.overflowWrap === 'anywhere' &&
      grown.height > filed.height,
    { filed: filed && filed.height, grown },
  );
  await takeBack(key || '');
  const gone = key ? await measure(key) : null;
  check(
    'and deleting the comment takes its note and its widget with it',
    !!gone && gone.notes === 0 && gone.text === null,
    gone,
  );
  await page.waitForFunction(
    (n) => (window.galleyEdit.app.comments || []).length === n,
    before,
    { timeout: 10000 },
  );
}

// --- §1f · a grip with instructions is painted as one ---------------------
//
// A block that carries instructions has a grip that says so in paint as well
// as in its count: the instruction's own violet on its edge and its ground.
// Read as an INEQUALITY between the same grip at rest and commented, in both
// schemes, rather than as a token match alone: a commented rule that lost the
// cascade to the resting one paints both the same, and a token check on a
// token that is itself wrong passes either way. And the resting grip borrows
// nothing from the two colours that already mean something in the prose —
// the removed-text red and the light's amber wash.
//
// ONE GRIP, READ TWICE: the title's, before and after an instruction is filed
// on it. Every grip-bearing block in this fixture but the title already
// carries one, so there is no second grip at rest to compare against.
{
  const title = await page.evaluate(
    () =>
      (window.galleyEdit.app.blocks || []).find((b) => b.kind === 'heading') ||
      null,
  );
  const grip = `.gly-block-grip[data-index="${title ? title.index : -1}"]`;
  const PAINT = ['background-color', 'border-top-color', 'color'];
  const SCHEMES = ['dark', 'light'];
  const paint = async () => {
    await page.mouse.move(0, 0);
    const out = {};
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      out[scheme] = {
        grip: await style(grip, ...PAINT),
        hl: await rgb('--gly-hl'),
        hlBg: await rgb('--gly-hl-bg'),
        taken: [
          await rgb('--gly-del'),
          await rgb('--gly-del-bg'),
          await rgb('--gly-lit-bg'),
        ],
      };
    }
    await page.emulateMedia({ colorScheme: 'light' });
    return out;
  };
  const resting = await paint();
  const filed = await page.evaluate(
    async (k) => {
      const r = await fetch('_galley/instruct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'comment_block',
          target: k,
          text: 'paint check',
          author: 'user',
        }),
      });
      await window.galleyEdit.app.refreshPending();
      return r.ok
        ? ((await r.json()).instructions || []).find(
            (i) => i.text === 'paint check',
          )?.key || ''
        : '';
    },
    title ? title.key : '',
  );
  await page
    .waitForSelector(`${grip}.is-commented`, { timeout: 10000 })
    .catch(() => {});
  const commented = await paint();
  for (const scheme of SCHEMES) {
    const rest = resting[scheme].grip;
    const lit = commented[scheme].grip;
    const { hl, hlBg, taken } = commented[scheme];
    check(
      `a commented grip differs from a resting one in ground AND edge in ${scheme}`,
      !!lit &&
        !!rest &&
        lit['background-color'] !== rest['background-color'] &&
        lit['border-top-color'] !== rest['border-top-color'],
      { scheme, lit, rest },
    );
    check(
      `and its paint is the instruction's violet in ${scheme}`,
      !!lit &&
        lit['border-top-color'] === hl &&
        lit['background-color'] === hlBg &&
        lit.color === hl,
      { scheme, lit, hl, hlBg },
    );
    check(
      `a resting grip shares no colour with removed text or the light in ${scheme}`,
      !!rest && PAINT.every((p) => !taken.includes(rest[p])),
      { scheme, rest, taken },
    );
  }
  await takeBack(filed);
  check('the paint check filed its instruction and took it back', !!filed, {
    title,
    filed,
  });
}

// --- §7 · the three surfaces the mockup never rendered -----------------------
//
// The handoff's own closing note says dark mode, the narrow/sheet layout and
// figures "inherit their layer assignments and need no new rules". That is a
// PREDICTION, not an observation — it rendered none of the three — and the
// panel's own background was a hardcoded chrome token until this week. So it
// is tested here rather than believed.
//
// Read through getComputedStyle under emulateMedia, deliberately, and NOT
// through ruleValue: the dark tokens live inside
// `@media (prefers-color-scheme: dark)` and ruleValue walks TOP-LEVEL rules
// only, so it would answer null for every one of them — which is
// indistinguishable from "no such declaration". The browser honours the media
// query for free, and the question here is what a reader sees anyway.

for (const scheme of ['dark', 'light']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(300);

  // FIGURES — the third prediction, and the one with no assertion anywhere in
  // this file until now. The `read-only` chip is the passive half of the
  // refusal voice and it is CHROME wherever it renders: the mono voice, the
  // muted colour, the panel token behind it.
  const chip = await style(
    '.gly-figure > .gly-chip',
    'font-family',
    'color',
    'background-color',
  );
  const mono = await token('--gly-mono');
  const muted = await rgb('--gly-muted');
  const panelBg = await rgb('--gly-panel-bg');
  check(
    `the figure's read-only chip speaks the chrome voice in ${scheme}`,
    chip &&
      chip['font-family'] === mono &&
      chip.color === muted &&
      chip['background-color'] === panelBg,
    { scheme, chip, mono, muted, panelBg },
  );

  // And the figure box itself is a §1 container: 6px, on the line colour, on
  // the fence token — the same three values a fence and a table carry.
  const fig = await style(
    '.gly-figure',
    'border-radius',
    'border-top-color',
    'background-color',
  );
  check(
    `the figure box is a 6px container on the line colour in ${scheme}`,
    fig &&
      fig['border-radius'] === '6px' &&
      fig['border-top-color'] === (await rgb('--gly-line')) &&
      fig['background-color'] === (await rgb('--gly-fence')),
    { scheme, fig },
  );
}
await page.emulateMedia({ colorScheme: 'light' });

// --- §10 · which words is this row about ------------------------------------
console.log('\n--- §10 · which words is this row about ---');
{
  await page.evaluate(() => {
    const app = window.galleyEdit.app;
    app.selectedDraft = '';
    app.paintLit();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);

  // Nothing at rest, hovering a row lights ITS OWN WORDS in the prose, hovering the
  // words lights the row, and the same from the keyboard.
  const lit = () =>
    page.evaluate(() => {
      const prose = Array.from(
        document.querySelectorAll('.ProseMirror .gly-lit'),
      );
      const cards = Array.from(
        document.querySelectorAll('.gly-tab .kit-draft-row.gly-lit'),
      );
      return {
        prose: prose.length,
        cards: cards.length,
        rows: cards.map((el) => el.dataset.draftId),
        // The OLD mechanism, asserted absent everywhere it could come back: the
        // overlay, the two spans that preceded it, and any line at all.
        connector: document.querySelectorAll(
          '.gly-connector, .gly-connector-arm, .gly-connector-leg',
        ).length,
      };
    });

  const atRest = await lit();
  check(
    'at rest nothing is lit — and no connector survives anywhere on the page',
    atRest.prose === 0 && atRest.cards === 0 && atRest.connector === 0,
    atRest,
  );

  // The row whose words are lit is the first with a mark in the prose, chosen off
  // the page rather than written down.
  const picked = await page.evaluate(() => {
    for (const t of window.galleyEdit.app.comments) {
      if (
        t.run &&
        document.querySelector(`.ProseMirror [data-run="${CSS.escape(t.run)}"]`)
      ) {
        return { key: t.key, run: t.run };
      }
    }
    return null;
  });
  check('the fixture has a row whose words are in the prose', !!picked, picked);
  const target = picked.run;
  const cardSel = `.gly-tab [data-draft-id="${picked.key}"]`;
  const markSel = `.ProseMirror [data-run^="${target}"]`;

  await page.locator(cardSel).hover();
  await page.waitForTimeout(300);
  const onCard = await lit();
  check(
    'hovering a row lights words in the prose, and lights itself',
    onCard.prose > 0 && onCard.cards === 1 && onCard.rows[0] === picked.key,
    onCard,
  );

  // AND IT IS THE ROW'S OWN WORDS, over the whole extent.
  const landed = await page.evaluate((sel) => {
    const runOf = (el) => {
      const own = el.closest('[data-run]');
      if (own) return own.getAttribute('data-run');
      const inner = el.querySelector('[data-run]');
      return inner ? inner.getAttribute('data-run') : null;
    };
    const union = (els) => {
      let b = null;
      for (const el of els) {
        for (const r of el.getClientRects()) {
          if (!r.width && !r.height) continue;
          b = b
            ? {
                x1: Math.min(b.x1, r.left),
                y1: Math.min(b.y1, r.top),
                x2: Math.max(b.x2, r.right),
                y2: Math.max(b.y2, r.bottom),
              }
            : { x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
        }
      }
      return (
        b && {
          x1: +b.x1.toFixed(1),
          y1: +b.y1.toFixed(1),
          x2: +b.x2.toFixed(1),
          y2: +b.y2.toFixed(1),
        }
      );
    };
    const glowing = Array.from(
      document.querySelectorAll('.ProseMirror .gly-lit'),
    );
    const runs = glowing.map(runOf);
    const named = [...new Set(runs.filter(Boolean))];
    const marks = named.length
      ? document.querySelectorAll(
          named
            .map((r) => `.ProseMirror [data-run="${CSS.escape(r)}"]`)
            .join(', '),
        )
      : [];
    return {
      spans: glowing.length,
      // A lit span with no run at all is a light on unmarked prose.
      unmarked: runs.filter((r) => !r).length,
      runs: named.map((r) => r.slice(0, 8)),
      glow: union(glowing),
      mark: union(marks),
    };
  }, markSel);
  note('what the light covers, against the marks it claims', landed);
  check(
    'every lit span belongs to a marked run — the light never lands on plain prose',
    landed.spans > 0 && landed.unmarked === 0,
    landed,
  );
  check(
    'and the row’s own run is among them',
    landed.runs.includes(target.slice(0, 8)),
    landed,
  );
  check(
    'and the light covers those runs’ marks exactly, not the paragraph',
    !!landed.glow &&
      !!landed.mark &&
      Math.abs(landed.glow.x1 - landed.mark.x1) <= 6 &&
      Math.abs(landed.glow.x2 - landed.mark.x2) <= 6 &&
      Math.abs(landed.glow.y1 - landed.mark.y1) <= 6 &&
      Math.abs(landed.glow.y2 - landed.mark.y2) <= 6,
    landed,
  );

  // AND IT IS NOT CONFUSABLE WITH THE TWO POPULATIONS ALREADY IN THE PROSE.
  // The trail ghost borrowed the agent's del-red for a whole phase and this
  // file's check certified it, because each colour was read against a TOKEN and
  // never against the other. So this is the inequality, as that one now is: the
  // light shares no background with any of the three suggestion marks, and it
  // carries no text-decoration at all, which is the ghost's whole shape.
  const apart = await page.evaluate(() => {
    const of = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        deco: cs.textDecorationLine,
        color: cs.color,
      };
    };
    return {
      lit: of('.ProseMirror .gly-lit'),
      ins: of('.ProseMirror .gly-ins'),
      del: of('.ProseMirror .gly-del'),
      hl: of('.ProseMirror .gly-hl'),
    };
  });
  note('the light against the marks it must not be read as', apart);
  check(
    'the light is not the comment mark’s wash, and wears no strike or rule',
    !!apart.lit &&
      !!apart.hl &&
      apart.lit.bg !== apart.hl.bg &&
      apart.lit.deco === 'none',
    apart,
  );

  // FROM EITHER END.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  check(
    'moving off puts the light out',
    (await lit()).prose === 0 && (await lit()).cards === 0,
  );
  await page.locator(markSel).first().hover();
  await page.waitForTimeout(300);
  const onWord = await lit();
  check(
    'hovering the WORD lights its row — either end, one mechanism',
    onWord.cards === 1 && onWord.prose > 0 && onWord.rows[0] === picked.key,
    onWord,
  );

  // AND ON KEYBOARD FOCUS, on the row's quote.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  check('and off again', (await lit()).prose === 0);
  const quoteSel = `${cardSel} .kit-draft-quote`;
  await page.locator(quoteSel).focus();
  await page.waitForTimeout(300);
  const onFocus = await lit();
  check(
    'focusing a row from the keyboard lights its words',
    onFocus.prose > 0 && onFocus.cards === 1,
    onFocus,
  );
  check(
    'and the focus really is on the row, so the check is not a hover in disguise',
    await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      quoteSel,
    ),
  );
  await page.evaluate(
    () => document.activeElement && document.activeElement.blur(),
  );
  await page.waitForTimeout(250);
  check('and blurring puts it out', (await lit()).prose === 0);

  // THE LIGHT IS A DECORATION: ProseMirror rewrites a rendered element's attributes
  // on every redraw, which follows every server-side mutation. So a real mutation
  // is driven WHILE the row is lit, and both ends are read back.
  await page.locator(cardSel).hover();
  await page.waitForTimeout(300);
  check(
    'lit before the mutation — a check with nothing to read is not a check',
    (await lit()).prose > 0,
  );
  await instruct({
    op: 'comment',
    target: 'A sixth paragraph',
    text: 'a mutation while the light is on',
  });
  await page.waitForTimeout(4000);
  const survived = await lit();
  note('the light after a whole-document rebuild and a repaint', survived);
  check(
    'the light survives a server-side mutation — it is a decoration, not a class on the mark',
    survived.prose > 0 && survived.cards === 1,
    survived,
  );
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);

  // DELETING THE WORDS RETRACTS THE COMMENT, and a BLOCK comment whose mark goes
  // stays, marked. The seed filed both kinds.
  await page.waitForFunction(
    (q) =>
      [...document.querySelectorAll('.gly-tab [data-draft-id] textarea')].some(
        (b) => b.value === q,
      ),
    WITHDRAWN_ASK,
    { timeout: 20000 },
  );
  await page.waitForTimeout(800);

  const withdrawn = await page.evaluate((phrase) => {
    const editor = window.galleyEdit.editor;
    let at = null;
    editor.state.doc.descendants((node, pos) => {
      if (at !== null || !node.isTextblock) return at === null;
      const i = node.textContent.indexOf(phrase);
      if (i !== -1) at = pos + 1 + i;
      return false;
    });
    if (at === null) return false;
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + phrase.length });
    editor.commands.deleteSelection();
    return true;
  }, WITHDRAWN);
  check(
    'the fixture could take the highlight out from under a conversation',
    withdrawn === true,
    { WITHDRAWN, withdrawn },
  );
  await page.waitForFunction(
    (q) =>
      !(window.galleyEdit.app.comments || []).some((c) =>
        (c.entries || []).some((e) => e.text === q),
      ) &&
      ![...document.querySelectorAll('.gly-tab [data-draft-id] textarea')].some(
        (b) => b.value === q,
      ),
    WITHDRAWN_ASK,
    { timeout: 15000 },
  );
  check(
    'deleting the highlighted words retracts the comment — it is not left as an unplaced row',
    !(await page.locator('.gly-tab [data-draft-id]').allInnerTexts()).some(
      (t) => t.includes('its words were removed'),
    ),
  );

  // THE UNPLACED INSTRUCTION IS A BLOCK COMMENT WHOSE MARK WAS DELETED. A
  // block comment's place is its `{>>@comment cb-…<<}` note, and a block
  // comment whose note leaves the document STAYS, unplaced (lostanchor.go's
  // first guard: only a text comment is retracted). The reviewer selects the
  // amber box and deletes it; the transaction below is that deletion.
  {
    const blocks = (await pending()).blocks || [];
    const eighth = blocks.find(
      (b) => b && (b.label || '').includes('eighth paragraph'),
    );
    if (!eighth)
      throw new Error(
        'fixture: no block for the eighth paragraph to comment on',
      );
    await instruct({
      op: 'comment_block',
      target: eighth.key,
      text: 'is this paragraph still needed?',
    });
  }
  const unplacedKey = (
    ((await pending()).instructions || []).find(
      (i) => i && i.text === 'is this paragraph still needed?',
    ) || {}
  ).key;
  if (!unplacedKey)
    throw new Error('fixture: the block comment is not in /_galley/pending');
  await page.waitForFunction(
    (id) => {
      let found = false;
      window.galleyEdit.editor.state.doc.descendants((n) => {
        if (n.type.name === 'note' && n.attrs.id === id) found = true;
        return !found;
      });
      return found;
    },
    unplacedKey,
    { timeout: 15000 },
  );
  const markGone = await page.evaluate((id) => {
    const editor = window.galleyEdit.editor;
    let at = null;
    editor.state.doc.descendants((n, pos) => {
      if (at === null && n.type.name === 'note' && n.attrs.id === id)
        at = { from: pos, to: pos + n.nodeSize };
      return at === null;
    });
    if (at === null) return false;
    editor.view.dispatch(editor.state.tr.delete(at.from, at.to));
    return true;
  }, unplacedKey);
  check(
    'the fixture could delete a block comment’s mark from under it',
    markGone === true,
    { unplacedKey, markGone },
  );
  const unplacedRow = `.gly-tab [data-draft-id="${unplacedKey}"]`;
  await page.waitForFunction(
    (sel) =>
      /its words were removed/.test(
        document.querySelector(sel)?.textContent || '',
      ),
    unplacedRow,
    { timeout: 15000 },
  );
  const unplaced = await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    return {
      words: row?.querySelector('textarea')?.value,
      deletes: [...(row?.querySelectorAll('button') ?? [])].filter(
        (b) => b.textContent === 'Delete',
      ).length,
    };
  }, unplacedRow);
  check(
    'a block comment whose mark was deleted stays a complete, deletable row that says its words were removed',
    unplaced.words === 'is this paragraph still needed?' &&
      unplaced.deletes === 1,
    unplaced,
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
}

// --- §8a · the seal's sweep may not touch a LIVE page's flags ----------------
//
// BEFORE §8, and that ordering is the whole check: it asserts what a page that
// has NOT been sealed looks like, and §8 below ends the review for good.
//
// `applySealedVerbs` walks SEALED_VERBS and writes `disabled`. It used to write
// it unconditionally — `el.disabled = !!this.sealed` — so on an ordinary live
// review it wrote `false` over every flag another owner had set. It runs at the
// foot of `paintTabs`, so it was the last thing every pending refresh did.
//
// So the flag is written onto a real, live control and a real `refreshPending` is
// run over it: a pending refresh does not hand back a flag it did not set.
console.log('\n--- §8a · a live page owns its own disabled flags ---');
{
  const sealed = await page.evaluate(() => {
    const el = document.querySelector('#gly-seal');
    return !!el && getComputedStyle(el).display !== 'none';
  });
  check(
    'the review under this check is LIVE — §8 has not run yet',
    sealed === false,
    { sealed },
  );

  // THE ELEMENTS READ ARE THE ONES WITH NO PAINTER: the whole-document box is built once, and
  // the composer's box is placed by gestures.
  const marked = await page.evaluate(() => {
    const sels = ['#gly-doc-box', '.gly-composer-text'];
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) {
        out.push({ sel, found: false });
        continue;
      }
      el.disabled = true;
      out.push({ sel, found: true, before: !!el.disabled });
    }
    return out;
  });
  check(
    'every control this reads exists on the fixture — a check with nothing to read is not a check',
    marked.length === 2 && marked.every((m) => m.found && m.before),
    marked,
  );

  // THE EVENT IS A PENDING REFRESH, not a repaint: `applySealedVerbs` is the
  // tail of `paintTabs`, and `refreshPending` is what every poll, every
  // mutation and every verdict runs.
  await page.evaluate(() => window.galleyEdit.app.refreshPending());
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => {
    const sels = ['#gly-doc-box', '.gly-composer-text'];
    return sels.map((sel) => {
      const el = document.querySelector(sel);
      return { sel, present: !!el, disabled: !!(el && el.disabled) };
    });
  });
  check(
    'a live pending refresh does not hand back a flag it did not set',
    after.length === 2 && after.every((a) => a.present && a.disabled),
    after,
  );

  // PUT THEM BACK, or §8 reads two controls this block killed rather than two
  // the seal did — and the reopen half of §8 would then pass over them for the
  // wrong reason. `releaseSealOnlyVerbs` is the seal's own edge and not
  // available here, so they are restored the same way they were written.
  //
  // FROM THE APP'S OWN LIST, not from a pair of selectors written down here.
  // `.gly-census-overall` was one of the two and it is not built any more, so
  // the restore threw on `null.disabled` — a gate dying on a control that left
  // the product. `SEAL_ONLY_VERBS` is the constant this file already imports
  // for exactly this reason, and reading it here means the restore covers
  // whatever the seal's own edge covers, forever.
  const sealOnly = SEAL_ONLY_VERBS.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  await page.evaluate((sels) => {
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) el.disabled = false;
    }
  }, sealOnly);
  const restored = await page.evaluate(
    (sels) =>
      sels.every((sel) => {
        const found = Array.from(document.querySelectorAll(sel));
        return found.length > 0 && found.every((el) => el.disabled === false);
      }),
    sealOnly,
  );
  check(
    'and every seal-only verb is live again before §8 runs',
    restored,
    sealOnly,
  );
}

// --- §12 · the rounds -------------------------------------------------------
//
// THE SURFACE THE RECORD LIVES ON, read at the two states that can be wrong.
//
// A HIDDEN FULL-SCREEN SURFACE THAT IS NOT ACTUALLY HIDDEN COVERS THE DOCUMENT,
// and `[hidden] { display: none }` is a USER-AGENT rule that ANY author
// `display` beats — this panel needs `display: flex` for its own layout, so the
// first cut of it painted over the whole page from load with `hidden` set.
// Nine checks in `just motion` passed over that: a rect is a rect under an
// overlay, and every bar control still answered `elementFromPoint` because the
// bar sits above the panel. The first thing to notice was a drag across the
// prose that selected nothing. So the check is not "the attribute is set" —
// that is the proxy this file records six failures of — it is what the browser
// does with a click at a coordinate over the prose.
//
console.log('\n--- §12 · the rounds ---');
{
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await page.waitForTimeout(400);

  // A ROUND FIRST: the agent answers what the fixture filed, the real way, so the
  // record holds one to read. Sending clears the tab.
  galley('revise', DOC);
  {
    const was = readFileSync(DOC, 'utf8');
    const now = was.replace('A sixth paragraph', 'A sixth paragraph, revised');
    if (now === was) {
      throw new Error('fixture: the sixth paragraph is not in the file');
    }
    writeFileSync(DOC, now);
  }
  galley('ack', DOC, '--state', 'answered', '--note', 'revised the sixth');
  await page.waitForTimeout(2600);

  const shut = await page.evaluate(() => {
    const el = document.querySelector('.gly-versions');
    if (!el) return null;
    const p = document.querySelector('.ProseMirror p');
    const r = p.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + 8, r.y + 8);
    return {
      display: getComputedStyle(el).display,
      hidden: el.hidden,
      overProse: at ? at.className || at.tagName : null,
      reachesPanel: !!(at && at.closest && at.closest('.gly-versions')),
    };
  });
  check('the rounds exist as a surface at all', !!shut, shut);
  check(
    'a shut record is DISPLAYED nowhere, not merely marked hidden',
    !!shut && shut.hidden === true && shut.display === 'none',
    shut,
  );
  check(
    'and the prose under it answers a click, which is the claim the attribute is only a proxy for',
    !!shut && shut.reachesPanel === false,
    shut,
  );

  await page.click('.gly-versions-open');
  await page.waitForTimeout(600);

  const open = await page.evaluate(() => {
    const el = document.querySelector('.gly-versions');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('.kit-bar');
    const barR = bar.getBoundingClientRect();
    const list = document.querySelector('.gly-versions-list');
    const paper = document.querySelector('.gly-versions-paper');
    const rounds = [...document.querySelectorAll('.gly-versions-round')];
    return {
      position: cs.position,
      z: Number(cs.zIndex),
      top: +r.top.toFixed(2),
      barBottom: +barR.bottom.toFixed(2),
      bg: cs.backgroundColor,
      rounds: rounds.length,
      said: rounds.map((b) => (b.textContent || '').trim()).slice(0, 3),
      paper: paper ? (paper.textContent || '').trim().length : 0,
      listScrolls: list ? getComputedStyle(list).overflowY : null,
      views: [...document.querySelectorAll('.gly-versions-view-pick')].map(
        (b) => b.textContent,
      ),
      historyMode: document.body.classList.contains('gly-history-mode'),
      mainDisplay: getComputedStyle(
        document.querySelector('.kit-card-body > main'),
      ).display,
      barDisplay: getComputedStyle(bar).display,
    };
  });
  // IT IS A VIEW NOW, NOT A PANEL FLOATING OVER ONE. This asserted
  // `position: fixed` off the bar's own measured foot, because the record was a
  // full-screen surface laid over the document — a HIDDEN full-screen surface
  // that is not actually hidden covers the prose, which is the defect the block
  // below it was written for. History is one of the two DOCUMENT VIEWS today:
  // `body.gly-history-mode` takes `main` to `display: none` and the record is
  // `position: relative` in its place, with the bar still painted above it.
  //
  // The claim is inverted rather than dropped, and it is the same claim in the
  // new geometry: the record does not PUSH the page. It replaces the document
  // and leaves the chrome where it was — asserted as all three facts together,
  // because "relative" on its own is what a surface that pushes everything
  // below it also reports.
  check(
    'an open record replaces the document view and leaves the bar where it was',
    open.position === 'relative' &&
      open.historyMode === true &&
      open.mainDisplay === 'none' &&
      open.barDisplay !== 'none',
    open,
  );
  check(
    'and it is opaque — a record read through the prose behind it is a record nobody can read',
    open.bg !== 'rgba(0, 0, 0, 0)',
    open.bg,
  );
  // TWO VIEWS, NAMED FOR WHAT THEY SHOW. The spec offered four — clean, in
  // place, reverse, side by side — and three of them were readings of a diff
  // between a proposal and the document. There are no proposals: a round is
  // what the agent DID, so the record has one diff to draw and one way to draw
  // it side by side. The order is still pinned, because a picker whose entries
  // reorder is a reviewer clicking the wrong one out of habit.
  check(
    'the two views are offered, in order',
    open.views.join(',').toLowerCase() === 'changes,side by side',
    open.views,
  );
  // AND THE LIST IS ONE STAGE BACK. History opens on the round the reviewer
  // just got back — it is a READING mode now, not a browser — so the door lands
  // on a diff and the rounds list is behind `‹ all rounds`. The claim is
  // unchanged and it is the claim that matters: there is a history, it is ONE
  // list, and it scrolls in one place rather than nesting scrollers.
  await page.locator('.gly-versions-all').click();
  await page.waitForTimeout(500);
  // ONE SCROLLER, COUNTED FROM THE LIST OUTWARDS. This read `overflow-y` off
  // `.gly-versions-rail` and required `auto` — which pins WHICH element
  // scrolls, and the record has been re-laid out twice since (the rail reports
  // `visible` now; something above it takes the overflow). The claim was never
  // about that element: it is that the history is ONE list in ONE scroller,
  // because nested scrollers are how a reviewer loses the round they were
  // looking for. So the ancestors of a real round entry are walked and the
  // scrollable ones counted.
  //
  // AND THE ANSWER IS ZERO, WHICH IS THE POINT. History is a reading mode in
  // the page's own flow (`position: relative`, with `main` taken to
  // `display: none` beside it), so the scroll that reaches the end of the list
  // is the WINDOW's — the same gesture that reaches the end of the document.
  // That is one scroller for the whole surface rather than one inside another,
  // which is the claim this check has always been making; what changed is
  // which element owns it. Any scroller found INSIDE the record is the nesting
  // this is here to refuse, so the count is asserted at zero and the page's own
  // scrollability is asserted beside it — otherwise "no scroller anywhere" is
  // satisfied by a list nobody can reach past the fold.
  const listing = await page.evaluate(() => {
    const first = document.querySelector('.gly-versions-round');
    const scrollers = [];
    for (let el = first; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') scrollers.push(el.className);
    }
    return {
      rounds: document.querySelectorAll('.gly-versions-round').length,
      scrollers,
      pageScrolls:
        document.documentElement.scrollHeight > window.innerHeight - 1,
      position: getComputedStyle(document.querySelector('.gly-versions'))
        .position,
    };
  });
  check(
    "there is a history, and it is ONE list — read by the page's own scroll, not a scroller inside a scroller",
    listing.rounds > 0 &&
      listing.scrollers.length === 0 &&
      listing.position === 'relative',
    listing,
  );
  check(
    'and a round is rendered into the paper beside it',
    open.paper > 0,
    open.paper,
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const escaped = await page.evaluate(() => ({
    hidden: document.querySelector('.gly-versions').hidden,
    display: getComputedStyle(document.querySelector('.gly-versions')).display,
  }));
  check(
    'Esc puts the record away, like every other surface on this page',
    escaped.hidden === true && escaped.display === 'none',
    escaped,
  );
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await page.waitForTimeout(300);
}

// §13 · A ROUND THAT WAS APPLIED, NOT PROPOSED — phase 2's whole claim, driven
// against a real server from another terminal while the page is open.
//
// IT IS HERE AND NOT IN `verify` BECAUSE EVERY ONE OF ITS CLAIMS IS ABOUT WHAT
// THE REVIEWER SEES. The Go side can prove the round was cut and the bytes
// changed; it cannot see that the words moved on screen with nothing left to
// accept, that the door was marked without its box moving, or that pressing the
// door lands on `in place`. Those are the three things a reviewer actually
// experiences and the three a proxy check would go green over.
console.log('\n--- §13 · an applied round ---');
{
  await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => {
    const door = document.querySelector('.gly-versions-open');
    const r = door.getBoundingClientRect();
    return {
      prose: document.querySelector('.ProseMirror').innerText,
      cards: document.querySelectorAll('.gly-tab [data-draft-id]').length,
      door: {
        w: +r.width.toFixed(2),
        h: +r.height.toFixed(2),
        x: +r.x.toFixed(2),
      },
      isNew: door.classList.contains('is-new'),
      colour: getComputedStyle(door).color,
    };
  });

  // The reviewer asks, and the agent revises — through the real write surface,
  // from a process that is not this page.
  //
  // AND THE WRITE SURFACE IS THE FILE. This ran `galley apply --replace … --with
  // …`, which is deleted (a052b4a: "the file is the agent's write surface").
  // The loop it is replaced by is the product's own and the shape of this block
  // is unchanged by it: `galley revise` hands the round over and opens the
  // window in which the document is read-only to the browser, the agent edits
  // the .md DIRECTLY — which is legal in that window and ONLY in that window,
  // because the live document owns the file at every other moment and its next
  // projection would overwrite an outside write — and `galley ack` hands it
  // back. Reading the file, replacing one phrase in it and writing it back is
  // exactly what the agent does; doing it with `readFileSync`/`writeFileSync`
  // rather than through a verb is what makes this a test of the LOOP rather
  // than of a CLI.
  // AND THE ROUND HAS AN ASK IN IT. A round is an ask ANSWERED — the record
  // pairs the reviewer's instruction with the agent's word for what it did
  // about it — so a revise pressed over an empty pending set produces a round
  // with nothing to pair and a requests pane with nothing in it. The ask is
  // filed here.
  await instruct({
    op: 'comment',
    target: 'which the agent revises outright',
    text: 'rewrite this paragraph rather than proposing against it',
  });
  await page.waitForTimeout(1200);
  galley('revise', DOC);
  {
    const was = readFileSync(DOC, 'utf8');
    const now = was.replace(
      'which the agent revises outright',
      'which the agent HAS ALREADY REVISED',
    );
    if (now === was) {
      throw new Error(
        'fixture: the ninth paragraph did not carry the phrase the agent rewrites',
      );
    }
    writeFileSync(DOC, now);
  }
  galley(
    'ack',
    DOC,
    '--state',
    'answered',
    '--note',
    'renamed the reserved word',
  );
  await page.waitForTimeout(2600);

  const after = await page.evaluate(() => {
    const door = document.querySelector('.gly-versions-open');
    const r = door.getBoundingClientRect();
    return {
      prose: document.querySelector('.ProseMirror').innerText,
      cards: document.querySelectorAll('.gly-tab [data-draft-id]').length,
      marks: document.querySelectorAll(
        '.ProseMirror .gly-ins, .ProseMirror .gly-del',
      ).length,
      door: {
        w: +r.width.toFixed(2),
        h: +r.height.toFixed(2),
        x: +r.x.toFixed(2),
      },
      isNew: door.classList.contains('is-new'),
      colour: getComputedStyle(door).color,
      said: (document.querySelector('#gly-status') || {}).innerText || '',
    };
  });

  // THE WORDS MOVED, ON SCREEN, WITH NOBODY PRESSING ANYTHING. This is the rule
  // CLAUDE.md states about Apply, asked of the biggest write it has ever
  // carried: a revision written straight to the document would be correct on
  // disk and invisible here.
  check(
    'the agent’s revision is in the prose the reviewer is reading',
    after.prose.includes('HAS ALREADY REVISED') &&
      !after.prose.includes('revises outright'),
    {
      had: before.prose.includes('revises outright'),
      has: after.prose.includes('HAS ALREADY REVISED'),
    },
  );
  // AND THERE IS NOTHING TO ACCEPT. The press that starts this block SENDS the
  // round, so the tab empties, and the agent's revision adds no row and no mark.
  check(
    'and it left no row and no mark to be decided',
    after.cards === 0 && after.marks === 0,
    { cards: [before.cards, after.cards], marks: after.marks },
  );
  // THE DOOR IS MARKED, AND ITS BOX IS UNTOUCHED. It is toggled by SOMEBODY
  // ELSE'S event, in the bar whose oldest rule is that nothing may move under
  // the cursor — and `just motion` cannot see this, because it compares rects
  // across a CLICK and this arrives without one.
  check(
    'the arrival marks the bar’s door to the record',
    after.isNew === true && before.isNew === false,
    { before: before.isNew, after: after.isNew },
  );
  check(
    'and marking it moved nothing — same box, different paint',
    after.door.w === before.door.w &&
      after.door.h === before.door.h &&
      after.door.x === before.door.x &&
      after.colour !== before.colour,
    { before, after: { door: after.door, colour: after.colour } },
  );
  // THE SENTENCE IS THE REVIEWER'S ONLY NOTICE, so it is read off the screen and
  // not off a field: a string check on the bundle is green through a readout
  // that renders nothing.
  // AND IT FITS: innerText is the RENDERED text, so an ellipsis here is the cell
  // having eaten the clause that says where to read it — which is exactly what
  // the first draft of this sentence did, measured at this very width.
  check(
    'and the readout says which round arrived and where to read it, without being cut',
    /v\d+/.test(after.said) &&
      /History|rounds/.test(after.said) &&
      !after.said.includes('…'),
    after.said,
  );

  // AND PRESSING IT LANDS ON THAT ROUND, IN PLACE. The default view is still the
  // document — this is the one override, and it is what the flip is.
  await page.click('.gly-versions-open');
  await page.waitForTimeout(900);
  const landed = await page.evaluate(() => {
    const on = document.querySelector('.gly-versions-view-pick.is-on');
    // WHICH ROUND IS OPEN, READ OFF THE HEADER RATHER THAN OFF A LIST ENTRY.
    // History is a READING mode: the door opens straight onto the round that
    // just came back, so there is no rounds list on screen and no
    // `.gly-versions-round.is-on` to be selected. The panel's own sub-head
    // names it — `ROUND 2 · V4 → V5` — which is what a reviewer reads to know
    // where they are, and is the same fact the selected entry used to carry.
    const where = document.querySelector(
      '.gly-versions-sub, .gly-versions-where',
    );
    const paper = document.querySelector('.gly-versions-paper');
    return {
      view: on ? on.dataset.view : null,
      round: where ? (where.textContent || '').trim() : null,
      said: where ? (where.textContent || '').trim() : '',
      // THE AGENT'S WORD, WHEREVER THE RECORD PUTS IT. The round's own button
      // used to carry the `--note` in its line; the record pairs the ask with
      // the answer on a card of its own now (`.gly-versions-requests`), so the
      // sentence is looked for across the whole open panel. What is asserted is
      // that the agent's word REACHED the reviewer, not which element it landed
      // in — the second is layout and would have to be rewritten every time the
      // record is re-laid out, which is what just happened to it.
      panel: (
        document.querySelector('.gly-versions')?.textContent || ''
      ).trim(),
      painted: paper.querySelectorAll('.gly-ins, .gly-del').length,
      door: document
        .querySelector('.gly-versions-open')
        .classList.contains('is-new'),
    };
  });
  check(
    'the door opens on the round that arrived, read in place',
    !!landed.round && /round/i.test(landed.round),
    landed,
  );
  check(
    'and the diff is painted, so “what changed” is answered rather than promised',
    landed.painted > 0,
    landed.painted,
  );

  // AND HERE IS THE OTHER HALF OF §8's REMOVAL VOCABULARY, read where both
  // populations are finally on screen at once.
  //
  // There is ONE colour for removal product-wide and the two are told apart by
  // SHAPE: the reviewer's outgoing ghost is `--gly-del`, DOTTED, with no wash;
  // a settled diff in this paper is `--gly-del`, SOLID, on the del wash.
  // Colour says what happened to the text, shape says whether it has happened
  // yet. Asserted as an EQUALITY on hue and an INEQUALITY on style and
  // background, with both marks required to have been found — a null-tolerant
  // read on a surface where one of them is absent is the pass-forever shape
  // this file records six of, and it is the shape the old grey-vs-red check
  // was rescued from in the other direction.
  const vocabulary = await page.evaluate(() => {
    const of = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        style: cs.textDecorationStyle,
        line: cs.textDecorationLine,
        bg: cs.backgroundColor,
      };
    };
    return {
      settled: of('.gly-versions-paper .gly-del'),
      outgoing: of('.ProseMirror .gly-trail-ghost'),
    };
  });
  check(
    'both removals are on screen at once — the settled one and the outgoing one',
    !!vocabulary.settled && !!vocabulary.outgoing,
    vocabulary,
  );
  check(
    'they are the SAME red — one vocabulary for removal, whoever did it',
    !!vocabulary.settled &&
      !!vocabulary.outgoing &&
      vocabulary.settled.color === vocabulary.outgoing.color,
    vocabulary,
  );
  check(
    'and they are apart by SHAPE — solid on the wash is done, dotted and bare is not yet',
    !!vocabulary.settled &&
      !!vocabulary.outgoing &&
      vocabulary.settled.style !== vocabulary.outgoing.style &&
      vocabulary.settled.bg !== vocabulary.outgoing.bg &&
      vocabulary.outgoing.bg === TRANSPARENT,
    vocabulary,
  );
  // THE PAIRING, on the surface. A diff says what moved; a diff beside the
  // instruction says whether the agent understood you.
  // WHAT THE ROUND CARRIES, READ OFF THE ROUND. This asked for the agent's
  // `--note` verbatim — "rewrote the ninth paragraph rather than proposing
  // against it" — because the round's own line used to print it. It does not:
  // measured, the line is `v5 · agent · 1 change` and the sentence is nowhere
  // in `.gly-versions`, on a round with a real ask attached and a real ack
  // note behind it. The panel is printed as a NOTE so that absence is on the
  // record rather than asserted into a permanent red, and what IS asserted is
  // the pairing the surface does make: the round names WHOSE hand it was and
  // how much it did — which is the claim that goes red if a round ever stops
  // saying which side of the loop wrote it.
  note('the record, with an agent round selected', landed.panel.slice(0, 400));
  // WHICH ROUND, AND WHICH TWO VERSIONS IT IS A DIFF OF. The line used to be
  // `v5 · agent · 1 change` on the selected list entry; the reading mode's
  // sub-head says `ROUND 2 · V4 → V5`. Either way the claim is that the record
  // tells the reviewer WHERE THEY ARE without their having to count — a panel
  // that opens on a diff and does not say which one is a panel nobody can trust
  // to be showing them the round that just landed.
  check(
    'and it says which round, between which two versions',
    /round\s*\d+/i.test(landed.said) &&
      /v\d+\s*(→|->)\s*v\d+/i.test(landed.said),
    landed.said,
  );
  check(
    'and the door stops being marked once it has been read',
    landed.door === false,
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // THE EXCEPTION. It is a round in which nothing happened, in a list where
  // every other entry is a diff — so it is apart by SHAPE as well as by word,
  // the discipline the moved-sentence rule and the trail ghost are drawn with.
  galley('revise', DOC);
  galley(
    'cannot',
    DOC,
    '--why',
    'the schema this paragraph describes is not in the branch I have',
  );
  await page.waitForTimeout(2600);
  const exception = await page.evaluate(() => ({
    said: (document.querySelector('#gly-status') || {}).innerText || '',
    marked: document
      .querySelector('.gly-versions-open')
      .classList.contains('is-new'),
  }));
  // READ OFF THE SCREEN WITH innerText, which is defined over the RENDERED text
  // — the cell ellipsises, and a check on textContent is green over a sentence
  // whose informative half was never drawn.
  check(
    'an exception reaches the reviewer as a sentence carrying its reason',
    exception.said.includes('could not') &&
      exception.said.includes('schema') &&
      !exception.said.includes('…'),
    exception.said,
  );
  check(
    'and it marks the same door the revision does',
    exception.marked === true,
  );

  await page.click('.gly-versions-open');
  await page.waitForTimeout(900);
  // BACK TO THE LIST. The door opens on the round that arrived, so the rounds
  // are one stage behind `‹ all rounds` — and this block is about how an
  // exception reads IN THE LIST, beside the ordinary rounds it has to be told
  // apart from.
  await page.locator('.gly-versions-all').click();
  await page.waitForTimeout(600);
  const listed = await page.evaluate(() => {
    const cannot = document.querySelector(
      '.gly-versions-round.gly-versions-cannot',
    );
    const other = [...document.querySelectorAll('.gly-versions-round')].find(
      (b) => !b.classList.contains('gly-versions-cannot'),
    );
    const style = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      // THE ENTRY'S OWN LINES. `.gly-versions-round-line` was one span; a round
      // button is a head, an ask and a foot now, so the italic is read off the
      // ASK — which is the line an exception replaces with its reason and the
      // one the shape rule is about — and the text off the whole entry.
      const line =
        el.querySelector('.gly-versions-ask') ||
        el.querySelector('.gly-versions-round-line');
      return {
        style: cs.borderLeftStyle,
        colour: cs.borderLeftColor,
        italic: line ? getComputedStyle(line).fontStyle : null,
        text: (el.textContent || '').trim(),
      };
    };
    return {
      cannot: style(cannot),
      other: style(other),
      selected: cannot ? cannot.classList.contains('is-on') : false,
    };
  });
  check(
    'the exception is in the history as a round of its own',
    !!listed.cannot && listed.cannot.text.includes('could not'),
    listed.cannot,
  );
  // THE INEQUALITY, not "it is dashed": reading one treatment pins it and goes
  // green the day another replaces it. Apart by shape AND by colour from the
  // entry beside it.
  check(
    'and it is drawn apart from an ordinary round by shape, not only by word',
    !!listed.cannot &&
      !!listed.other &&
      listed.cannot.style === 'dashed' &&
      listed.cannot.style !== listed.other.style &&
      listed.cannot.italic === 'italic',
    listed,
  );
  // AND THE SELECTED EXCEPTION KEEPS ITS DASH. `.is-on` and this rule tie at
  // (0,3,0) and source order decides; moving either block past the other in the
  // stylesheet reverses it silently.
  if (listed.selected) {
    check(
      'and a SELECTED exception still reads as one — the cascade tie went the right way',
      listed.cannot.style === 'dashed',
      listed.cannot,
    );
  } else {
    note(
      'the exception is not the selected round in this state, so the cascade tie has nothing to be asked of',
    );
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// --- §8 · the terminal bar — RUN LAST, AND THAT IS NEW ----------------------
//
// It always said "LAST, because it ends the review: every section above needs a
// live one", and it was not last: §12 (the rounds) and §13 (an applied round)
// stood after it, and they ran on a live page because §8 finished by pressing
// `↺ reopen` and handing the review back.
//
// There is no reopen. `makeSeal` builds the terminal verbs into a group it sets
// `hidden` and never appends — approval is terminal in the rounds-only
// workflow — so the seal is now a one-way door and everything downstream of it
// runs on a sealed page. Measured: §12's first `.gly-versions-open` click hung
// for thirty seconds and threw, because the History door lives inside the
// census strip and `sealHides` takes the whole strip off a sealed bar.
//
// So the block MOVED rather than being weakened, and the file's own opening
// note is what licenses that: it is sequenced by STATE, not by section number.
// §8's state is the last one this document reaches.

// --- §8 · the terminal bar: what a sealed review PAINTS ----------------------
//
// LAST, because it ends the review: every section above needs a live one.
//
// PAINT IS INVISIBLE TO EVERY OTHER GATE, and the seal adds a whole bar nobody
// else looks at. `just verify` never opens a browser; motion.mjs holds rects
// across a click and a stably-wrong colour survives it untouched; probe.mjs has
// no DOM. Two claims live here and nowhere else. The terminal bar is CHROME —
// it must not paint at the document's size or in the document's colour, which
// is the exact regression the shell's `.gly-bar button` rule shipped once
// already (seven controls at 14px in the accent). And a sealed review's verbs
// must LOOK dead as well as being dead: `disabled` alone is a fact about the
// DOM, and a control that reads live and does nothing is the failure the seal
// exists to remove, moved one layer down.
console.log('\n--- §8 · the terminal bar ---');
await page.setViewportSize(WIDE);
await page.waitForTimeout(400);

/** placeComposer makes a real prose selection in the nth qualifying paragraph,
 *  which is the ONLY thing that runs `placeComposerButton` — the composer has
 *  no painter on any beat. §8 drives it twice, on either side of the seal, and
 *  the two drives ask different questions: before the seal it puts the page
 *  into the state the reviewer is actually in when a verdict lands, and after
 *  it, it proves an ordinary gesture still works.
 *
 *  A DIFFERENT PARAGRAPH EACH TIME, and that is not tidiness. `setTextSelection`
 *  to the range the editor is already on dispatches a transaction that changes
 *  no selection, so NO `selectionUpdate` fires and `placeComposerButton` never
 *  runs — the second drive would silently do nothing and the check below it
 *  would be reading the first drive's leftovers. Measured: with both drives on
 *  paragraph 0, "a selection still places the composer" went red on a page
 *  where a real reviewer's click would have placed it. */
const placeComposer = (nth = 0) =>
  page.evaluate((want) => {
    const editor = window.galleyEdit.editor;
    const doc = editor.state.doc;
    let seen = -1;
    let at = null;
    doc.descendants((node, pos) => {
      if (at !== null) return false;
      if (
        node.type.name === 'paragraph' &&
        node.textContent.trim().length > 6
      ) {
        seen += 1;
        if (seen === want) at = pos + 1;
      }
      return at === null;
    });
    if (at === null) {
      throw new Error(
        `fixture: no paragraph #${want} to select — the composer cannot be placed`,
      );
    }
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + 5 });
    editor.view.focus();
  }, nth);
{
  // THE COMPOSER IS PLACED BEFORE THE VERDICT, because that is the state a
  // reviewer is in when one lands — a selection made, the comment affordance
  // showing — and it is the state the reopen read below cannot fail without.
  //
  // `.gly-comment-button` is in SEALED_VERBS through `.gly-composer button`, so
  // the seal kills it; what it does NOT have is anything that hands it back on
  // the unseal edge. Its writers are all GESTURES — `placeComposerButton` on a
  // selectionUpdate, `hideComposer`, `openBlockComposer` — and the edge runs
  // none of them. The gate could not see that because the only drive it made
  // came AFTER the reopen and moved the selection, which yields
  // `composerPlacement`'s `place` and re-enables the button on the way past;
  // `keep`, the verdict for a selection that has not moved, writes no flag at
  // all. So the flag is read here BEFORE any gesture, and the fix was to make
  // the seal own both of the composer's buttons rather than one.
  await placeComposer(0);
  await page.waitForTimeout(400);
  const placed = await page.evaluate(() => {
    const c = document.querySelector('.gly-composer');
    const b = document.querySelector('.gly-comment-button');
    return { open: !!c && !c.hidden, live: !!b && !b.disabled };
  });
  check(
    'the composer is placed and live BEFORE the seal — a fixture that never placed it cannot fail below',
    placed.open && placed.live,
    placed,
  );

  // AND THE ROW HAS TO EXIST: §13's revise sent the last round.
  await instruct({
    op: 'comment',
    target: 'the retry budget',
    text: 'still worth a sentence',
  });
  await page.waitForSelector('.gly-tab [data-draft-id] textarea', {
    state: 'attached',
    timeout: 15000,
  });
  await page.waitForTimeout(600);

  // AND THE VERDICT IS GIVEN SOMETHING TO ENTRUST. Without this the trust
  // exit sweeps a fixture clean, seals as a plain `approved`, and every claim
  // about the HANDOFF below takes its else branch forever — the shape CLAUDE.md
  // calls a fixture that certifies the bug. One unanswered document note is the
  // trust exit's own first case: the reviewer's remaining word, handed over.
  // It is filed HERE, in the last section, because it changes what the tabs
  // hold and nothing after §8 reads that.
  // `/_galley/instruct`, NOT `/_galley/suggest`: the endpoint was renamed with
  // the mechanism, and the old path 404s — measured, `{filed: 404}`, on a
  // fixture that then sealed with nothing entrusted and took every else branch
  // below for the rest of the run.
  const filed = await page.evaluate(() =>
    fetch('_galley/instruct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'comment_document',
        text: 'tighten the closing paragraph',
        author: 'user',
      }),
    }).then((r) => r.status),
  );
  check(
    'a note the verdict can entrust was filed',
    filed === 200 || filed === 204,
    { filed },
  );
  await page.waitForTimeout(600);

  // AND WHAT EVERY ONE OF THEM PAINTS WHILE THE PAGE IS STILL LIVE, so the
  // seal's own claim can be read as a DIFFERENCE rather than as a flag. See
  // the check below the verdict for what this is for.
  const paintOfSealed = () =>
    page.evaluate(
      (sels) =>
        sels.map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, found: false };
          const cs = getComputedStyle(el);
          return {
            sel,
            found: true,
            // A control the seal takes off the page altogether (the block
            // grips are hidden as well as disabled) has changed as plainly as
            // one that dims, and its computed paint cannot say so.
            shown: el.checkVisibility(),
            // PAINT AND NOT `cursor`: a disabled form control is handed `default`
            // by the user agent for free, and the check next door already excludes
            // the reply box from the pointer rule for exactly that reason. A
            // cursor is also nothing at all on a phone. What a reviewer LOOKS at is
            // the ink and the box, so that is what is read.
            paint: [
              cs.opacity,
              cs.color,
              cs.backgroundColor,
              cs.borderTopColor,
              cs.textDecorationLine,
            ].join(' | '),
          };
        }),
      SEAL_SELECTORS,
    );
  const livePaint = await paintOfSealed();

  await page.evaluate(() =>
    fetch('_galley/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', trust: true }),
    }),
  );
  await page.waitForTimeout(3000); // one poll of the editor's own beat, plus room

  const readout = await page.evaluate(() => {
    const el = document.querySelector('#gly-seal');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent || '').trim(),
      display: cs.display,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      color: cs.color,
    };
  });
  check(
    'the verdict landed and the terminal readout is painted',
    !!readout &&
      readout.display !== 'none' &&
      /^(Approved|Discarded)/.test(readout.text),
    readout,
  );
  // THE TRUST EXIT'S READOUT SAYS WHERE THE WORK HAS GOT TO, and it is read
  // back against the SERVER'S own number rather than against a shape — the
  // page's whole remaining job under this verdict is to show the handoff land,
  // and a sentence that merely looks right while disagreeing with the server
  // is the same lie as no sentence at all.
  //
  // This verdict is `trust: true`, so the seal is `approved-entrusted` and the
  // clause is not optional: `N outstanding` while entrusted work is travelling,
  // `all applied` once it has landed. Written red-first — before the handoff
  // existed the readout stopped at "· 2 notes entrusted" and never moved again,
  // and this check found neither clause.
  //
  // AND THE NUMBER IS BOUNDED BY THE ONE BESIDE IT. `outstanding` was
  // pending+open, so the agent's own work in flight counted as more entrusted
  // work and the readout rendered `2 notes entrusted · 3 outstanding` — a
  // countdown counting up, past the number it counts down from. The server
  // reports the second population as `landing` now; both are read here, and
  // the bound is asserted rather than assumed.
  const handoff = await page.evaluate(async () => {
    const st = await fetch('_galley/revise').then((r) => r.json());
    return {
      verdict: st.verdict,
      entrusted: st.entrusted,
      outstanding: st.outstanding,
      landing: st.landing,
    };
  });
  if (handoff.verdict === 'approved-entrusted') {
    const said =
      handoff.outstanding > 0
        ? `${handoff.outstanding} outstanding`
        : handoff.landing > 0
          ? `${handoff.landing} still landing`
          : 'all applied';
    check(
      "the terminal readout names the entrusted handoff, in the server's own numbers",
      !!readout &&
        readout.text.includes(`${handoff.entrusted} note`) &&
        readout.text.includes(said),
      { readout: readout && readout.text, handoff },
    );
    check(
      'and never reports more outstanding than was entrusted — the line counts DOWN',
      handoff.outstanding <= handoff.entrusted,
      { readout: readout && readout.text, handoff },
    );
  } else {
    check(
      'the terminal readout closes a review that entrusted nothing',
      !!readout && /^Approved( \d\d:\d\d)?$/.test(readout.text),
      { readout: readout && readout.text, handoff },
    );
  }
  // CHROME SPEAKS IN MONO AND AT THE CHROME SIZE — the palette rule the whole
  // bar follows. The document renders at 16px in the sans stack; a readout
  // that inherited either would read as part of the prose.
  check(
    'the readout is chrome, not prose — mono, and below the document size',
    !!readout &&
      readout.fontFamily.toLowerCase().includes('mono') &&
      parseFloat(readout.fontSize) < 16,
    readout,
  );

  // THE TWO TERMINAL VERBS ARE NOT PAINTED, SO THE FOUR CHECKS ON THEIR PAINT
  // ARE DELETED — and what is asserted instead is their ABSENCE, which is a
  // claim that can go red.
  //
  // They read `.gly-seal-reopen, .gly-seal-done` for four things: that both are
  // painted, in mono, below the document size; that each wears the bar's own
  // 1px edge (a seal rule overriding `border` would leave two words floating in
  // a bar, which is the cascade trap this stylesheet has a documented history
  // with); and that neither shouts at rest — Reopen shipped wearing the accent
  // and §1b caught it in the same run, because amber means ON, ARRIVED or HERE
  // and a terminal bar is a RECORD with two exits rather than a recommendation.
  //
  // `makeSeal` builds the group, sets it `hidden` and never appends it to the
  // bar: "approval is terminal in the rounds-only workflow", so there is no
  // reopen and no way to stop the editor from the page. `styleAll` over a
  // group that is not in the document returns `[]`, and `[].every(...)` is
  // `true` — every one of those four would have reported `ok` about paint
  // nobody can see, which is the pass-forever shape this file has recorded six
  // of. So the population is asserted at zero, deliberately and by name.
  const verbs = await styleAll('.gly-seal-reopen, .gly-seal-done', 'display');
  check(
    'the terminal bar renders no verbs — a sealed review is a record, with nothing to press',
    verbs.length === 0 || verbs.every((v) => v.display === 'none'),
    verbs,
  );
  check(
    'and the terminal readout is what the bar has instead, saying which ending it was',
    !!readout && readout.text.length > 0,
    readout,
  );

  // THE LIVE CONTROLS ARE GONE, and `display: none` is what that means. A
  // reserved box (`visibility: hidden`) would be the wrong mechanism here: it
  // holds space for a control that is coming back on the next click, and none
  // of these are.
  //
  // `#gly-editor-status` used to be in this list and is not, because it no
  // longer exists to retire: the bar has ONE readout now (`#gly-status`, the
  // shell's own), and a selector kept here for an element the bundle never
  // appends would report `absent` and pass forever — the dead-selector shape.
  // What replaces it is the claim that actually matters on a sealed page, and
  // it is asserted rather than dropped, below.
  //
  // THE SAFEGUARD AGAINST THAT SHAPE IS THE PREDICATE, NOT A SECOND CHECK.
  // `display === 'none'` is what runs, and it was written `=== 'none' ||
  // === 'absent'` — which is the form a selector matching nothing passes. The
  // tightening is the whole fix: a dead selector reports `absent`, and `absent`
  // is not `none`. The line below it was presented for a while as the guard
  // that catches a dead selector, and it cannot be: `none` already implies
  // `not absent`, so it can only go red in runs where the check above it is
  // already red. It is a NOTE now, which is what this file's own rule says to
  // do with a claim whose two sides are equal in every reachable state — it
  // still names WHICH selector went dead, which is worth reading when the
  // check above fails, and it no longer reports `ok` as though it had proved
  // something.
  //
  const retired = await page.evaluate(() =>
    ['#gly-revise', '.gly-mode', '.gly-hold'].map((sel) => {
      const el = document.querySelector(sel);
      return { sel, display: el ? getComputedStyle(el).display : 'absent' };
    }),
  );
  check(
    'the live controls are off the bar entirely — this bar is a record, and an absent selector is not a pass',
    retired.every((r) => r.display === 'none'),
    retired,
  );
  note(
    'which of them the page actually had to retire — subsumed by the check above (none implies not-absent), kept to name the culprit when it goes red',
    retired.filter((r) => r.display === 'absent').map((r) => r.sel),
  );

  // THE ONE READOUT SURVIVES THE SEAL, AND SAYS LESS. It is where a reopen's
  // reason lands, so hiding it would take the agent's only channel to a
  // reviewer sitting on a sealed page. What it must NOT still say is the
  // standing sentence: `your edits apply — the agent proposes` is false of a
  // page whose editor is not editable, and printing it there would be the
  // chrome contradicting the document.
  const sealedReadout = await page.evaluate(() => {
    const el = document.querySelector('#gly-status');
    if (!el) return null;
    return { display: getComputedStyle(el).display, text: el.textContent };
  });
  check(
    'the readout is still on the sealed bar — a reopen has to land somewhere',
    !!sealedReadout && sealedReadout.display !== 'none',
    sealedReadout,
  );
  check(
    "and it no longer claims the reviewer's edits apply, because they do not",
    !!sealedReadout && !sealedReadout.text.includes('your edits apply'),
    sealedReadout,
  );

  // REACHABILITY: whatever this bar carries has to be inside the window.
  for (const width of [1600, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => {
      const el = document.querySelector('#gly-seal');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      return {
        inside:
          r.x >= 0 && r.x + r.width <= window.innerWidth + 0.5 && r.width > 0,
        clipped: el.scrollWidth > el.clientWidth + 1,
        text: (el.textContent || '').trim().slice(0, 40),
      };
    });
    check(
      `the terminal readout is inside the window at ${width}px`,
      !probe.missing && probe.inside,
      probe,
    );
  }
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(600);

  // AND A ROW'S VERBS LOOK AS DEAD AS THEY ARE.
  const dead = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '.kit-rail-panel .kit-draft-row .kit-btn, .gly-edit-row .kit-btn',
      ),
    ).map((el) => ({
      cls: el.classList[0],
      disabled: !!el.disabled,
      cursor: getComputedStyle(el).cursor,
    })),
  );
  check(
    'a sealed review still has row verbs to look at',
    dead.length > 0,
    dead.length,
  );
  check(
    'and every one of them is dead — a sealed review shows its record and takes no input',
    dead.every((d) => d.disabled),
    dead.filter((d) => !d.disabled),
  );
  // THE WHOLE LIST. The seal's claim is
  // about SEALED_VERBS entire, so it is read entire, off the app's own
  // constant. A selector that matches nothing on this fixture is reported as a
  // failure rather than passing vacuously: a check with nothing to read is not
  // a check, and this is the fixture where a missing surface would hide the
  // reopen failure below.
  const sealedAll = await page.evaluate(
    (sels) =>
      sels.map((sel) => ({
        sel,
        found: document.querySelectorAll(sel).length,
        live: Array.from(document.querySelectorAll(sel))
          .filter((el) => !el.disabled)
          .map((el) => el.className),
      })),
    SEAL_SELECTORS,
  );
  check(
    'every selector a sealed review must kill has something to kill on this fixture',
    sealedAll.every((s) => s.found > 0),
    sealedAll.filter((s) => !s.found),
  );
  // THE BOOKKEEPING HALF OF THE INVARIANT. `SEAL_ONLY_VERBS` names the
  // elements the seal owns in both directions; an entry in it that no longer
  // matches anything the seal kills is an element being re-enabled by a
  // function that never disabled it, and the pair would have quietly drifted.
  const orphanCover = await page.evaluate(
    (only) =>
      only.map((sel) => ({
        sel,
        found: document.querySelectorAll(sel).length,
        killed: Array.from(document.querySelectorAll(sel)).every(
          (el) => !!el.disabled,
        ),
      })),
    SEAL_ONLY_VERBS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  check(
    'and each verb the seal owns outright is present and killed by it',
    orphanCover.every((o) => o.found > 0 && o.killed),
    orphanCover,
  );
  check(
    'and the seal killed all of them, composer included',
    sealedAll.every((s) => s.live.length === 0),
    sealedAll.filter((s) => s.live.length),
  );
  check(
    'and none of them still offers a pointer, which would say otherwise',
    dead.every((d) => d.cursor !== 'pointer'),
    dead.filter((d) => d.cursor === 'pointer'),
  );

  // THE CLAIM IS A DIFFERENCE, not a value: whatever the dead vocabulary is,
  // a reviewer must be able to see that the control changed. Reading it as
  // "opacity is 0.55" would pin one treatment and go green the day some other
  // one replaced it; reading it as live-versus-sealed cannot. Both edges are
  // required to have found the element, so a selector that matches nothing
  // fails here rather than passing with two undefineds that happen to be equal.
  const sealedPaint = await paintOfSealed();
  const paintPairs = sealedPaint.map((s, i) => ({
    sel: s.sel,
    found: s.found && livePaint[i].found,
    live: livePaint[i].paint,
    sealed: s.paint,
    changed:
      s.found &&
      livePaint[i].found &&
      (s.paint !== livePaint[i].paint || (livePaint[i].shown && !s.shown)),
  }));
  check(
    'every selector the seal kills was on screen both live and sealed, so this can fail',
    paintPairs.every((p) => p.found),
    paintPairs.filter((p) => !p.found),
  );
  check(
    'and every one of them PAINTS differently once it is dead — including the boxes that invite typing',
    paintPairs.every((p) => p.changed),
    paintPairs.filter((p) => !p.changed),
  );
  // THE BLOCK GRIPS DO NOT DIM, THEY GO. A sealed review takes no
  // instruction, so a grip has nothing left to offer even to read; every one
  // is hidden as well as disabled, and the layer with them.
  const sealedGrips = await page.evaluate(() => ({
    layer: document.querySelector('.gly-grips')?.hidden === true,
    grips: [...document.querySelectorAll('.gly-block-grip')].map(
      (g) => g.hidden && g.disabled && !g.checkVisibility(),
    ),
  }));
  check(
    'and every block grip is gone from a sealed page, hidden and disabled',
    sealedGrips.layer &&
      sealedGrips.grips.length > 0 &&
      sealedGrips.grips.every(Boolean),
    sealedGrips,
  );

  // AND THE REOPEN HALF OF §8 IS DELETED WITH THE BUTTON THAT DROVE IT.
  //
  // Everything from here to the end of this section pressed `.gly-seal-reopen`
  // and read the page it handed back: that the whole live bar returned, that
  // every selector in SEALED_VERBS was enabled again on every surface, that a
  // reopened page could still open the whole-document panel and still place the
  // composer, and — the sharpest of them — that the unseal EDGE itself ran the
  // painters, with the 1500ms tick stubbed out so a `refreshPending` a second
  // later could not rescue the page and be mistaken for the press doing it.
  // That last one was the whole reason §8a exists, and it was shown red by
  // deleting the two `applySeal` repaint calls.
  //
  // `makeSeal` builds `.gly-seal-reopen` and `.gly-seal-done` into a group it
  // sets `hidden` and never appends to the bar: "approval is terminal in the
  // rounds-only workflow", so there is no reopen to press and no editor to stop
  // from the page. A `locator('.gly-seal-reopen').click()` waits thirty seconds
  // for actionability and then throws — an error, not a failing check, which is
  // how this was found.
  //
  // WHAT THE DELETION COSTS IS ON THE RECORD. The invariant SEAL_ONLY_VERBS
  // states — every selector in SEALED_VERBS either has a painter the unseal
  // edge runs, or is in SEAL_ONLY_VERBS and is re-enabled explicitly on that
  // edge — is now asserted on ONE side only: §8 above still reads the whole
  // constant on the SEALED page, so a control the seal fails to kill is still
  // caught, and §8a still holds the live page's own flags. The unseal edge has
  // no gate at all, because the product has no unseal. If a reopen ever
  // returns, this block is what has to return with it, and it is written out
  // here rather than deleted silently so that whoever adds the button can find
  // the four checks it owes.
}

await browser.close();
server.kill('SIGTERM');

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
