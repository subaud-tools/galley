package serve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/subaud-tools/tools-common/msgstate"
)

// messageDoc starts an editor over a one-paragraph document in a temp dir.
func messageDoc(t *testing.T) (*EditServer, string) {
	t.Helper()
	md := filepath.Join(t.TempDir(), "doc.md")
	if err := os.WriteFile(md, []byte("# T\n\nProse.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewEdit(md)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, md
}

// reviseState is GET /_galley/revise, decoded.
func reviseState(t *testing.T, s *EditServer) ReviseStateView {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/_galley/revise", nil))
	var v ReviseStateView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("revise state %s: %v", rec.Body.String(), err)
	}
	return v
}

// leaseOnDisk is the handoff lease as written, decoded loosely.
func leaseOnDisk(t *testing.T, s *EditServer) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(s.leasePath())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

var reportToken16 = regexp.MustCompile(`^[0-9a-f]{16}$`)

func TestAPressStartsASentMessageAndASecondPressAFreshOne(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	v := reviseState(t, s)
	if v.Message == nil || v.Message.State != msgstate.Sent {
		t.Fatalf("message after a press = %+v, want sent", v.Message)
	}
	first, _ := leaseOnDisk(t, s)["report"].(string)
	if !reportToken16.MatchString(first) {
		t.Fatalf("report token %q, want 16 hex characters", first)
	}

	s.openResponseWindow(2, "fp2", false)
	second, _ := leaseOnDisk(t, s)["report"].(string)
	if !reportToken16.MatchString(second) || second == first {
		t.Fatalf("second press token %q, want a fresh one (first %q)", second, first)
	}
}

func TestWorkingFromSentSetsTheLine(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	if rec := postAckRec(t, s, "working", "reading the thread"); rec.Code != http.StatusNoContent {
		t.Fatalf("working ack: %d %s", rec.Code, rec.Body.String())
	}
	v := reviseState(t, s)
	if v.Message == nil || v.Message.State != msgstate.Working || v.Message.Line != "reading the thread" {
		t.Fatalf("message = %+v, want working with the note as its line", v.Message)
	}
}

func TestAnsweredAfterDeclinedIsRefused(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	if rec := postAckRec(t, s, "declined", "out of scope"); rec.Code != http.StatusNoContent {
		t.Fatalf("declined ack: %d %s", rec.Code, rec.Body.String())
	}
	rec := postAckRec(t, s, "answered", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "declined") {
		t.Fatalf("answered after declined: %d %s, want 409 naming declined", rec.Code, rec.Body.String())
	}
	if v := reviseState(t, s); v.Message == nil || v.Message.State != msgstate.Declined {
		t.Fatalf("message = %+v, want still declined", v.Message)
	}
}

func TestReceivedIsNoLongerAnAck(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	rec := postAckRec(t, s, "received", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "working, answered, declined, failed") {
		t.Fatalf("received: %d %s, want 400 listing the four", rec.Code, rec.Body.String())
	}
}

func TestCannotLeavesTheMessageFailedWithTheReason(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	if rec := postRec(t, s, "/_galley/cannot", map[string]any{"why": "the source is not in the repo"}); rec.Code != http.StatusNoContent {
		t.Fatalf("cannot: %d %s", rec.Code, rec.Body.String())
	}
	v := reviseState(t, s)
	if v.Message == nil || v.Message.State != msgstate.Failed || v.Message.Line != "the source is not in the repo" {
		t.Fatalf("message = %+v, want failed with the reason", v.Message)
	}
}

func TestARestartMidWindowResumesTheMessage(t *testing.T) {
	s1, md := messageDoc(t)
	s1.openResponseWindow(1, "fp", false)
	if rec := postAckRec(t, s1, "working", "rewriting section two"); rec.Code != http.StatusNoContent {
		t.Fatalf("working ack: %d %s", rec.Code, rec.Body.String())
	}
	token, _ := leaseOnDisk(t, s1)["report"].(string)
	_ = s1.Close() // not a clean window close: the lease survives

	s2, err := NewEdit(md)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()
	v := reviseState(t, s2)
	if v.Message == nil || v.Message.State != msgstate.Working || v.Message.Line != "rewriting section two" {
		t.Fatalf("resumed message = %+v, want working with its line", v.Message)
	}
	if got, _ := leaseOnDisk(t, s2)["report"].(string); got != token {
		t.Fatalf("resumed token %q, want %q", got, token)
	}
}

func TestAVersionOneLeaseResumesWithTheAgentAndIsRewritten(t *testing.T) {
	md := filepath.Join(t.TempDir(), "doc.md")
	if err := os.WriteFile(md, []byte("# T\n\nProse.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lease := filepath.Join(filepath.Dir(md), ".galley", "versions", "doc.md", "handoff.json")
	if err := os.MkdirAll(filepath.Dir(lease), 0o755); err != nil {
		t.Fatal(err)
	}
	v1 := `{"v":1,"round":1,"baseline":"b0","fingerprint":"fp0","openedAt":"2026-08-20T10:00:00Z"}`
	if err := os.WriteFile(lease, []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewEdit(md)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if s.leasePath() != lease {
		t.Fatalf("lease path %s, want %s", s.leasePath(), lease)
	}
	if v := reviseState(t, s); v.Message == nil || v.Message.State != msgstate.WithAgent || v.Message.Line != "" {
		t.Fatalf("message = %+v, want with_agent and no line", v.Message)
	}
	got := leaseOnDisk(t, s)
	if got["v"] != float64(2) || got["state"] != "with_agent" {
		t.Fatalf("lease on disk = %v, want v 2 in with_agent", got)
	}
}

func TestALeaseFromANewerGalleyIsKeptAsUnreadable(t *testing.T) {
	md := filepath.Join(t.TempDir(), "doc.md")
	if err := os.WriteFile(md, []byte("# T\n\nProse.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lease := filepath.Join(filepath.Dir(md), ".galley", "versions", "doc.md", "handoff.json")
	if err := os.MkdirAll(filepath.Dir(lease), 0o755); err != nil {
		t.Fatal(err)
	}
	v3 := `{"v":3,"round":1,"baseline":"b0","fingerprint":"fp0","openedAt":"2026-08-20T10:00:00Z"}`
	if err := os.WriteFile(lease, []byte(v3), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewEdit(md)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if s.handoffOpenNow() {
		t.Fatal("a v3 lease resumed the window")
	}
	if _, err := os.Stat(lease + ".unreadable"); err != nil {
		t.Fatalf("the v3 lease was not kept as unreadable: %v", err)
	}
}

// A cancel is the reviewer taking the document back, so the message goes the
// way a direct Approve takes it: no pill left saying the agent still has it.
func TestACancelClearsTheMessage(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	if rec := postAckRec(t, s, "working", "reading the thread"); rec.Code != http.StatusNoContent {
		t.Fatalf("working ack: %d %s", rec.Code, rec.Body.String())
	}
	cancelHandoff(t, s)
	if v := reviseState(t, s); v.Message != nil {
		t.Fatalf("message after a cancel = %+v, want none", v.Message)
	}
}
