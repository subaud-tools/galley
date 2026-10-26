package serve

import (
	"net/http"
	"os"
	"testing"

	"github.com/subaud-tools/tools-common/msgstate"
)

// windowToken is the open message's report token.
func windowToken(t *testing.T, s *EditServer) string {
	t.Helper()
	s.reviseMu.Lock()
	defer s.reviseMu.Unlock()
	if s.msg == nil {
		t.Fatal("no message")
	}
	return s.msg.token
}

func report(t *testing.T, s *EditServer, event, token string) {
	t.Helper()
	if rec := postRec(t, s, "/_galley/report", map[string]any{"event": event, "token": token}); rec.Code != http.StatusNoContent {
		t.Fatalf("report %s: %d %s", event, rec.Code, rec.Body.String())
	}
}

func messageIs(t *testing.T, s *EditServer, state msgstate.State, held bool) {
	t.Helper()
	v := reviseState(t, s)
	if v.Message == nil || v.Message.State != state || v.Message.Held != held {
		t.Fatalf("message = %+v, want %s held=%t", v.Message, state, held)
	}
}

func TestLandedMovesSentToWithTheAgent(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	report(t, s, "landed", windowToken(t, s))
	messageIs(t, s, msgstate.WithAgent, false)
	if got := leaseOnDisk(t, s)["state"]; got != "with_agent" {
		t.Fatalf("lease state %v, want with_agent", got)
	}
}

func TestALateLandedLeavesWorkingWorking(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	if rec := postAckRec(t, s, "working", "on it"); rec.Code != http.StatusNoContent {
		t.Fatalf("working: %d %s", rec.Code, rec.Body.String())
	}
	report(t, s, "landed", windowToken(t, s))
	messageIs(t, s, msgstate.Working, false)
}

func TestHeldMarksASentMessageAndLandedClearsIt(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	tok := windowToken(t, s)
	report(t, s, "held", tok)
	messageIs(t, s, msgstate.Sent, true)
	report(t, s, "landed", tok)
	messageIs(t, s, msgstate.WithAgent, false)
}

func TestTurnEndedMovesAnUnsettledMessageToNoReply(t *testing.T) {
	for _, ack := range []string{"", "working"} {
		s, _ := messageDoc(t)
		s.openResponseWindow(1, "fp", false)
		report(t, s, "landed", windowToken(t, s))
		if ack != "" {
			if rec := postAckRec(t, s, ack, "on it"); rec.Code != http.StatusNoContent {
				t.Fatalf("%s: %d %s", ack, rec.Code, rec.Body.String())
			}
		}
		report(t, s, "turn_ended", "")
		messageIs(t, s, msgstate.NoReply, false)
		if !s.handoffOpenNow() {
			t.Fatalf("after %q: turn_ended closed the window", ack)
		}
	}
}

func TestTurnEndedLeavesAnAnsweredMessageAlone(t *testing.T) {
	s, md := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	report(t, s, "landed", windowToken(t, s))
	if err := os.WriteFile(md, []byte("# T\n\nBetter prose.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postAckRec(t, s, "answered", "done"); rec.Code != http.StatusNoContent {
		t.Fatalf("answered: %d %s", rec.Code, rec.Body.String())
	}
	report(t, s, "turn_ended", "")
	messageIs(t, s, msgstate.Answered, false)
}

func TestANoReplyMessageTakesALateAnswer(t *testing.T) {
	s, md := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	report(t, s, "landed", windowToken(t, s))
	report(t, s, "turn_ended", "")
	if err := os.WriteFile(md, []byte("# T\n\nBetter prose.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postAckRec(t, s, "answered", "done late"); rec.Code != http.StatusNoContent {
		t.Fatalf("late answered: %d %s", rec.Code, rec.Body.String())
	}
	messageIs(t, s, msgstate.Answered, false)
}

func TestAReportWithAnotherTokenChangesNothing(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	report(t, s, "held", "0000000000000000")
	report(t, s, "landed", "0000000000000000")
	messageIs(t, s, msgstate.Sent, false)
}
