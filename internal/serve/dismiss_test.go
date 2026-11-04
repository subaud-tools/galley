package serve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The reviewer's Dismiss on the disk notice: it clears a clash, which only says
// where the other version went, and nothing else, since a missing or unreadable
// file is a problem still happening. See handleNoticeDismiss.

// dismissNotice is the page's Dismiss: POST /_galley/notice/dismiss.
func dismissNotice(t *testing.T, s *EditServer) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/_galley/notice/dismiss", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec.Code
}

// diskNoticeKindOf is the notice's kind, read off GET /_galley/revise.
func diskNoticeKindOf(t *testing.T, s *EditServer) string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/_galley/revise", nil))
	var view map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("revise state: %v: %s", err, rec.Body.String())
	}
	kind, _ := view["diskNoticeKind"].(string)
	return kind
}

func TestDismissClearsAClashNotice(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "d.md", foxDoc)
	defer func() { _ = s.Close() }()
	reviewerTypes(t, s, "Second para here.", "Second para, from the reviewer.")
	writeFile(t, s.MdPath, "# T\n\nthe quick red fox jumps.\n\nSecond para here.\n")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if diskNoticeOf(t, s) == "" {
		t.Fatal("no clash notice to dismiss")
	}
	if got := diskNoticeKindOf(t, s); got != noticeClash {
		t.Errorf("diskNoticeKind = %q, want %q", got, noticeClash)
	}
	if code := dismissNotice(t, s); code != http.StatusNoContent {
		t.Fatalf("dismiss answered %d", code)
	}
	if got := diskNoticeOf(t, s); got != "" {
		t.Errorf("the clash notice is still there after Dismiss: %q", got)
	}
	if got := diskNoticeKindOf(t, s); got != "" {
		t.Errorf("diskNoticeKind = %q after Dismiss", got)
	}
}

func TestDismissLeavesAMissingFileNotice(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "d.md", foxDoc)
	defer func() { _ = s.Close() }()
	if err := os.Remove(s.MdPath); err != nil {
		t.Fatal(err)
	}
	reviewerTypes(t, s, "Second para here.", "Second para, from the reviewer.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	want := "d.md is no longer at this path. Nothing is being saved."
	if got := diskNoticeKindOf(t, s); got != noticeMissing {
		t.Errorf("diskNoticeKind = %q, want %q", got, noticeMissing)
	}
	if code := dismissNotice(t, s); code != http.StatusNoContent {
		t.Fatalf("dismiss answered %d", code)
	}
	if got := diskNoticeOf(t, s); got != want {
		t.Errorf("a missing-file notice was dismissed: notice = %q, want %q", got, want)
	}
}
