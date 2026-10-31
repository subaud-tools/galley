package serve

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// isolated gives a test its own state directory and presence.
func isolated(t *testing.T) *running {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("GALLEY_HOME", "")
	return startServe(t, Options{Sessions: presence(t)})
}

func writeTestFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A verb finds a document through the server, by any path that names it.
func TestFindRuntimeAsksTheServer(t *testing.T) {
	doc := filepath.Join(t.TempDir(), "doc.md")
	if _, ok := FindRuntime(doc); ok {
		t.Fatal("found a document with no server running")
	}
	r := isolated(t)
	writeTestFile(t, doc, "# T\n")
	if _, ok := FindRuntime(doc); ok {
		t.Fatal("found a document the server does not hold")
	}
	a := r.open(t, doc, DocOptions{Owner: "session-a"})

	rt, ok := FindRuntime(doc)
	if !ok {
		t.Fatal("did not find the open document")
	}
	if want := r.base + "/api/docs/" + a.ID; rt.URL != want {
		t.Fatalf("URL = %q, want %q", rt.URL, want)
	}
	if rt.Owner != "session-a" || rt.Page != doc || rt.Room == "" {
		t.Fatalf("runtime = %+v", rt)
	}
	if strings.Contains(rt.URL, "t=") {
		t.Fatalf("the document's base carries the token: %s", rt.URL)
	}
}

// A page is reviewed through the content.md it extracts: either path finds it.
func TestFindRuntimeFindsAPageByEitherPath(t *testing.T) {
	r := isolated(t)
	page := writeTestFile(t, filepath.Join(t.TempDir(), "post.html"),
		"<!doctype html><html><head><title>x</title></head><body>\n<p>Hello world, edited in rounds.</p>\n</body></html>")
	r.open(t, page, DocOptions{})
	for _, p := range []string{page, AdvertisedPath(page)} {
		rt, ok := FindRuntime(p)
		if !ok {
			t.Fatalf("%s did not find the page", p)
		}
		if rt.Page != AdvertisedPath(page) {
			t.Fatalf("Page = %q, want the content.md", rt.Page)
		}
	}
}

// One directory can have two names (/tmp is /private/tmp on macOS). Two servers
// on one file each project their own document over the other's: the erasure
// the advert beside the document used to catch, whatever the spelling.
func TestOneDocumentByTwoSpellingsIsOneServer(t *testing.T) {
	r := isolated(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(real, "doc.md"), "# T\n")
	a := r.open(t, filepath.Join(real, "doc.md"), DocOptions{})
	b := r.open(t, filepath.Join(link, "doc.md"), DocOptions{})
	if a.ID != b.ID {
		t.Fatalf("two spellings got two documents: %s and %s", a.ID, b.ID)
	}
	if rt, ok := FindRuntime(filepath.Join(link, "doc.md")); !ok || !strings.HasSuffix(rt.URL, a.ID) {
		t.Fatalf("the other spelling found %+v, %v", rt, ok)
	}
}

// --root reaches the page across the server, and a restart.
func TestRootIsAnOpenOption(t *testing.T) {
	r := isolated(t)
	site := t.TempDir()
	writeTestFile(t, filepath.Join(site, "shared", "s.css"), "p{}\n")
	page := writeTestFile(t, filepath.Join(site, "sub", "post.html"),
		"<!doctype html><html><head><title>x</title></head><body>\n<p>Hello world, edited in rounds.</p>\n</body></html>")
	a := r.open(t, page, DocOptions{Root: site})
	if code := r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/preview/shared/s.css", nil, nil); code != http.StatusOK {
		t.Fatalf("an asset under the site root answered %d", code)
	}

	r.stop()
	r = startServe(t, Options{Sessions: presence(t)})
	if code := r.call(t, http.MethodGet, "/api/docs/"+a.ID+"/_galley/preview/shared/s.css", nil, nil); code != http.StatusOK {
		t.Fatalf("after a restart the asset answered %d", code)
	}
}

func TestRootOnMarkdownIsRefused(t *testing.T) {
	r := isolated(t)
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "doc.md"), "# T\n")
	code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: doc, DocOptions: DocOptions{Root: t.TempDir()}}, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("answered %d, want 400", code)
	}
}

