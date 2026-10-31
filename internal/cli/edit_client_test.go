package cli

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/localweb"
)

// editing is a real `galley edit` in its own process, with what it has printed.
type editing struct {
	cmd    *exec.Cmd
	errLog string // where its stderr goes
	exited chan error
	url    string
}

// startEdit runs `galley edit` and waits for it to print the document's address.
func startEdit(t *testing.T, exe string, args ...string) *editing {
	t.Helper()
	cmd := exec.Command(exe, append([]string{"edit", "--no-open"}, args...)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	e := &editing{cmd: cmd, errLog: filepath.Join(t.TempDir(), "stderr"), exited: make(chan error, 1)}
	errFile, err := os.Create(e.errLog)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = errFile.Close() }()
	cmd.Stderr = errFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-e.exited:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
		}
	})
	lines := bufio.NewScanner(stdout)
	addr := make(chan string, 1)
	go func() {
		sent := false
		for lines.Scan() {
			if rest, ok := strings.CutPrefix(lines.Text(), "serving"); ok && !sent {
				addr <- strings.TrimSpace(rest)
				sent = true
			}
		}
		e.exited <- cmd.Wait()
	}()
	select {
	case e.url = <-addr:
	case err := <-e.exited:
		e.exited <- err
		t.Fatalf("galley edit exited before it printed an address: %v: %s", err, e.stderr())
	case <-time.After(15 * time.Second):
		t.Fatal("galley edit printed no address")
	}
	return e
}

func (e *editing) stderr() string {
	b, _ := os.ReadFile(e.errLog)
	return string(b)
}

func (e *editing) waitExit(t *testing.T) error {
	t.Helper()
	select {
	case err := <-e.exited:
		e.exited <- err
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("galley edit did not exit")
		return nil
	}
}

