package serve

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	gws "github.com/gorilla/websocket"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ygsync "github.com/reearth/ygo/sync"
	"github.com/subaud-tools/galley/internal/ydoc"
	"github.com/subaud-tools/tools-common/pageserve"
)

// hostFixture is a Host behind a real pageserve.Run: localweb's token and
// host guards, pageserve's mux, and a real listener a websocket can hijack.
type hostFixture struct {
	host   *Host
	base   string // http://127.0.0.1:<port>
	cookie string // the Cookie header a browser holds after opening ?t=
}

func startHost(t *testing.T) *hostFixture {
	t.Helper()
	t.Setenv("GALLEY_HOME", t.TempDir())
	h := NewHost()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- pageserve.Run(ctx, pageserve.Options{
			Live: pageserve.LiveFor("galley"), API: h.Handler(),
			Assets: fstest.MapFS{"index.html": {Data: []byte("front")}},
			Ready:  func(u string) { ready <- u },
		})
	}()
	t.Cleanup(func() {
		for _, d := range h.List() {
			_ = h.Close(d.ID)
		}
		cancel()
		if err := <-done; err != nil {
			t.Errorf("pageserve.Run: %v", err)
		}
	})
	var addr string
	select {
	case addr = <-ready:
	case err := <-done:
		t.Fatalf("pageserve.Run exited: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("pageserve.Run never became ready")
	}
	u, err := url.Parse(addr)
	if err != nil {
		t.Fatal(err)
	}
	f := &hostFixture{host: h, base: "http://" + u.Host}
	// The browser's way in: ?t= answers with the cookie and a redirect.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(addr)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	for _, c := range resp.Cookies() {
		f.cookie = c.Name + "=" + c.Value
	}
	if f.cookie == "" {
		t.Fatal("opening the token URL set no cookie")
	}
	return f
}

