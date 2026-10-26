package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// THE CLAIM LIST IS THE SINGLE SOURCE, AND IT LIVES HERE.
//
// This protocol has three carriers — `channelInstructions` (the MCP
// handshake), `agentPromptText` (the CLI cold start), and the plugin skill at
// plugin/galley/skills/reviewing-a-document/SKILL.md. Their PROSE differs by
// design: three media, three reading moments, and the skill is the one a
// paired session actually loads. Their CLAIMS must not differ at all.
//
// Before this file the list was spelled twice — once in agentprompt_test.go
// and once in pluginskill_test.go — while pluginskill_test.go's own header
// argued that a third list is a third thing to drift. Two lists is the same
// bet with better odds. Adding a claim to one did not add it to the others.
//
// Add a claim HERE and every carrier is held to it at once.
var fileEditLoopClaims = []string{
	// The file is the write surface, and the round is committed once.
	"edit", ".md", "save", "answered",
	// The exception still carries its reason.
	"galley cannot", "--why", "instruction",
	// THE KEY IS PART OF THE CONTRACT AND EVERY CARRIER MUST NAME IT. Both
	// carriers once told the agent to answer "by the key the round handed
	// you" while `instructionPayload` had no key field, so the round handed
	// over none and compliance was impossible — measured 2026-08-22 as 23
	// changes across three rounds carrying `answers` on none of them. The
	// data is there now; these two entries stop a carrier losing the
	// SENTENCE that points at it, which is the half that made the field
	// useless before. `[key` is the printed form the agent has to
	// recognise; `answers` is the field it copies it into.
	"[key", "answers",
	// NEVER REWRITE THE WHOLE FILE, and this is not style advice. The
	// reviewer edits the same .md in their browser WHILE the agent holds the
	// round, so the agent's copy is stale from the moment it reads. Measured
	// 2026-08-22: an agent answered a 21-instruction round with ONE write of
	// the entire document from the copy in its context, and a section the
	// reviewer had deleted in the previous round came back inside an 8k
	// expansion. Its write was correctly REJECTED with "modified since
	// read"; it re-read five lines to satisfy the tool and wrote the whole
	// file anyway.
	//
	// Telling the agent what the reviewer removed (which the round now does)
	// does NOT fix this on its own — a whole-file write clobbers those
	// passages whether or not the agent was told about them. Every carrier
	// has to say so, which is why it is pinned here.
	"targeted", "whole file", "stale",
	// A ROUND IS DELIVERED ONCE, AND THE WAY BACK TO IT HAS TO BE TAUGHT OR
	// IT IS A VERB NOBODY RUNS. `galley round` exists for the session whose
	// context was compacted, or which restarted, mid-review — which is not
	// hypothetical: the session that answered galley's own first real review
	// appears to have restarted, and muster warned about it by name. Every
	// carrier must name the verb AND warn off `pending`, because the natural
	// recovery instinct is to re-read pending and a sent round is not
	// pending.
	"galley round", "no longer pending",
	// ONE ACK, FOR THE WHOLE REVISION. This was a standalone assertion in
	// both predecessor tests, not part of either literal list, only because
	// it arrived by a different loop — it is the same kind of claim as every
	// other line here: the per-save ack is the six-rounds failure both
	// carriers exist to prevent.
	"once",
	// WHERE THE ROUND STANDS IS THE AGENT'S TO SAY. The page shows each Revise
	// as a pill with the agent's line under it, and the only way that line is
	// written is an ack: `working` first, with one line, on a round that takes
	// more than a moment; `declined` and `failed` settle it with why.
	"working", "one line", "declined", "failed",
}

// The per-change manifest: there is a list, each entry quotes what was
// written so galley can find it, and each names which instruction it answers.
var changeManifestClaims = []string{"changes", "quote", "which instruction", "key"}