// `--on-revise 'claude -p "$(galley agent-prompt doc.md)"'` names the document
// relative to where `galley edit` ran; the server runs in its state directory.
func TestRevisingHookRunsInTheOpenersDirectory(t *testing.T) {
	r := isolated(t)
	dir := t.TempDir()
	doc := writeTestFile(t, filepath.Join(dir, "doc.md"), "# T\n\nHi.\n")
	a := r.open(t, doc, DocOptions{OnRevise: "pwd > hook-ran", Dir: dir})
	r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/instruct",
		map[string]any{"op": "comment", "target": "Hi", "text": "more"}, nil)
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise", map[string]any{}, nil); code != http.StatusNoContent {
		t.Fatalf("revise answered %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "hook-ran")); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the hook did not run in the directory it was opened from")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// One file is one document, however it is named: a page by its content.md or
// its .htm twin, and a file by another case on a case-insensitive disk. A second
// server on it would erase the first, so a second live session is refused too.
func TestOneFileIsOneDocument(t *testing.T) {
	const page = "<!doctype html><html><body><h1>T</h1><p>Hi.</p></body></html>\n"
	spellings := func(t *testing.T, r *running) (first string, others []string) {
		t.Helper()
		dir := t.TempDir()
		first = writeTestFile(t, filepath.Join(dir, "page.html"), page)
		a := r.open(t, first, DocOptions{Owner: "sess-a"})
		return first, []string{a.Page, writeTestFile(t, filepath.Join(dir, "page.htm"), page)}
	}
	check := func(t *testing.T, r *running, first string, others []string) {
		t.Helper()
		id := r.open(t, first, DocOptions{Owner: "sess-a"}).ID
		for _, other := range others {
			if got := r.open(t, other, DocOptions{Owner: "sess-a"}).ID; got != id {
				t.Errorf("%s got its own document %s, want %s", other, got, id)
			}
			var said OpenAnswer
			code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: other, DocOptions: DocOptions{Owner: "sess-b"}}, &said)
			if code != http.StatusConflict {
				t.Errorf("a second session opening %s answered %d, want refused as theirs", other, code)
			}
		}
		if ids := r.ids(t); len(ids) != 1 {
			t.Errorf("open: %v, want one document", ids)
		}
	}

	t.Run("a page by its other names", func(t *testing.T) {
		r := agentServer(t, "sess-a", "sess-b")
		first, others := spellings(t, r)
		check(t, r, first, others)
	})
	t.Run("a file by another case", func(t *testing.T) {
		r := agentServer(t, "sess-a", "sess-b")
		dir := t.TempDir()
		upper := writeTestFile(t, filepath.Join(dir, "Case.md"), "# A\n\nHi.\n")
		lower := filepath.Join(dir, "case.md")
		ua, errA := os.Stat(upper)
		la, errB := os.Stat(lower)
		if errA != nil || errB != nil || !os.SameFile(ua, la) {
			t.Skip("this disk tells the cases apart")
		}
		r.open(t, upper, DocOptions{Owner: "sess-a"})
		check(t, r, upper, []string{lower})
	})
	// The file stays what it was opened as: a fresh review named by content.md
	// is still the page.
	t.Run("a fresh review by another name stays the page", func(t *testing.T) {
		r := agentServer(t, "sess-a")
		first, others := spellings(t, r)
		id := r.open(t, first, DocOptions{Owner: "sess-a"}).ID
		if code := r.call(t, http.MethodPost, "/api/docs/"+id+"/_galley/revise", map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
			t.Fatalf("approve answered %d", code)
		}
		var fresh OpenAnswer
		if code := r.call(t, http.MethodPost, "/api/docs", OpenRequest{Path: others[0], Fresh: true, DocOptions: DocOptions{Owner: "sess-a"}}, &fresh); code != http.StatusOK {
			t.Fatalf("a fresh open answered %d", code)
		}
		if fresh.ID != id {
			t.Fatalf("the fresh review is %s, want the page's %s", fresh.ID, id)
		}
	})
}
