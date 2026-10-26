package serve

import (
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/subaud-tools/tools-common/msgstate"
)

// pressAndHear presses Revise with one reader blocked on the wait, and
// answers the instructions the reader was woken with.
func pressAndHear(t *testing.T, s *EditServer) []string {
	t.Helper()
	h := s.Handler()
	reply := blockedWait(h, "", time.Hour)
	waitersRegistered(t, s, 1)
	if rec := post(t, h, "/_galley/revise", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("revise: %d %s", rec.Code, rec.Body.String())
	}
	var got waitReply
	select {
	case got = <-reply:
	case <-time.After(5 * time.Second):
		t.Fatal("the reader never heard the press")
	}
	if got.Reason != waitRevise {
		t.Fatalf("woken for %q, want %q", got.Reason, waitRevise)
	}
	var texts []string
	if got.Pending != nil {
		for _, in := range got.Pending.Instructions {
			texts = append(texts, in.Text)
		}
	}
	return texts
}

func instructDocument(t *testing.T, s *EditServer, text string) {
	t.Helper()
	if rec := post(t, s.Handler(), "/_galley/instruct", map[string]any{
		"op": "comment_document", "text": text, "author": "court",
	}); rec.Code != http.StatusOK {
		t.Fatalf("instruct %q: %d %s", text, rec.Code, rec.Body.String())
	}
}

func heard(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("the wake carried %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("the wake carried %q, want %q", got, want)
		}
	}
}

// The live sequence: a Revise whose turn ended with no reply, pressed again
// with nothing new on the page, wakes the agent with the same instruction
// rather than with none.
func TestAPressAfterNoReplySendsTheSameInstructionAgain(t *testing.T) {
	s, _ := messageDoc(t)
	instructDocument(t, s, "Add a sentence: Water is wet.")
	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
	report(t, s, "landed", windowToken(t, s))
	report(t, s, "turn_ended", "")

	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
}

// New instructions on the page are what a press sends; the unanswered ones
// are not sent with them.
func TestAPressWithANewInstructionSendsOnlyTheNewOne(t *testing.T) {
	s, _ := messageDoc(t)
	instructDocument(t, s, "Add a sentence: Water is wet.")
	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
	s.reviseMu.Lock()
	first := s.watch.round
	s.reviseMu.Unlock()
	// The page is locked while the window is open, so the new instruction is
	// filed with the window closed and the unanswered window put back.
	if rec := postRec(t, s, "/_galley/handoff/cancel", map[string]any{}); rec.Code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", rec.Code, rec.Body.String())
	}
	instructDocument(t, s, "Name the colour.")
	s.openResponseWindow(first, "fp", false)
	report(t, s, "landed", windowToken(t, s))
	report(t, s, "turn_ended", "")

	heard(t, pressAndHear(t, s), "Name the colour.")
}

// A Revise the agent answered is settled, and a later press re-sends nothing.
func TestAPressAfterAnAnswerSendsNothingAgain(t *testing.T) {
	s, md := messageDoc(t)
	instructDocument(t, s, "Add a sentence: Water is wet.")
	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
	if err := os.WriteFile(md, []byte("# T\n\nProse. Water is wet.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postAckRec(t, s, "answered", "added"); rec.Code != http.StatusNoContent {
		t.Fatalf("answered: %d %s", rec.Code, rec.Body.String())
	}

	heard(t, pressAndHear(t, s))
}

// The live sequence: a press with nothing new on the page while the agent is
// working opens no round, wakes nobody and leaves the message working, so the
// agent's answer is still matched against the round it was sent and keeps its
// key and note.
func TestAPressWithNothingNewWhileTheAgentIsWorkingDoesNothing(t *testing.T) {
	s, md := messageDoc(t)
	instructDocument(t, s, "Add a sentence: Water is wet.")
	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
	asked := rounds(t, s)
	key := asked[len(asked)-1].Asks[0].Key
	if rec := postAckRec(t, s, "working", "adding it"); rec.Code != http.StatusNoContent {
		t.Fatalf("working: %d %s", rec.Code, rec.Body.String())
	}

	h := s.Handler()
	reply := blockedWait(h, "", 300*time.Millisecond)
	waitersRegistered(t, s, 1)
	if rec := post(t, h, "/_galley/revise", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("revise: %d %s", rec.Code, rec.Body.String())
	}
	if got := <-reply; got.Reason != waitTimeout {
		t.Fatalf("the press woke the reader (%q) with nothing to send", got.Reason)
	}
	if got := len(rounds(t, s)); got != len(asked) {
		t.Fatalf("the press cut %d rounds, want none", got-len(asked))
	}
	if v := reviseState(t, s); v.Message == nil || v.Message.State != msgstate.Working {
		t.Fatalf("message = %+v, want working", v.Message)
	}

	if err := os.WriteFile(md, []byte("# T\n\nProse. Water is wet.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ackWith(t, s, "answered", "added", []ackChange{
		{Quote: "Water is wet.", Answers: []string{key}, Note: "Added the sentence."},
	})
	rs := rounds(t, s)
	landed := rs[len(rs)-1]
	if len(landed.Changes) != 1 || landed.Changes[0].Note != "Added the sentence." ||
		len(landed.Changes[0].Answers) != 1 || landed.Changes[0].Answers[0] != key {
		t.Fatalf("the answer lost its ask or note: %+v", landed.Changes)
	}
}

// A new instruction on the page is sent by a press while the agent still has
// the last Revise.
func TestAPressWithANewInstructionWhileTheAgentIsWorkingSendsIt(t *testing.T) {
	s, _ := messageDoc(t)
	instructDocument(t, s, "Add a sentence: Water is wet.")
	heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
	s.reviseMu.Lock()
	first := s.watch.round
	s.reviseMu.Unlock()
	// The page is locked while the window is open, so the new instruction is
	// filed with the window closed and the window put back.
	if rec := postRec(t, s, "/_galley/handoff/cancel", map[string]any{}); rec.Code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", rec.Code, rec.Body.String())
	}
	instructDocument(t, s, "Name the colour.")
	s.openResponseWindow(first, "fp", false)
	if rec := postAckRec(t, s, "working", "adding it"); rec.Code != http.StatusNoContent {
		t.Fatalf("working: %d %s", rec.Code, rec.Body.String())
	}

	heard(t, pressAndHear(t, s), "Name the colour.")
}

// A Revise the agent declined or failed is settled too, and a later press
// re-sends nothing.
func TestAPressAfterADeclineOrFailureSendsNothingAgain(t *testing.T) {
	for _, state := range []string{"declined", "failed"} {
		t.Run(state, func(t *testing.T) {
			s, _ := messageDoc(t)
			instructDocument(t, s, "Add a sentence: Water is wet.")
			heard(t, pressAndHear(t, s), "Add a sentence: Water is wet.")
			if rec := postAckRec(t, s, state, "not this one"); rec.Code != http.StatusNoContent {
				t.Fatalf("%s: %d %s", state, rec.Code, rec.Body.String())
			}

			heard(t, pressAndHear(t, s))
		})
	}
}
