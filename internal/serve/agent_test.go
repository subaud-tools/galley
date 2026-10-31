package serve

import (
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// agentWait is one GET /api/agent/wait, as pageserve's channel makes it.
func (r *running) agentWait(t *testing.T, session, root string, secs int) (AgentWake, int) {
	t.Helper()
	q := url.Values{"session": {session}, "timeout": {strconv.Itoa(secs)}}
	if root != "" {
		q.Set("root", root)
	}
	var w AgentWake
	code := r.call(t, http.MethodGet, "/api/agent/wait?"+q.Encode(), nil, &w)
	return w, code
}

// press presses Revise until a reader is there to hear it: a wait attaches the
// session to its documents a moment after it starts.
func (r *running) press(t *testing.T, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code := r.call(t, http.MethodPost, "/api/docs/"+id+"/_galley/revise", map[string]any{}, nil)
		if code == http.StatusNoContent {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Revise answered %d: nobody heard it", code)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitInBackground holds a wait open, so the session stays attached while the
// test does something else.
func (r *running) waitInBackground(t *testing.T, session, root string) chan AgentWake {
	t.Helper()
	got := make(chan AgentWake, 1)
	go func() {
		w, code := r.agentWait(t, session, root, 10)
		if code == http.StatusOK {
			got <- w
		}
	}()
	return got
}

func receive(t *testing.T, ch chan AgentWake, what string) AgentWake {
	t.Helper()
	select {
	case w := <-ch:
		return w
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: no wake", what)
		return AgentWake{}
	}
}

func agentServer(t *testing.T, sessions ...string) *running {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	return startServe(t, Options{Sessions: presence(t, sessions...)})
}

// A Revise wakes the session that owns the document, and no other: the server
// decides, from the document's owner.
func TestAgentWaitWakesOnlyTheOwner(t *testing.T) {
	r := agentServer(t, "sess-a", "sess-b")
	dir := t.TempDir()
	docA := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n")
	docB := writeTestFile(t, filepath.Join(dir, "b.md"), "# B\n\nHi.\n")
	a := r.open(t, docA, DocOptions{Owner: "sess-a"})
	r.open(t, docB, DocOptions{Owner: "sess-b"})

	wa := r.waitInBackground(t, "sess-a", "")
	r.press(t, a.ID)
	w := receive(t, wa, "the owner")
	if w.Reason != "revise" || w.Page != docA || w.Room != a.Room {
		t.Fatalf("wake = %+v", w)
	}
	if w.Report == "" || w.Pending == nil {
		t.Fatalf("the wake lost its report token or its round: %+v", w)
	}
	if got, code := r.agentWait(t, "sess-b", "", 1); code != http.StatusNoContent {
		t.Fatalf("the other session was woken: %d %+v", code, got)
	}
}

// One wait spans every document the session owns, and two presses that land
// while one answer is on its way are both delivered: the wake is held for the
// next wait, not lost with the poll that went back.
func TestAgentWaitSpansTheSessionsDocumentsAndLosesNothing(t *testing.T) {
	r := agentServer(t, "sess-a")
	dir := t.TempDir()
	a := r.open(t, writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n"), DocOptions{Owner: "sess-a"})
	b := r.open(t, writeTestFile(t, filepath.Join(dir, "b.md"), "# B\n\nHi.\n"), DocOptions{Owner: "sess-a"})

	first := r.waitInBackground(t, "sess-a", "")
	r.press(t, a.ID)
	r.press(t, b.ID)
	seen := map[string]bool{receive(t, first, "first").Room: true}
	w, code := r.agentWait(t, "sess-a", "", 5)
	if code != http.StatusOK {
		t.Fatalf("the second wake answered %d", code)
	}
	seen[w.Room] = true
	if !seen[a.Room] || !seen[b.Room] {
		t.Fatalf("delivered %v, want both %s and %s", seen, a.Room, b.Room)
	}
}

func TestAgentWaitNeedsASessionAndAnswersNoContentAtItsTimeout(t *testing.T) {
	r := agentServer(t, "sess-a")
	if _, code := r.agentWait(t, "", "", 1); code != http.StatusBadRequest {
		t.Fatalf("no session answered %d", code)
	}
	if _, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("a quiet wait answered %d", code)
	}
}

// An approve wakes once, and the document closing after it is no news.
func TestAgentApproveWakesOnceAndItsCloseIsSilent(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	got := r.waitInBackground(t, "sess-a", "")
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise",
		map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
		t.Fatalf("approve answered %d", code)
	}
	if w := receive(t, got, "approve"); w.Reason != "approve" {
		t.Fatalf("wake = %+v", w)
	}
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("the approve came again: %+v", w)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("close answered %d", code)
	}
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("closing an approved review woke the session: %+v", w)
	}
}

