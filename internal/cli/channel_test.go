package cli

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/markdown"
	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/galley/internal/suggest"
	"github.com/subaud-tools/tools-common/pageserve"
)

// channelInstructions must teach the unified verb grammar: reply by thread
// key, approve (accept/resolve/sweep by target shape), decline (final, both
// directions — a declined proposal is never re-proposed), and both approve
// arrivals — a clean approve (review over, proceed) and a TRUST approve (the
// entrusted handoff: apply each remaining note faithfully, resolve its
// thread as you complete it, ack answered, expect no further review). V8
// rewrites agentprompt.go next against this same protocol, so these
// substrings are the pin other implementers read.
func TestApproveContentIsTerminal(t *testing.T) {
	got := approveContent("doc.md")
	want := "The reviewer APPROVED doc.md as it stands. The review is over — proceed."
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// A COUNT THAT COULD NOT BE READ IS NOT A ZERO.
//
// announceReopen makes its event out of TWO requests: `/_galley/revise` for the
// reason (and for the confirmation that this really is a reopen) and
// `/_galley/pending` for the counts. Only the first one decided whether to
// speak; the second's error was dropped on the floor, so a reopen announced
// while the count read was failing carried `suggestions: "0", threads: "0"` —
// a fresh round opening on a document the agent had just been told was clean,
// and the exact made-up zero the function's own comment says the second
// request exists to avoid.
// The targeting rules below belong to suggest's own matcher. The CARRIERS no
// longer teach targeting at all — the agent edits the file, and there is no
// target to aim — so the prose assertions that used to live here went with
// the apply loop; the matcher's behavior is still pinned.
func TestTargetsCrossCodeSpansAndRefuseBackticks(t *testing.T) {
	doc, _, err := markdown.Parse([]byte("# T\n\nThe `retryBudget` value controls retries.\n"))
	if err != nil {
		t.Fatal(err)
	}
	// Crossing the code span, with no backtick in the target.
	out, err := suggest.CommentOn(doc, "The retryBudget value controls", "cm-0000000000000001", "court", time.Now())
	if err != nil {
		t.Fatalf("a target crossing a code span no longer matches: %v", err)
	}
	if got := suggest.List(suggest.MintRuns(out)); len(got) != 1 {
		t.Fatalf("a target crossing a code span produced %d suggestions, want 1", len(got))
	}
	// And the failure the carriers must actually warn about.
	if _, err := suggest.CommentOn(doc, "The `retryBudget` value", "cm-0000000000000002", "court", time.Now()); err == nil {
		t.Fatal("a target carrying backticks now matches — both carriers warn about a trap that is gone")
	}
}

// `galley pending` PRINTS EVERY THREAD'S KEY, from its first entry, with a
// tick beside the settled ones (main.go's thread loop). The instructions said
// it prints one "once someone has replied", which is a rule about a PROPOSAL's
// thread — that one is created by the first reply — read onto every thread,
// and it sends an agent looking for a key that is already on the screen.
func TestTheWakeCountsInstructions(t *testing.T) {
	var wire serve.AgentWake
	body := `{"reason":"revise","pending":{"instructions":[{"text":"one"},{"text":"two"}]}}`
	if err := json.Unmarshal([]byte(body), &wire); err != nil {
		t.Fatal(err)
	}
	if got := len(wire.Pending.Instructions); got != 2 {
		t.Errorf("instructions = %d, want 2", got)
	}
}

// The rules that govern a revise ride the revise, because a rule works best
// beside the action it governs. The whole-file-write rule is the reason this
// test is by name rather than by shape: it exists because a real agent
// destroyed a real reviewer's section, and a future edit that tidies it out of
// the guidance must fail here rather than ship.
func TestReviseGuidanceCarriesTheWriteRule(t *testing.T) {
	for _, reason := range []string{reasonRevise, reasonSettle} {
		lower := strings.ToLower(reasonGuidance(reason))
		for _, want := range []string{"targeted", "whole file", "stale", "galley_ack", "answered"} {
			if !strings.Contains(lower, want) {
				t.Errorf("%s guidance does not carry %q", reason, want)
			}
		}
	}
}

// THE CORE ITSELF MUST TEACH THE WRITE RULE, not merely the composed
// delivery. Whole-branch review 2026-08-25, findings F1/F2: `reasonGuidance`
// answers "" for `changed`, so a changed-woken agent gets channelInstructions
// and nothing else — no reviseGuidance rides that wake. The same is true of
// recovery: roundText (round.go) renders instructions and keys, deliberately
// nothing else, and the core's own recovery sentence points an agent there.
// A test against channelDelivery() (core + all five reasons' guidance) cannot
// catch the write rule going missing from the core, because reviseGuidance is
// one of the five joined in and would carry it regardless. This asserts the
// claim directly against channelInstructions, which is the one carrier that
// reaches a changed wake or a compaction recovery.
func TestTheHandshakeCoreCarriesTheWriteRule(t *testing.T) {
	lower := strings.ToLower(channelInstructions)
	for _, want := range []string{"targeted", "whole file"} {
		if !strings.Contains(lower, want) {
			t.Errorf("channelInstructions does not carry %q — a changed wake or a compaction recovery has no write rule at all", want)
		}
	}
}

// A PAGE-BACKED REVISE CARRIES THE PAGE-MODE GUIDANCE ON THE CHANNEL, not only
// on the pull carrier. A channel-woken agent answering a structural ask on an
// HTML page had no page-mode guidance at all and edited galley's derived
// template.json (silently overwritten) to answer it — measured on a real
// review. The pull carrier's agent prompt already appended pageBacked; this
// asserts the channel wake does too, and only for a page-backed doc.
func TestPageBackedReviseCarriesPageGuidance(t *testing.T) {
	paged := composeWake(reasonRevise, "Revision requested on doc.md — 1 instruction(s).", true)
	for _, want := range []string{
		"backed by an HTML page",
		"edit the page's .html directly",
		"NEVER edit the other files galley keeps",
		"template.json",
	} {
		if !strings.Contains(paged, want) {
			t.Errorf("page-backed channel revise is missing %q:\n%s", want, paged)
		}
	}
	// A single separator: pageBacked joins the guidance half, it does not add
	// a second "---" the client would mis-split on.
	const sep = "\n\n---\n"
	if strings.Count(paged, sep) != 1 {
		t.Errorf("page-backed wake has %d separators, want 1:\n%s", strings.Count(paged, sep), paged)
	}
	// A non-page-backed revise must NOT carry it.
	plain := composeWake(reasonRevise, "Revision requested on doc.md — 1 instruction(s).", false)
	if strings.Contains(plain, "backed by an HTML page") {
		t.Errorf("page-mode guidance leaked into a non-page-backed wake:\n%s", plain)
	}
	// An ENDING on a page-backed doc gets no page guidance (it has no revision
	// to make).
	end := composeWake(reasonApprove, "The review is over.", true)
	if strings.Contains(end, "backed by an HTML page") {
		t.Errorf("page-mode guidance leaked onto an approve wake:\n%s", end)
	}
}

// The endings need a sentence, not a protocol.
func TestEndingGuidanceIsShort(t *testing.T) {
	for _, reason := range []string{reasonApprove, reasonClosed, reasonChanged} {
		g := reasonGuidance(reason)
		if g == "" {
			t.Errorf("%s carries no guidance at all", reason)
		}
		if len(g) > 400 {
			t.Errorf("%s guidance is %d bytes; the endings get a sentence, not a protocol", reason, len(g))
		}
	}
}

// The separator is the contract a client splits on. pi-channels splits on the
// FIRST occurrence of "\n\n---\n" and treats everything after it as guidance
// it may dedupe across a coalesced batch; a client that does not split renders
// it as a readable rule.
func TestGuidanceIsSeparatedFromTheEnvelope(t *testing.T) {
	content := composeWake(reasonRevise, "Revision requested on doc.md — 2 instruction(s).", false)
	const sep = "\n\n---\n"
	if !strings.Contains(content, sep) {
		t.Fatalf("no guidance separator in:\n%s", content)
	}
	if strings.Index(content, sep) != strings.LastIndex(content, sep) {
		// Not fatal for a client that splits on the first occurrence, but it
		// means the envelope half is ambiguous to anything that does not.
		t.Logf("more than one separator; clients split on the first")
	}
	body, guidance, _ := strings.Cut(content, sep)
	if strings.Contains(body, "targeted") {
		t.Errorf("the write rule belongs in the guidance half, not the envelope:\n%s", body)
	}
	if !strings.Contains(strings.ToLower(guidance), "targeted") {
		t.Errorf("guidance half does not carry the write rule:\n%s", guidance)
	}
}

// The core is what every session pays for on every handshake. It was 4338
// bytes when all of the answering protocol lived in it.
func TestTheHandshakeCoreIsSmall(t *testing.T) {
	if n := len(channelInstructions); n > 1800 {
		t.Errorf("handshake core is %d bytes; the answering rules belong on the event", n)
	}
}

// THE HANDSHAKE TEACHES galley_open AND WARNS OFF THE SHELL. The old paragraph
// told the agent to run `galley edit` itself, which is how an editor came to be
// stamped with whatever session id the shell happened to carry. Both halves
// are pinned: the tool by name, and the prohibition, because an agent that
// knows the tool and is not told the shell is wrong will still reach for the
// command it remembers.
func TestTheHandshakeCoreTeachesGalleyOpen(t *testing.T) {
	lower := strings.ToLower(channelInstructions)
	if !strings.Contains(lower, "galley_open") {
		t.Error("channelInstructions never names galley_open")
	}
	if !strings.Contains(lower, "never run galley edit") {
		t.Error("channelInstructions does not warn the agent off `galley edit` from a shell")
	}
	if strings.Contains(lower, "cannot open one") || strings.Contains(lower, "start the editor yourself") {
		t.Error("channelInstructions still carries the pre-galley_open paragraph")
	}
	skill := strings.ToLower(pluginSkill(t))
	if !strings.Contains(skill, "galley_open") {
		t.Error("the plugin skill never names galley_open")
	}
	if strings.Contains(skill, "has no tool that opens a document") {
		t.Error("the plugin skill still says the channel cannot open a document")
	}
}

// An ack or approve with no document path says the path is missing, rather
// than that no editor is running for the empty string.
func TestAckAndApproveWithoutADocSayTheyNeedThePath(t *testing.T) {
	isolate(t)
	ch := pageserve.New(channelSpec(), pageserve.Identity{CWD: t.TempDir()}, pageserve.NewClient(serve.Live(), nil))
	for _, tool := range []string{"galley_ack", "galley_approve"} {
		for _, args := range []string{`{"state":"working","note":"on it"}`, `{"doc":""}`} {
			_, err := callTool(context.Background(), ch, tool, json.RawMessage(args))
			want := tool + " needs the document path (doc)"
			if err == nil || err.Error() != want {
				t.Errorf("%s %s: err = %v, want %q", tool, args, err, want)
			}
		}
	}
}
