package serve

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/tools-common/pageserve"
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

// A second `galley edit` on a document another one holds is refused with the
// address; one whose holder has gone takes the document up.
func TestOpenIsRefusedWhileAnotherEditorHoldsTheDocument(t *testing.T) {
	r := isolated(t)
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "doc.md"), "# T\n")

	holder := exec.Command("sleep", "60")
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Process.Kill(); _ = holder.Wait() })
	in := OpenRequest{Path: doc, Editor: holder.Process.Pid}
	var a OpenAnswer
	if code := r.call(t, http.MethodPost, "/api/docs", in, &a); code != http.StatusOK {
		t.Fatalf("first editor answered %d", code)
	}
	if rt, ok := FindRuntime(doc); !ok || rt.PID != holder.Process.Pid {
		t.Fatalf("the holder is not reported: %+v", rt)
	}
	second := OpenRequest{Path: doc, Editor: os.Getpid()}
	if code := r.call(t, http.MethodPost, "/api/docs", second, nil); code != http.StatusConflict {
		t.Fatalf("second editor answered %d, want 409", code)
	}
	if code := r.call(t, http.MethodPost, "/api/docs", in, nil); code != http.StatusOK {
		t.Fatalf("the holder itself answered %d", code)
	}
	_ = holder.Process.Kill()
	_ = holder.Wait()
	if code := r.call(t, http.MethodPost, "/api/docs", second, nil); code != http.StatusOK {
		t.Fatalf("after the holder went, the document was refused: %d", code)
	}
}

// Approving withdraws the registry entry the channel attaches through, at the
// moment of the verdict: a later scan must not attach and hear it again.
func TestApproveWithdrawsTheAdvert(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	sessions := presence(t)
	r := startServe(t, Options{Sessions: sessions})
	doc := writeTestFile(t, filepath.Join(t.TempDir(), "doc.md"), "# T\n\nHi.\n")
	a := r.open(t, doc, DocOptions{})
	rt, _ := FindRuntime(doc)
	if err := sessions.Write(pageserve.Entry{URL: rt.URL, Room: rt.Room, Page: rt.Page, PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	if code := r.call(t, http.MethodPost, "/api/docs/"+a.ID+"/_galley/revise",
		map[string]string{"verdict": "approve"}, nil); code != http.StatusNoContent {
		t.Fatalf("approve answered %d", code)
	}
	entries, err := sessions.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("still advertised after approve: %+v", entries)
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