// An approve no wait was there to hear is told when the document closes, as the
// seal told whoever attached next.
func TestAgentApproveNobodyHeardIsToldAtClose(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise",
		map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
		t.Fatalf("approve answered %d", code)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("close answered %d", code)
	}
	if w, code := r.agentWait(t, "sess-a", "", 5); code != http.StatusOK || w.Reason != "approve" {
		t.Fatalf("answered %d %+v, want the approve", code, w)
	}
}

// A document closed under a review says so, even with no wait open at that
// moment: the next wait hears it.
func TestAgentHearsADocumentClose(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("close answered %d", code)
	}
	w, code := r.agentWait(t, "sess-a", "", 5)
	if code != http.StatusOK || w.Reason != "closed" || w.Page != doc || w.Pending != nil || w.Note == "" {
		t.Fatalf("answered %d %+v", code, w)
	}
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("said twice: %+v", w)
	}
}

// A restart is not a close: the document comes back from docs.json, the session
// hears nothing about it, and a Revise on it wakes the session as before.
func TestAgentRestartIsNotAClose(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	sessions := presence(t, "sess-a")
	r := startServe(t, Options{Sessions: sessions})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	got := r.waitInBackground(t, "sess-a", "")
	time.Sleep(100 * time.Millisecond)
	r.stop()
	select {
	case w := <-got:
		t.Fatalf("the stop woke the session: %+v", w)
	case <-time.After(100 * time.Millisecond):
	}

	r = startServe(t, Options{Sessions: sessions})
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("the restart woke the session: %d %+v", code, w)
	}
	back := r.waitInBackground(t, "sess-a", "")
	r.press(t, a.ID)
	if w := receive(t, back, "after the restart"); w.Reason != "revise" {
		t.Fatalf("wake = %+v", w)
	}
}

// A document that does not come back is news: its session was told it would.
func TestAgentHearsADocumentThatDidNotComeBack(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	sessions := presence(t, "sess-a")
	r := startServe(t, Options{Sessions: sessions})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	r.open(t, doc, DocOptions{Owner: "sess-a"})
	r.stop()
	if err := os.Remove(doc); err != nil {
		t.Fatal(err)
	}
	r = startServe(t, Options{Sessions: sessions})
	w, code := r.agentWait(t, "sess-a", "", 5)
	if code != http.StatusOK || w.Reason != "closed" || w.Page != doc {
		t.Fatalf("answered %d %+v", code, w)
	}
}

// A document no session owns goes to the first session waiting whose folder
// holds it, and stays that session's; one outside every folder stays unowned.
func TestAgentWaitClaimsAnUnownedDocumentUnderItsRoot(t *testing.T) {
	r := agentServer(t, "sess-a", "sess-b")
	dir := t.TempDir()
	in := r.open(t, writeTestFile(t, filepath.Join(dir, "in.md"), "# I\n\nHi.\n"), DocOptions{})
	out := r.open(t, writeTestFile(t, filepath.Join(t.TempDir(), "out.md"), "# O\n\nHi.\n"), DocOptions{})

	got := r.waitInBackground(t, "sess-a", dir)
	r.press(t, in.ID)
	if w := receive(t, got, "the claim"); w.Room != in.Room {
		t.Fatalf("wake = %+v", w)
	}
	if owner := r.ownerOf(t, in.ID); owner != "sess-a" {
		t.Fatalf("owner = %q", owner)
	}
	if w, code := r.agentWait(t, "sess-b", dir, 1); code != http.StatusNoContent {
		t.Fatalf("the second session took it too: %+v", w)
	}
	if owner := r.ownerOf(t, out.ID); owner != "" {
		t.Fatalf("a document outside the folder was claimed by %q", owner)
	}
}

