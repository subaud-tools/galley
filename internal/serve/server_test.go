package serve

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/docmodel"
	"github.com/subaud-tools/galley/internal/htmlpage"
	"github.com/subaud-tools/galley/internal/markdown"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

// presence is a temp directory of session presence, the one a channel writes.
func presence(t *testing.T, sessions ...string) pageserve.Live {
	t.Helper()
	l := pageserve.Live{Tool: "galley", Dir: t.TempDir()}
	for _, s := range sessions {
		if err := l.AnnounceSession(s); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

// running is a real Run, on a free port under the test's own state directory.
type running struct {
	base, token string
	stop        func()
}

func startServe(t *testing.T, o Options) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	o.Ready = func(u string) { ready <- u }
	go func() { done <- Run(ctx, o) }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
	}
	t.Cleanup(stop)
	select {
	case addr := <-ready:
		u, err := url.Parse(addr)
		if err != nil {
			t.Fatal(err)
		}
		return &running{base: "http://" + u.Host, token: u.Query().Get("t"), stop: stop}
	case err := <-done:
		t.Fatalf("Run exited: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("Run never became ready")
	}
	return nil
}

// call makes a request the way a CLI client does, with the token header.
func (r *running) call(t *testing.T, method, path string, body, out any) int {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, r.base+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(localweb.TokenHeader, r.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func (r *running) open(t *testing.T, path string, o DocOptions) OpenAnswer {
	t.Helper()
	var a OpenAnswer
	if code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: path, DocOptions: o}, &a); code != http.StatusOK {
		t.Fatalf("opening %s answered %d", path, code)
	}
	return a
}

func (r *running) ids(t *testing.T) []string {
	t.Helper()
	var views []DocView
	if code := r.call(t, http.MethodGet, "/api/docs", nil, &views); code != http.StatusOK {
		t.Fatalf("listing answered %d", code)
	}
	ids := make([]string, 0, len(views))
	for _, v := range views {
		ids = append(ids, v.ID)
	}
	slices.Sort(ids)
	return ids
}

func writeDoc(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDocsRoutes(t *testing.T) {
	t.Setenv("GALLEY_HOME", t.TempDir())
	r := startServe(t, Options{Sessions: presence(t), Every: time.Hour})
	path := writeDoc(t, "doc.md", "hello\n")

	a := r.open(t, path, DocOptions{})
	if want := r.base + "/api/docs/" + a.ID + "/?t=" + r.token; a.URL != want {
		t.Fatalf("URL = %q, want %q", a.URL, want)
	}
	if ids := r.ids(t); !slices.Equal(ids, []string{a.ID}) {
		t.Fatalf("listed %v, want %s", ids, a.ID)
	}
	if code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: "doc.md"}, nil); code != http.StatusBadRequest {
		t.Fatalf("a relative path answered %d, want 400", code)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("closing answered %d", code)
	}
	if ids := r.ids(t); len(ids) != 0 {
		t.Fatalf("still listed %v", ids)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNotFound {
		t.Fatalf("closing a closed document answered %d, want 404", code)
	}
}

func TestRestartReloadsLiveDocuments(t *testing.T) {
	t.Setenv("GALLEY_HOME", t.TempDir())
	sessions := presence(t, "alive", "gone")
	o := Options{Sessions: sessions, Every: time.Hour}
	first := startServe(t, o)

	owned := first.open(t, writeDoc(t, "owned.md", "owned\n"), DocOptions{Owner: "alive", OnRevise: "true", Quiet: time.Minute})
	unowned := first.open(t, writeDoc(t, "unowned.md", "unowned\n"), DocOptions{})
	orphan := first.open(t, writeDoc(t, "orphan.md", "orphan\n"), DocOptions{Owner: "gone"})
	page := first.open(t, writeDoc(t, "page.html", "<!doctype html><html><body><h1>Page</h1></body></html>\n"), DocOptions{})

	first.stop()
	if err := sessions.WithdrawSession("gone"); err != nil {
		t.Fatal(err)
	}
	second := startServe(t, o)
	defer second.stop()

	if second.token != first.token {
		t.Fatalf("the token changed across the restart")
	}
	want := []string{owned.ID, unowned.ID, page.ID}
	slices.Sort(want)
	if ids := second.ids(t); !slices.Equal(ids, want) {
		t.Fatalf("after the restart %v, want %v (the gone owner's %s must not come back)", ids, want, orphan.ID)
	}
	var shell string
	for _, a := range []OpenAnswer{owned, page} {
		req, err := http.NewRequest(http.MethodGet, second.base+"/api/docs/"+a.ID+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(localweb.TokenHeader, first.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var b bytes.Buffer
		_, _ = b.ReadFrom(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s answered %d after the restart", a.ID, resp.StatusCode)
		}
		shell = b.String()
	}
	// The page came back as a page, not as markdown.
	if !strings.Contains(shell, "data-preview=") {
		t.Fatalf("the page did not come back in page mode:\n%s", shell)
	}
	saved, err := loadDocs(DocsPath())
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 3 {
		t.Fatalf("docs.json holds %+v, want the three that came back", saved)
	}
	for _, d := range saved {
		if d.Owner == "alive" && (d.OnRevise != "true" || d.Quiet != time.Minute) {
			t.Fatalf("the options did not survive: %+v", d)
		}
	}
}

func TestStaleBinaryMarksEntry(t *testing.T) {
	t.Setenv("GALLEY_HOME", t.TempDir())
	exe := writeDoc(t, "galley", "the old build")
	startServe(t, Options{Sessions: presence(t), Exe: exe, Every: 5 * time.Millisecond})

	time.Sleep(30 * time.Millisecond)
	if e, err := Running(); err != nil || e.Stale {
		t.Fatalf("before the install: %+v, %v", e, err)
	}
	// An install writes a new file over the old name.
	fresh := exe + ".new"
	if err := os.WriteFile(fresh, []byte("the new build"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(fresh, exe); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		e, err := Running()
		if err == nil && e.Stale {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the entry was never marked stale: %+v, %v", e, err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// panicOn makes the parsers panic on any file holding marker, as a parser bug
// tripped by one document would.
func panicOn(t *testing.T, marker string) {
	t.Helper()
	oldParse, oldExtract := parseMarkdown, extractPage
	t.Cleanup(func() { parseMarkdown, extractPage = oldParse, oldExtract })
	parseMarkdown = func(raw []byte) (docmodel.Doc, []markdown.InlineComment, error) {
		if bytes.Contains(raw, []byte(marker)) {
			panic("parser bug")
		}
		return oldParse(raw)
	}
	extractPage = func(raw []byte) (*htmlpage.Extraction, error) {
		if bytes.Contains(raw, []byte(marker)) {
			panic("parser bug")
		}
		return oldExtract(raw)
	}
}

func TestOutsideSaveThatPanicsFailsAlone(t *testing.T) {
	panicOn(t, "BOOM")
	f := startHost(t)
	idA, pathA := f.open(t, "a", "hello from a\n")
	idB, pathB := f.open(t, "b", "hello from b\n")
	peerA, peerB := f.connect(t, idA), f.connect(t, idB)

	const outside = "an outside save BOOM\n"
	if err := os.WriteFile(pathA, []byte(outside), 0o600); err != nil {
		t.Fatal(err)
	}
	// The keystroke's debounced projection is what reads the save, on a
	// goroutine of its own, where a panic would take the whole process down.
	peerA.typeText(t, " typed-into-a")
	d, _ := f.host.doc(idA)
	deadline := time.Now().Add(5 * time.Second)
	for d.server.diskNotice() == "" {
		if time.Now().After(deadline) {
			t.Fatal("the unreadable save was never reported on its document")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got, _ := os.ReadFile(pathA); string(got) != outside {
		t.Fatalf("the save galley could not read was written over: %q", got)
	}

	peerB.typeText(t, " typed-into-b")
	waitForFile(t, pathB, "typed-into-b")
}

// A file that panics the parser fails its own open, so it cannot take the server
// down at every restart.
func TestOpenThatPanicsFailsAlone(t *testing.T) {
	panicOn(t, "BOOM")
	f := startHost(t)
	for _, path := range []string{writeDoc(t, "doc.md", "BOOM\n"), writeDoc(t, "page.html", "<html><body><h1>BOOM</h1></body></html>\n")} {
		if _, err := f.host.Open(path, DocOptions{}); err == nil {
			t.Fatalf("%s opened", path)
		}
	}
}

func TestUnloadRules(t *testing.T) {
	sweep := func(f *hostFixture, n int) {
		for range n {
			f.host.sweep()
		}
	}
	open := func(t *testing.T, f *hostFixture, o DocOptions) string {
		t.Helper()
		id, err := f.host.Open(writeDoc(t, "doc.md", "hello\n"), o)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	isOpen := func(f *hostFixture, id string) bool {
		_, ok := f.host.doc(id)
		return ok
	}

	t.Run("an owner gone unloads, past a channel's restart", func(t *testing.T) {
		f := startHost(t)
		f.host.sessions = presence(t, "s")
		id := open(t, f, DocOptions{Owner: "s"})
		sweep(f, unloadGrace*2)
		if !isOpen(f, id) {
			t.Fatal("unloaded while its owner was live")
		}
		if err := f.host.sessions.WithdrawSession("s"); err != nil {
			t.Fatal(err)
		}
		sweep(f, unloadGrace-1)
		if err := f.host.sessions.AnnounceSession("s"); err != nil {
			t.Fatal(err)
		}
		sweep(f, 1)
		if err := f.host.sessions.WithdrawSession("s"); err != nil {
			t.Fatal(err)
		}
		sweep(f, unloadGrace-1)
		if !isOpen(f, id) {
			t.Fatal("unloaded over a gap the owner came back from")
		}
		sweep(f, 1)
		if isOpen(f, id) {
			t.Fatal("still open with its owner gone")
		}
	})

	t.Run("approved with no page unloads", func(t *testing.T) {
		f := startHost(t)
		id := open(t, f, DocOptions{})
		page := f.connect(t, id)
		d, _ := f.host.doc(id)
		d.server.approveReview(false)
		sweep(f, unloadGrace*2)
		if !isOpen(f, id) {
			t.Fatal("unloaded while a page held it")
		}
		_ = page.conn.Close()
		deadline := time.Now().Add(5 * time.Second)
		for d.server.pages.Load() > 0 {
			if time.Now().After(deadline) {
				t.Fatal("the page never left")
			}
			time.Sleep(10 * time.Millisecond)
		}
		sweep(f, unloadGrace)
		if isOpen(f, id) {
			t.Fatal("still open, approved with no page")
		}
	})

	t.Run("no owner stays", func(t *testing.T) {
		f := startHost(t)
		id := open(t, f, DocOptions{})
		sweep(f, unloadGrace*2)
		if !isOpen(f, id) {
			t.Fatal("a document with no owner was unloaded")
		}
	})
}

// The bar's Done closes its document and leaves the server serving the others.
func TestDoneClosesOnlyItsDocument(t *testing.T) {
	f := startHost(t)
	idA, _ := f.open(t, "a", "hello\n")
	idB, _ := f.open(t, "b", "hello\n")
	d, _ := f.host.doc(idA)
	d.server.OnStop()
	if docs := f.host.List(); len(docs) != 1 || docs[0].ID != idB {
		t.Fatalf("after Done: %+v, want only %s", docs, idB)
	}
}