// dropClaimSynonyms is the claim that a quote galley cannot place in the
// document is dropped SILENTLY — the reviewer sees no error — which is what
// stops an agent that guesses from inventing a location rather than
// reporting the miss. It was a standalone `Contains(lower, "ignore") ||
// Contains(lower, "drop")` in both predecessor tests: an EITHER, not two
// separate claims, because each carrier spells it its own way ("ignored" vs.
// "dropped"). assertTeachesAny is the OR-shaped sibling of assertTeaches for
// exactly this case.
var dropClaimSynonyms = []string{"ignore", "drop"}

// forbiddenClaims is the negative half of the gate: strings that must NOT
// appear in any carrier. It defends the applied-write surface. The old
// contract told the agent to "propose edits as tracked suggestions" and
// "never edit the .md" — correct under the old suggest/accept/reject loop,
// and exactly backwards once the agent edits the file directly and the round
// is committed by one ack. A carrier that still teaches the old verbs sends
// the agent reaching for a workflow that no longer exists; nothing to guess
// at, it will fail the moment it tries. Add a forbidden term HERE and every
// carrier is held to its absence at once.
var forbiddenClaims = []string{
	"galley apply", "--replace", "--after", "--insert", "--delete",
	"never edit the .md",
	"galley suggest", "galley accept", "galley reject", "galley approve <doc>",
	"galley decline", "galley reply", "galley resolve", "galley reopen", "entrusted",
	// `received` is no ack: that a round reached the agent is the harness's
	// to report.
	"received",
}

// assertTeaches fails for every claim the carrier does not make. It reports
// them all rather than stopping at the first, because a carrier that has
// drifted has usually drifted in more than one place.
func assertTeaches(t *testing.T, carrier, prose string, claims []string) {
	t.Helper()
	lower := strings.ToLower(prose)
	for _, want := range claims {
		if !strings.Contains(lower, want) {
			t.Errorf("%s never teaches %q", carrier, want)
		}
	}
}

// assertTeachesAny fails only if the carrier makes NONE of the given claims —
// the OR-shaped sibling of assertTeaches, for a claim different carriers are
// free to spell differently (one word or the other, not both).
func assertTeachesAny(t *testing.T, carrier, prose string, synonyms []string) {
	t.Helper()
	lower := strings.ToLower(prose)
	for _, want := range synonyms {
		if strings.Contains(lower, want) {
			return
		}
	}
	t.Errorf("%s teaches none of %q", carrier, synonyms)
}

// assertRefuses fails for every claim the carrier still makes that it must
// not. Reported all at once, for the same reason as assertTeaches: a carrier
// that has regressed to the old contract has usually regressed in more than
// one sentence.
func assertRefuses(t *testing.T, carrier, prose string, claims []string) {
	t.Helper()
	lower := strings.ToLower(prose)
	for _, gone := range claims {
		if strings.Contains(lower, gone) {
			t.Errorf("%s still teaches removed workflow %q", carrier, gone)
		}
	}
}

// pluginSkillGlob is every plugin skill's markdown, relative to this
// package's working directory. TestEveryCarrierIsCovered walks it with
// filepath.Glob rather than trusting a remembered count, for the same
// reason realCommands (pluginskill_test.go) reads main.go's switch instead
// of keeping a second copy of the command list: "a hand-maintained list
// would agree with the binary right up until somebody adds or removes a
// verb, which is the one moment this check exists for." A skill file is the
// equivalent moment for a carrier.
const pluginSkillGlob = "../../plugin/*/skills/*/SKILL.md"

// skillCarrierKey derives a carrier key from a discovered SKILL.md path,
// from the skill's own directory name.
func skillCarrierKey(path string) string {
	return "plugin-skill:" + filepath.Base(filepath.Dir(path))
}