func (r *running) ownerOf(t *testing.T, id string) string {
	t.Helper()
	var views []DocView
	if code := r.call(t, http.MethodGet, "/api/docs", nil, &views); code != http.StatusOK {
		t.Fatalf("listing answered %d", code)
	}
	for _, v := range views {
		if v.ID == id {
			return v.Owner
		}
	}
	t.Fatalf("%s is not open", id)
	return ""
}

// A session that has stopped waiting is not reading: a Revise is refused as
// unheard rather than told it landed.
func TestAgentAttachmentEndsWhenTheSessionStopsWaiting(t *testing.T) {
	old := agentGrace
	agentGrace = 50 * time.Millisecond
	t.Cleanup(func() { agentGrace = old })
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	r := startServe(t, Options{Sessions: presence(t, "sess-a"), Every: 10 * time.Millisecond})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	if _, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("wait answered %d", code)
	}
	time.Sleep(4 * reArmFresh / 2) // past the grace, and past the re-arm wait
	code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise", map[string]any{}, nil)
	if code != http.StatusNotImplemented {
		t.Fatalf("Revise answered %d with nobody waiting, want 501", code)
	}
}

// A second session's open of a document a live session owns is refused as
// theirs, and changes nothing.
func TestOpenRefusesADocumentAnotherLiveSessionOwns(t *testing.T) {
	r := agentServer(t, "sess-a", "sess-b")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: doc, DocOptions: DocOptions{Owner: "sess-b"}}, nil)
	if code != http.StatusConflict {
		t.Fatalf("answered %d, want 409", code)
	}
	if code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: doc}, nil); code != http.StatusConflict {
		t.Fatalf("with no session answered %d, want 409", code)
	}
	if owner := r.ownerOf(t, a.ID); owner != "sess-a" {
		t.Fatalf("owner = %q", owner)
	}
	r.open(t, doc, DocOptions{Owner: "sess-a"}) // its own owner is answered
}

// A document whose session has gone is taken up by the session that asks for
// it, and the take-up lasts: its wakes go to the new owner, across a restart.
func TestOpenTakesUpADocumentWhoseSessionHasGone(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	sessions := presence(t, "sess-b")
	r := startServe(t, Options{Sessions: sessions, Every: time.Hour})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	// Opened while its owner was present, which has gone by the time anyone asks.
	if err := sessions.AnnounceSession("sess-a"); err != nil {
		t.Fatal(err)
	}
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	if err := sessions.WithdrawSession("sess-a"); err != nil {
		t.Fatal(err)
	}
	r.open(t, doc, DocOptions{Owner: "sess-b"})
	if owner := r.ownerOf(t, a.ID); owner != "sess-b" {
		t.Fatalf("owner = %q", owner)
	}
	r.stop()
	r = startServe(t, Options{Sessions: sessions, Every: time.Hour})
	if owner := r.ownerOf(t, a.ID); owner != "sess-b" {
		t.Fatalf("after a restart the owner = %q", owner)
	}
}

// An unowned document is claimed by the session that opens it.
func TestOpenClaimsAnUnownedDocument(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n")
	a := r.open(t, doc, DocOptions{})
	r.open(t, doc, DocOptions{Owner: "sess-a"})
	if owner := r.ownerOf(t, a.ID); owner != "sess-a" {
		t.Fatalf("owner = %q", owner)
	}
}

// Fresh replaces a review that has ended, and leaves one still open alone.
func TestOpenFreshReplacesAnEndedReview(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	in := OpenRequest{Path: doc, Fresh: true, DocOptions: DocOptions{Owner: "sess-a"}}
	if code := r.call(t, http.MethodPost, "/api/docs", in, nil); code != http.StatusOK {
		t.Fatalf("answered %d", code)
	}
	var st struct {
		Sealed bool `json:"sealed"`
	}
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise",
		map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
		t.Fatalf("approve answered %d", code)
	}
	if code := r.call(t, http.MethodPost, "/api/docs", in, nil); code != http.StatusOK {
		t.Fatalf("answered %d", code)
	}
	if code := r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/revise", nil, &st); code != http.StatusOK || st.Sealed {
		t.Fatalf("after Fresh: %d sealed=%v", code, st.Sealed)
	}
	// The session hears the approve it had not heard; replacing the review is
	// not a close it has to be told of.
	w, code := r.agentWait(t, "sess-a", "", 5)
	if code != http.StatusOK || w.Reason != "approve" {
		t.Fatalf("answered %d %+v", code, w)
	}
	if w, code := r.agentWait(t, "sess-a", "", 1); code != http.StatusNoContent {
		t.Fatalf("answered %d %+v", code, w)
	}
}

