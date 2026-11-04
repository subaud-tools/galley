package serve

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/subaud-tools/galley/internal/versions"
)

// keptHost is a Host keeping its reviews in state, as Run's is.
func keptHost(t *testing.T, state string) *Host {
	t.Helper()
	h := NewHost()
	h.reviews = loadReviews(filepath.Join(state, "reviews.json"), h.log)
	t.Cleanup(func() { _ = h.closeAll() })
	return h
}

func approvedPages(h *Host) []PageView {
	var out []PageView
	for _, p := range h.Pages() {
		if p.State == PageApproved {
			out = append(out, p)
		}
	}
	return out
}

func TestApprovedReviewStaysListedAfterTheSweep(t *testing.T) {
	h := keptHost(t, t.TempDir())
	id, err := h.Open(writeDoc(t, "doc.md", "# T\n\nHello.\n"), DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := h.doc(id)
	d.server.approveReview(false)
	for range unloadGrace {
		h.sweep()
	}
	if _, open := h.doc(id); open {
		t.Fatal("the sweep left the approved review open")
	}
	got := approvedPages(h)
	if len(got) != 1 || got[0].Key != id || got[0].Open || got[0].ApprovedAt == 0 || got[0].Name != "doc.md" {
		t.Fatalf("pages after the sweep = %+v, want the review approved and not open", h.Pages())
	}
}

func TestApprovedReviewStaysListedAfterARestart(t *testing.T) {
	state := t.TempDir()
	h := keptHost(t, state)
	id, err := h.Open(writeDoc(t, "doc.md", "# T\n\nHello.\n"), DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := h.doc(id)
	d.server.approveReview(false)
	if err := h.closeAll(); err != nil {
		t.Fatal(err)
	}
	again := keptHost(t, state)
	if got := approvedPages(again); len(got) != 1 || got[0].Key != id {
		t.Fatalf("pages after a restart = %+v, want the approved review", again.Pages())
	}
	if info, err := os.Stat(filepath.Join(state, "reviews.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("reviews.json: %v %v, want 0600", info, err)
	}
}

func TestReopenedApprovedReviewIsSealed(t *testing.T) {
	r := agentServer(t, "sess-a")
	dir := t.TempDir()
	doc := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{})
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise",
		map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
		t.Fatalf("approve answered %d", code)
	}
	var before ReviseStateView
	r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/revise", nil, &before)
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("close answered %d", code)
	}

	code, body := signIn(t, r).do(t, http.MethodPost, "/api/reviews/open", `{"key":"`+a.ID+`"}`)
	if code != http.StatusOK {
		t.Fatalf("POST /api/reviews/open = %d: %s", code, body)
	}
	var opened struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &opened); err != nil || opened.ID != a.ID {
		t.Fatalf("answer %s (%v), want id %s", body, err, a.ID)
	}
	var st ReviseStateView
	r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/revise", nil, &st)
	if !st.Sealed || st.Verdict != VerdictApproved || st.VerdictAt != before.VerdictAt || st.VerdictAt == 0 {
		t.Fatalf("reopened state = %+v, want sealed approved at %d", st, before.VerdictAt)
	}
	var w waitReply
	if code := r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/wait?timeout=1s", nil, &w); code != http.StatusOK || w.Reason != waitApprove {
		t.Fatalf("wait = %d %+v, want approve", code, w)
	}
	if got, code := r.agentWait(t, "sess-a", dir, 1); code != http.StatusNoContent {
		t.Fatalf("a waiting session heard the reopened review: %d %+v", code, got)
	}
	if owner := r.ownerOf(t, a.ID); owner != "" {
		t.Fatalf("a waiting session claimed the reopened review: %q", owner)
	}
}

func TestKeptReviewRecordsItsRounds(t *testing.T) {
	h := keptHost(t, t.TempDir())
	path := writeDoc(t, "doc.md", "# T\n\nHello.\n")
	id, err := h.Open(path, DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := h.doc(id)
	d.server.requestCut(versions.ReasonRevise, "one", 0)
	d.server.requestCut(versions.ReasonRevise, "two", 0)
	d.server.approveReview(false)
	all := rounds(t, d.server)
	last := all[len(all)-1]
	if last.Reason != versions.ReasonVerdict {
		t.Fatalf("the last round is %q, want the verdict", last.Reason)
	}
	k, ok := h.reviews.get(d.path)
	if !ok || k.Rounds != 2 || k.VerdictN != last.N || k.Digest != last.Digest || k.State != PageApproved {
		t.Fatalf("entry = %+v (%v), want 2 rounds and verdict v%d", k, ok, last.N)
	}
}

func TestRemoveForgetsOnlyTheEntry(t *testing.T) {
	state := t.TempDir()
	h := keptHost(t, state)
	path := writeDoc(t, "doc.md", "# T\n\nHello.\n")
	id, err := h.Open(path, DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := h.doc(id)
	d.server.approveReview(false)
	versionsDir := d.server.Versions().Dir()
	if err := h.Close(id); err != nil {
		t.Fatal(err)
	}
	if rec := post(t, h.Handler(), "/api/reviews/remove", map[string]string{"key": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("remove = %d: %s", rec.Code, rec.Body.String())
	}
	if got := h.Pages(); len(got) != 0 {
		t.Fatalf("pages after remove = %+v", got)
	}
	if again := keptHost(t, state); len(again.Pages()) != 0 {
		t.Fatalf("reviews.json still holds it: %+v", again.Pages())
	}
	for _, p := range []string{path, versionsDir} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("remove touched %s: %v", p, err)
		}
	}
}

func TestRemoveEndsAnOpenReview(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	b := signIn(t, r)
	if code, body := b.do(t, http.MethodPost, "/api/reviews/remove", `{"key":"`+a.ID+`"}`); code != http.StatusNoContent {
		t.Fatalf("remove = %d: %s", code, body)
	}
	if w, code := r.agentWait(t, "sess-a", "", 5); code != http.StatusOK || w.Reason != "closed" || w.Page != doc {
		t.Fatalf("answered %d %+v, want one closed wake", code, w)
	}
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("told twice: %+v", w)
	}
	if _, _, views := pagesOf(t, b); len(views) != 0 {
		t.Fatalf("pages after remove = %+v", views)
	}
}

func TestTwoDocumentsWithOneName(t *testing.T) {
	h := keptHost(t, t.TempDir())
	root := t.TempDir()
	for _, dir := range []string{"a", "b"} {
		id, err := h.Open(writeTestFile(t, filepath.Join(root, dir, "plan.md"), "# P\n"), DocOptions{})
		if err != nil {
			t.Fatal(err)
		}
		d, _ := h.doc(id)
		d.server.approveReview(false)
		if err := h.Close(id); err != nil {
			t.Fatal(err)
		}
	}
	got := approvedPages(h)
	if len(got) != 2 || got[0].Key == got[1].Key || got[0].Folder == got[1].Folder {
		t.Fatalf("pages = %+v, want two entries", got)
	}
}