// discoverPluginSkillCarriers globs every plugin skill file on disk and
// returns one reader per file, keyed by skillCarrierKey — each reader is a
// closure bound to THAT file's own path. This is the discovery half of
// TestEveryCarrierIsCovered: a skill added to disk gets a key AND a correctly
// bound reader with no second list for a human to remember to update, and
// with no reader for a human to misdirect at a sibling's file.
//
// Deriving the reader from the discovered path (rather than a hand-maintained
// key pointed at a shared reader) is the fix for F4, review 2026-08-25:
// `carriersUnderTest` used to hold one literal entry,
// "plugin-skill:reviewing-a-document" -> pluginSkill, where pluginSkill reads
// a hard-coded path. Adding a second skill's key by hand and pointing it at
// that same reader would have made TestEveryCarrierIsCovered pass while
// reading the first skill's file twice and leaving the new carrier's real
// content unbound — see TestPluginSkillCarriersReadTheirOwnFile, which pins
// exactly that failure mode against a throwaway second file.
func discoverPluginSkillCarriers(t *testing.T) map[string]func(t *testing.T) string {
	t.Helper()
	matches, err := filepath.Glob(pluginSkillGlob)
	if err != nil {
		t.Fatalf("globbing plugin skills (%s): %v", pluginSkillGlob, err)
	}
	if len(matches) == 0 {
		t.Fatal("the plugin skill glob found nothing; it has drifted from the real path shape")
	}
	out := make(map[string]func(t *testing.T) string, len(matches))
	for _, path := range matches {
		out[skillCarrierKey(path)] = func(t *testing.T) string {
			t.Helper()
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("plugin skill %q is a carrier of this protocol and must be readable: %v", path, err)
			}
			return string(b)
		}
	}
	return out
}

// TestEveryCarrierIsCovered fails if either Go carrier's remembered key is
// dropped. `channelInstructions` and `agentPromptText` are consts with no
// structural handle to enumerate from disk, so a remembered name is the
// strongest check available for them — this asymmetry with the plugin
// skills below is deliberate, not an oversight. The plugin-skill half needs
// no lookup here: discoverPluginSkillCarriers derives a key AND a reader for
// every file the glob finds, so a skill left unbound fails inside that
// function instead of via a second list going stale.
func TestEveryCarrierIsCovered(t *testing.T) {
	for _, name := range []string{"channel", "agent-prompt"} {
		if _, ok := carriersUnderTest[name]; !ok {
			t.Errorf("carrier %q is not held to the claim list", name)
		}
	}
	discoverPluginSkillCarriers(t) // fails on its own if nothing is found
}

// carriersUnderTest names the two Go carriers of this protocol. The
// channel's entry is a function because its delivery is composed at send
// time — see channelDelivery below, the real composed implementation. The
// plugin-skill carriers are deliberately NOT named here; see
// discoverPluginSkillCarriers and allCarriers.
var carriersUnderTest = map[string]func(t *testing.T) string{
	"channel":      func(t *testing.T) string { t.Helper(); return channelDelivery() },
	"agent-prompt": func(t *testing.T) string { t.Helper(); return agentPrompt(promptDoc) },
}

// allCarriers is carriersUnderTest plus every plugin skill discovered on
// disk, each bound to its own file by discoverPluginSkillCarriers.
func allCarriers(t *testing.T) map[string]func(t *testing.T) string {
	t.Helper()
	out := make(map[string]func(t *testing.T) string, len(carriersUnderTest)+1)
	for k, v := range carriersUnderTest {
		out[k] = v
	}
	for k, v := range discoverPluginSkillCarriers(t) {
		out[k] = v
	}
	return out
}

// TestEveryCarrierTeachesTheProtocol is the one gate. Every carrier, every
// claim — positive and forbidden — one place to add the next one.
func TestEveryCarrierTeachesTheProtocol(t *testing.T) {
	for name, read := range allCarriers(t) {
		prose := read(t)
		assertTeaches(t, name, prose, fileEditLoopClaims)
		assertTeaches(t, name, prose, changeManifestClaims)
		assertTeachesAny(t, name, prose, dropClaimSynonyms)
		assertRefuses(t, name, prose, forbiddenClaims)
	}
}

// reviseDelivery is what an agent answering a round ACTUALLY receives on the
// channel: the handshake core plus the revise/settle guidance, and nothing
// else — no approve, changed or closed guidance rides a revise wake. Review
// 2026-08-25, F3: channelDelivery (above) proves every claim rides some
// reason's guidance, which passes even if a claim lives only in an ending's
// prose that a revise-time agent never sees. This is the narrower composition
// that closes that gap — it is what the gate above cannot tell apart from the
// real thing on its own.
func reviseDelivery() string {
	return channelInstructions + "\n" + reasonGuidance(reasonRevise)
}