// The harness's report reaches every document the session owns, and no other's.
func TestAgentReportReachesOnlyTheSessionsDocuments(t *testing.T) {
	r := agentServer(t, "sess-a", "sess-b")
	dir := t.TempDir()
	a := r.open(t, writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n"), DocOptions{Owner: "sess-a"})
	b := r.open(t, writeTestFile(t, filepath.Join(dir, "b.md"), "# B\n\nHi.\n"), DocOptions{Owner: "sess-b"})
	state := func(id string) string {
		var st struct {
			Message struct {
				State string `json:"state"`
			} `json:"message"`
		}
		if code := r.call(t, http.MethodGet, "/api/docs/"+id+"/_galley/revise", nil, &st); code != http.StatusOK {
			t.Fatalf("revise state answered %d", code)
		}
		return st.Message.State
	}
	wa, wb := r.waitInBackground(t, "sess-a", ""), r.waitInBackground(t, "sess-b", "")
	r.press(t, a.ID)
	r.press(t, b.ID)
	wakeA, wakeB := receive(t, wa, "a"), receive(t, wb, "b")
	if wakeA.Report == "" || wakeB.Report == "" {
		t.Fatal("no report token")
	}
	report := map[string]string{"session": "sess-a", "event": "landed", "token": wakeA.Report}
	if code := r.call(t, http.MethodPost, "/api/agent/report", report, nil); code != http.StatusNoContent {
		t.Fatalf("report answered %d", code)
	}
	if got := state(a.ID); got != "with_agent" {
		t.Fatalf("the owner's message is %q", got)
	}
	if got := state(b.ID); got != "sent" {
		t.Fatalf("the other session's message is %q", got)
	}
	bad := map[string]string{"session": "sess-a", "event": "nonsense"}
	if code := r.call(t, http.MethodPost, "/api/agent/report", bad, nil); code != http.StatusBadRequest {
		t.Fatalf("a bad event answered %d", code)
	}
}

// galley_channel_status's answer: the documents, whether this session is
// waiting, and what recently left it.
func TestAgentStatusSaysWhatTheSessionHears(t *testing.T) {
	r := agentServer(t, "sess-a")
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{Owner: "sess-a"})
	status := func() AgentStatus {
		var st AgentStatus
		if code := r.call(t, http.MethodGet, "/api/agent/status?session=sess-a", nil, &st); code != http.StatusOK {
			t.Fatalf("status answered %d", code)
		}
		return st
	}
	if st := status(); st.Waiting || len(st.Docs) != 1 || st.Docs[0].ID != a.ID {
		t.Fatalf("status = %+v", st)
	}
	r.waitInBackground(t, "sess-a", "")
	time.Sleep(100 * time.Millisecond)
	if st := status(); !st.Waiting {
		t.Fatalf("status while waiting = %+v", st)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("close answered %d", code)
	}
	if st := status(); len(st.Gone) != 1 || !strings.Contains(st.Gone[0], doc) {
		t.Fatalf("status after the close = %+v", st)
	}
}

// An editor from before one server still holds the file: the two would erase
// each other, so the document is refused until it has gone.
func TestOpenRefusesADocumentAnOlderEditorHolds(t *testing.T) {
	r := agentServer(t)
	dir := t.TempDir()
	doc := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n")
	holder := exec.Command("sleep", "60")
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Process.Kill(); _ = holder.Wait() })
	advert := filepath.Join(dir, "a.serve.json")
	writeTestFile(t, advert, `{"url":"http://127.0.0.1:1","room":"a","page":"`+doc+`","pid":`+strconv.Itoa(holder.Process.Pid)+`}`)
	if code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: doc}, nil); code != http.StatusBadRequest {
		t.Fatalf("answered %d, want 400", code)
	}
	_ = holder.Process.Kill()
	_ = holder.Wait()
	r.open(t, doc, DocOptions{}) // its pid has gone, and the file left behind is nothing
}

