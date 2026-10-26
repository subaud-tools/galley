package serve

import (
	"net/http"
	"os"
	"testing"
	"time"
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