// TestReviseDeliveryTeachesTheProtocol asserts the same claim list against
// reviseDelivery, not just channelDelivery. Keep both: channelDelivery proves
// no claim is missing from the union of all guidance (a coverage check),
// reviseDelivery proves every claim reaches the one composition a
// revise-time agent is actually handed (a reachability check) — the two ask
// different questions and either can pass while the other fails.
func TestReviseDeliveryTeachesTheProtocol(t *testing.T) {
	prose := reviseDelivery()
	assertTeaches(t, "revise-delivery", prose, fileEditLoopClaims)
	assertTeaches(t, "revise-delivery", prose, changeManifestClaims)
	assertTeachesAny(t, "revise-delivery", prose, dropClaimSynonyms)
	assertRefuses(t, "revise-delivery", prose, forbiddenClaims)
}

// TestPluginSkillCarriersReadTheirOwnFile guards F4 (review 2026-08-25):
// TestEveryCarrierIsCovered derives a key from every SKILL.md the glob finds,
// but proving the key exists in a map is not proving the key's reader reads
// THAT file. The natural mistake — add a second skill tomorrow, hand-add its
// key, point it at the existing `pluginSkill` reader (hard-coded to
// reviewing-a-document/SKILL.md) — makes the coverage check pass while
// reading the first skill's file twice and leaving the new one's real
// content unbound. This creates a second, throwaway skill file on disk (so
// there is a second file to get wrong) and asserts its discovered carrier
// returns ITS OWN content, not reviewing-a-document's.
func TestPluginSkillCarriersReadTheirOwnFile(t *testing.T) {
	fixtureRoot := filepath.Join("..", "..", "plugin", "_fixturecarrier-f4")
	fixtureDir := filepath.Join(fixtureRoot, "skills", "fixture-skill")
	if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
		t.Fatalf("creating fixture skill dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(fixtureRoot) })
	fixturePath := filepath.Join(fixtureDir, "SKILL.md")
	const marker = "FIXTURE-MARKER-F4-CONTENT-LIVES-ONLY-IN-THIS-FILE"
	if err := os.WriteFile(fixturePath, []byte(marker), 0o644); err != nil {
		t.Fatalf("writing fixture skill file: %v", err)
	}

	carriers := discoverPluginSkillCarriers(t)
	key := skillCarrierKey(fixturePath)
	read, ok := carriers[key]
	if !ok {
		t.Fatalf("discovered carriers do not include %q", key)
	}
	if got := read(t); got != marker {
		t.Errorf("carrier %q read %q, want the fixture file's own content %q — it is reading the wrong file", key, got, marker)
	}
}

// The channel's carrier is what it DELIVERS, not the string it hands over at
// handshake: the core plus every reason's guidance is the whole of what an
// agent on this carrier is told across ALL FIVE reasons. Asserting the claims
// against the handshake string alone would let a claim vanish from the
// guidance and still pass. This proves each claim rides SOME reason's
// guidance — necessary, but (review 2026-08-25, F3) not sufficient: a claim
// living only in, say, the approve guidance would satisfy this while never
// reaching an agent that is actually answering a round. reviseDelivery below
// is the narrower, sufficient check.
func channelDelivery() string {
	parts := []string{channelInstructions}
	for _, r := range []string{reasonRevise, reasonSettle, reasonApprove, reasonChanged, reasonClosed} {
		parts = append(parts, reasonGuidance(r))
	}
	return strings.Join(parts, "\n")
}

// galley_ack's schema offers the four acknowledgements galley takes.
func TestTheAckSchemaOffersTheFourAcknowledgements(t *testing.T) {
	var schema struct {
		Properties struct {
			State struct {
				Enum []string `json:"enum"`
			} `json:"state"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(ackSchema, &schema); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(schema.Properties.State.Enum, ","); got != "working,answered,declined,failed" {
		t.Fatalf("galley_ack state enum = %s, want working,answered,declined,failed", got)
	}
}