// A session taking up a gone session's document doesn't inherit what that session
// configured: a Revise and a settle run nothing, here and across a restart.
func TestTakeUpDropsTheOldOwnersHooks(t *testing.T) {
	f := startHost(t)
	f.host.sessions = presence(t, "sess-a", "sess-b")
	f.host.savePath = filepath.Join(t.TempDir(), "docs.json")
	dir := t.TempDir()
	doc := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n")
	revised, settled := filepath.Join(dir, "revised"), filepath.Join(dir, "settled")
	id, err := f.host.openFor(OpenRequest{Path: doc, DocOptions: DocOptions{
		Owner: "sess-a", OnRevise: "touch " + revised, OnSettle: "touch " + settled, Quiet: time.Millisecond, Dir: dir,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.host.sessions.WithdrawSession("sess-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.host.openFor(OpenRequest{Path: doc, DocOptions: DocOptions{Owner: "sess-b"}}); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost, f.base+"/api/docs/"+id+"/_galley/revise", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = f.browser()
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	d, _ := f.host.doc(id)
	d.server.Notify.Touch("something new")
	time.Sleep(200 * time.Millisecond)
	for _, marker := range []string{revised, settled} {
		if _, err := os.Stat(marker); err == nil {
			t.Errorf("the old owner's hook ran: %s", filepath.Base(marker))
		}
	}
	saved, err := loadDocs(f.host.savePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved[0].Owner != "sess-b" || saved[0].OnRevise != "" || saved[0].OnSettle != "" || saved[0].Dir != "" {
		t.Errorf("docs.json holds %+v", saved)
	}
}

// A terminal's review stays when the session that adopted it ends: it was never
// that session's to take with it, and its `galley edit` keeps running.
func TestAdoptedDocumentOutlivesItsSession(t *testing.T) {
	adopt := map[string]func(t *testing.T, r *running, doc string){
		"by opening it": func(t *testing.T, r *running, doc string) {
			r.open(t, doc, DocOptions{Owner: "sess-a"})
		},
		"by waiting on its folder": func(t *testing.T, r *running, doc string) {
			r.agentWait(t, "sess-a", filepath.Dir(doc), 1)
		},
	}
	for name, how := range adopt {
		t.Run(name, func(t *testing.T) {
			t.Setenv("XDG_STATE_HOME", t.TempDir())
			sessions := presence(t, "sess-a")
			r := startServe(t, Options{Sessions: sessions, Every: 5 * time.Millisecond})
			doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
			a := r.open(t, doc, DocOptions{})
			how(t, r, doc)
			if owner := r.ownerOf(t, a.ID); owner != "sess-a" {
				t.Fatalf("adopted by %q", owner)
			}
			if err := sessions.WithdrawSession("sess-a"); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(5 * time.Second)
			for r.ownerOf(t, a.ID) != "" {
				if time.Now().After(deadline) {
					t.Fatal("it never went back to having no owner")
				}
				time.Sleep(5 * time.Millisecond)
			}
			time.Sleep(100 * time.Millisecond)
			if ids := r.ids(t); !slices.Contains(ids, a.ID) {
				t.Fatalf("the document left with the session: %v", ids)
			}
		})
	}
}

// The same when the session ends while the server is down.
func TestAdoptedDocumentComesBackUnownedAfterItsSessionEnds(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	sessions := presence(t, "sess-a")
	r := startServe(t, Options{Sessions: sessions, Every: time.Hour})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n")
	a := r.open(t, doc, DocOptions{})
	r.open(t, doc, DocOptions{Owner: "sess-a"})
	r.stop()
	if err := sessions.WithdrawSession("sess-a"); err != nil {
		t.Fatal(err)
	}
	r = startServe(t, Options{Sessions: sessions, Every: time.Hour})
	if ids := r.ids(t); !slices.Contains(ids, a.ID) {
		t.Fatalf("not reopened: %v", ids)
	}
	if owner := r.ownerOf(t, a.ID); owner != "" {
		t.Fatalf("owner = %q", owner)
	}
}