// `galley edit` starts the server, registers the document, prints an address
// that signs a browser in, and stays. Ctrl-C closes the document and leaves the
// server, and nothing is written beside the document.
func TestEditRegistersAndCtrlCCloses(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	e := startEdit(t, buildGalley(t), doc)

	rt, ok := serve.FindRuntime(doc)
	if !ok {
		t.Fatal("the server does not hold the document")
	}
	if !strings.HasPrefix(e.url, rt.URL+"/?t=") {
		t.Fatalf("printed %q, want the document's address with the token", e.url)
	}
	entry, err := serve.Running()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(e.url, "t="+entry.Token) {
		t.Fatalf("printed %q, which does not sign in", e.url)
	}
	select {
	case err := <-e.exited:
		t.Fatalf("galley edit left at once: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}

	if err := e.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	if err := e.waitExit(t); err != nil {
		t.Fatalf("Ctrl-C: %v: %s", err, e.stderr())
	}
	if _, ok := serve.FindRuntime(doc); ok {
		t.Fatal("Ctrl-C left the document open")
	}
	if _, err := serve.Running(); err != nil {
		t.Fatalf("Ctrl-C took the server with it: %v", err)
	}
	files, err := filepath.Glob(filepath.Join(dir, "doc.*"))
	if err != nil || len(files) != 1 {
		t.Fatalf("beside the document: %v (%v)", files, err)
	}
}

// Closed from anywhere else (the page's Done, an unload), it ends too.
func TestEditExitsWhenTheDocumentCloses(t *testing.T) {
	isolate(t)
	doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n")
	e := startEdit(t, buildGalley(t), doc)
	rt, ok := serve.FindRuntime(doc)
	if !ok {
		t.Fatal("not open")
	}
	if err := postStop(rt.URL); err != nil {
		t.Fatal(err)
	}
	if err := e.waitExit(t); err != nil {
		t.Fatalf("exit: %v: %s", err, e.stderr())
	}
}

// A second `galley edit` on the document is given the same document, not a
// second server: the two would erase each other.
func TestSecondEditGetsTheSameDocument(t *testing.T) {
	isolate(t)
	doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n")
	exe := buildGalley(t)
	first := startEdit(t, exe, doc)
	second := startEdit(t, exe, doc)
	if first.url != second.url {
		t.Fatalf("two addresses: %s and %s", first.url, second.url)
	}
}

// --port goes to the server only when this command starts it; a server already
// running on another port is said on stderr, and the document opens there.
func TestPortOnlyReachesAServerThisCommandStarts(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	exe := buildGalley(t)
	first, err := localweb.FreePort()
	if err != nil {
		t.Fatal(err)
	}
	startEdit(t, exe, "--port", strconv.Itoa(first), writeDoc(t, dir, "a.md", "# A\n"))
	entry, err := serve.Running()
	if err != nil {
		t.Fatal(err)
	}
	if want := "http://127.0.0.1:" + strconv.Itoa(first); entry.Base != want {
		t.Fatalf("server at %s, want %s", entry.Base, want)
	}

	other := startEdit(t, exe, "--port", strconv.Itoa(first+1), writeDoc(t, dir, "b.md", "# B\n"))
	if !strings.HasPrefix(other.url, entry.Base+"/") {
		t.Fatalf("second document at %s, want on %s", other.url, entry.Base)
	}
	if !strings.Contains(other.stderr(), entry.Base) {
		t.Fatalf("stderr did not say where the server is: %q", other.stderr())
	}
}

// The verbs find their document through the server, by its path alone.
func TestVerbsFindTheirDocumentThroughTheServer(t *testing.T) {
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nThe budget.\n")
	rt := openOnServer(t, doc, serve.DocOptions{})

	postJSON(t, rt.URL+"/_galley/instruct", map[string]any{"op": "comment", "target": "budget", "text": "bound it"})
	view, isLive, err := loadPending(doc)
	if err != nil || !isLive || len(view.Instructions) != 1 {
		t.Fatalf("pending: live %v, %+v, %v", isLive, view, err)
	}

	woke := make(chan waitResult, 1)
	go func() {
		res, err := waitFor(rt.URL, "", 10*time.Second)
		if err != nil {
			t.Errorf("wait: %v", err)
		}
		woke <- res
	}()
	time.Sleep(200 * time.Millisecond) // the wait arms
	if out, errw, code := galleyCLI(t, "revise", doc); code != 0 {
		t.Fatalf("revise: exit %d: %s%s", code, out, errw)
	}
	select {
	case res := <-woke:
		if res.Reason != reasonRevise || len(res.Pending.Instructions) != 1 {
			t.Fatalf("wait woke with %+v", res)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("wait never woke")
	}
	if out, errw, code := galleyCLI(t, "ack", doc, "--state", "working", "--note", "on it"); code != 0 {
		t.Fatalf("ack: exit %d: %s%s", code, out, errw)
	}
	if out, errw, code := galleyCLI(t, "cannot", doc, "--why", "no source"); code != 0 {
		t.Fatalf("cannot: exit %d: %s%s", code, out, errw)
	}
	// round and render read what the server writes, with or without it.
	if _, errw, code := galleyCLI(t, "round", doc, "--json"); code != 0 {
		t.Fatalf("round: exit %d: %s", code, errw)
	}
	if _, errw, code := galleyCLI(t, "render", doc, "-o", filepath.Join(dir, "out.html")); code != 0 {
		t.Fatalf("render: exit %d: %s", code, errw)
	}
}

// With no server the verbs say what they always said: pending and cannot work
// from the file, and the rest refuse.
func TestVerbsWithNoServer(t *testing.T) {
	isolate(t)
	doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n")
	if _, isLive, err := loadPending(doc); err != nil || isLive {
		t.Fatalf("pending: live %v, %v", isLive, err)
	}
	for _, verb := range [][]string{{"wait", doc}, {"revise", doc}, {"ack", doc, "--state", "working"}} {
		if _, errw, code := galleyCLI(t, verb...); code == 0 || !strings.Contains(errw, "no server running") {
			t.Fatalf("%s: exit %d: %s", verb[0], code, errw)
		}
	}
	if _, errw, code := galleyCLI(t, "cannot", doc, "--why", "no source"); code != 0 {
		t.Fatalf("cannot: exit %d: %s", code, errw)
	}
	if _, err := serve.Running(); err == nil {
		t.Fatal("a verb started the server")
	}
}

// A blocked `galley wait` hears the document close, as it heard an editor stop.
func TestWaitIsToldWhenTheDocumentCloses(t *testing.T) {
	doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n")
	rt := openOnServer(t, doc, serve.DocOptions{})
	got := make(chan int, 1)
	go func() {
		_, _, code := galleyCLI(t, "wait", doc)
		got <- code
	}()
	time.Sleep(200 * time.Millisecond)
	if err := postStop(rt.URL); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-got:
		if code != 4 {
			t.Fatalf("wait exited %d, want 4: the editor stopped", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("wait never heard the document close")
	}
	// A poll that re-arms on the closed document hears the same.
	if _, err := waitFor(rt.URL, "", time.Second); !errors.Is(err, errWaitStopped) {
		t.Fatalf("re-arming on a closed document: %v", err)
	}
}

// The token goes to the server and to nothing else on this machine.
func TestTheTokenGoesOnlyToTheServer(t *testing.T) {
	doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n")
	rt := openOnServer(t, doc, serve.DocOptions{})
	saw := make(chan string, 1)
	other := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		saw <- r.Header.Get(localweb.TokenHeader)
	}))
	t.Cleanup(other.Close)
	resp, err := serverClient.Get(other.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if got := <-saw; got != "" {
		t.Fatalf("another server got the token %q", got)
	}
	if st, err := reviseState(rt.URL); err != nil || st.Sealed {
		t.Fatalf("the server refused the call: %+v, %v", st, err)
	}
}