func (f *hostFixture) open(t *testing.T, dir, content string) (id, path string) {
	t.Helper()
	path = filepath.Join(t.TempDir(), dir, "doc.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := f.host.Open(path, DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return id, path
}

// room is the room a page gets from its shell.
func (f *hostFixture) room(t *testing.T, id string) string {
	t.Helper()
	d, ok := f.host.doc(id)
	if !ok {
		t.Fatalf("document %s is not open", id)
	}
	return d.server.Room
}

// dial opens a websocket to the document's room with the given headers.
func (f *hostFixture) dial(id, room string, header http.Header) (*gws.Conn, *http.Response, error) {
	u := "ws" + strings.TrimPrefix(f.base, "http") + "/api/docs/" + id + "/yjs/" + room
	return gws.DefaultDialer.Dial(u, header)
}

// dialRefused dials with the headers and wants the upgrade refused with status.
func (f *hostFixture) dialRefused(t *testing.T, id string, header http.Header, status int) {
	t.Helper()
	conn, resp, err := f.dial(id, f.room(t, id), header)
	if resp != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if err == nil {
		_ = conn.Close()
		t.Fatalf("the websocket was accepted, want %d", status)
	}
	if resp == nil || resp.StatusCode != status {
		t.Fatalf("websocket: %v, response %+v, want %d", err, resp, status)
	}
}

// browser is what a tab on this server sends: its cookie and its own origin.
func (f *hostFixture) browser() http.Header {
	return http.Header{"Cookie": {f.cookie}, "Origin": {f.base}}
}

// peer is a synced y-websocket client of one document.
type peer struct {
	conn *gws.Conn
	doc  *crdt.Doc
}

func (f *hostFixture) connect(t *testing.T, id string) *peer {
	t.Helper()
	conn, resp, err := f.dial(id, f.room(t, id), f.browser())
	if err != nil {
		t.Fatalf("websocket through pageserve: %v (response %+v)", err, resp)
	}
	_ = resp.Body.Close()
	t.Cleanup(func() { _ = conn.Close() })
	doc := crdt.New(crdt.WithClientID(1))
	drainHandshake(t, conn, doc)
	return &peer{conn: conn, doc: doc}
}

// typeText appends text to the first paragraph and sends it the way
// y-websocket does: an update inside a sync envelope.
func (p *peer) typeText(t *testing.T, text string) {
	t.Helper()
	para, ok := p.doc.GetXmlFragment(ydoc.FragmentName).Children()[0].(*crdt.YXmlElement)
	if !ok {
		t.Fatal("the first block is not an element")
	}
	run, ok := para.Children()[0].(*crdt.YXmlText)
	if !ok {
		t.Fatal("the paragraph holds no text")
	}
	at := run.Len() // read before the transaction: reads inside one deadlock
	p.doc.Transact(func(txn *crdt.Transaction) { run.Insert(txn, at, text, nil) })
	enc := encoding.NewEncoder()
	enc.WriteVarUint(wsOuterSync)
	enc.WriteRaw(ygsync.EncodeUpdate(p.doc.EncodeStateAsUpdate()))
	if err := p.conn.WriteMessage(gws.BinaryMessage, enc.Bytes()); err != nil {
		t.Fatalf("send update: %v", err)
	}
}

func waitForFile(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var got []byte
	for time.Now().Before(deadline) {
		got, _ = os.ReadFile(path)
		if strings.Contains(string(got), want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s never held %q; it holds:\n%s", path, want, got)
}

func fileLacks(t *testing.T, path, unwanted string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), unwanted) {
		t.Fatalf("%s holds %q, typed into the other document:\n%s", path, unwanted, got)
	}
}

func TestHostTwoDocumentsSyncToTheirOwnFiles(t *testing.T) {
	f := startHost(t)
	// The same base name, so nothing can lean on the file's name to tell them apart.
	idA, pathA := f.open(t, "a", "hello from a\n")
	idB, pathB := f.open(t, "b", "hello from b\n")
	if idA == idB {
		t.Fatalf("two paths got one id %s", idA)
	}

	f.connect(t, idA).typeText(t, " typed-into-a")
	f.connect(t, idB).typeText(t, " typed-into-b")

	waitForFile(t, pathA, "typed-into-a")
	waitForFile(t, pathB, "typed-into-b")
	fileLacks(t, pathA, "typed-into-b")
	fileLacks(t, pathB, "typed-into-a")
}

func TestHostSamePathGetsTheSameID(t *testing.T) {
	f := startHost(t)
	id, path := f.open(t, "a", "hello\n")
	again, err := f.host.Open(path, DocOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if again != id || id != pageserve.Token(path) {
		t.Fatalf("ids %s and %s, want both %s", id, again, pageserve.Token(path))
	}
	if docs := f.host.List(); len(docs) != 1 || docs[0].ID != id || docs[0].Path != path {
		t.Fatalf("List = %+v, want the one document", docs)
	}
}

func TestHostRefusesRequestsWithoutTheToken(t *testing.T) {
	f := startHost(t)
	id, _ := f.open(t, "a", "hello\n")

	f.dialRefused(t, id, http.Header{"Origin": {f.base}}, http.StatusUnauthorized)

	pending := f.base + "/api/docs/" + id + "/_galley/pending"
	r, err := http.Get(pending)
	if err != nil {
		t.Fatal(err)
	}
	_ = r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("JSON route with no token answered %d, want 401", r.StatusCode)
	}

	// The same route with the cookie reaches the document: the 401 was the token's.
	req, err := http.NewRequest(http.MethodGet, pending, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Cookie", f.cookie)
	r, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	_ = r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("JSON route with the cookie answered %d: %s", r.StatusCode, body)
	}
}

func TestHostRefusesAWebsocketFromAForeignOrigin(t *testing.T) {
	f := startHost(t)
	id, _ := f.open(t, "a", "hello\n")
	f.dialRefused(t, id, http.Header{"Cookie": {f.cookie}, "Origin": {"http://evil.example"}}, http.StatusForbidden)
}

func TestHostCloseLeavesTheOtherDocumentSyncing(t *testing.T) {
	f := startHost(t)
	idA, _ := f.open(t, "a", "hello from a\n")
	idB, pathB := f.open(t, "b", "hello from b\n")
	f.connect(t, idA)
	b := f.connect(t, idB)

	if err := f.host.Close(idA); err != nil {
		t.Fatal(err)
	}
	if err := f.host.Close(idA); err == nil {
		t.Fatal("closing a closed document reported no error")
	}

	b.typeText(t, " after-the-close")
	waitForFile(t, pathB, "after-the-close")

	req, err := http.NewRequest(http.MethodGet, f.base+"/api/docs/"+idA+"/_galley/pending", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Cookie", f.cookie)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = r.Body.Close()
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("a closed document answered %d, want 404", r.StatusCode)
	}
	if docs := f.host.List(); len(docs) != 1 || docs[0].ID != idB {
		t.Fatalf("List = %+v, want only %s", docs, idB)
	}
}
