// host.go is one process holding many documents: a Host keeps one EditServer
// per open document, each with its own ygo room and websocket server, behind
// /api/docs/<id>/ on pageserve's one port and token.
package serve

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/subaud-tools/galley/internal/docmodel"
	"github.com/subaud-tools/galley/internal/htmlpage"
	"github.com/subaud-tools/galley/internal/markdown"
	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

// docsPrefix is where every open document's routes live.
const docsPrefix = "/api/docs/"

// unloadGrace is how many checks in a row a document must meet an unload rule
// before it goes. A channel can restart within a living session and a page
// reloads, each leaving a gap of a moment; at a one-second tick this rides those
// out, as `galley edit`'s owner watch does.
const unloadGrace = 6

// DocOptions is how a document is opened, saved with it in docs.json.
type DocOptions struct {
	// Owner is the session the document belongs to and leaves with; "": none,
	// and it stays until closed.
	Owner string `json:"owner,omitempty"`
	// Adopted is an Owner that took up a document opened with none: when that
	// session ends the document goes back to having none, rather than leaving.
	Adopted  bool          `json:"adopted,omitempty"`
	OnRevise string        `json:"on_revise,omitempty"` // the command a Revise runs
	OnSettle string        `json:"on_settle,omitempty"` // the command a settle in live mode runs
	Quiet    time.Duration `json:"quiet,omitempty"`     // how long before a settle; 0: the default
	// Root is a page's site root, its preview's assets served from there; "":
	// the page's own directory. An error on anything but a page.
	Root string `json:"root,omitempty"`
	// Dir is where OnRevise and OnSettle run: the directory the document was
	// opened from, since the server runs in its own. "": the server's.
	Dir string `json:"dir,omitempty"`
}

// DocView is one open document as List reports it.
type DocView struct {
	ID    string `json:"id"`
	Path  string `json:"path"`            // the path it was opened by: a page's own .html
	Page  string `json:"page"`            // the file under review: a page's content.md
	Room  string `json:"room"`            // its websocket room
	URL   string `json:"url"`             // the document's base, without the token
	Owner string `json:"owner,omitempty"` // the session it belongs to
}

// OpenRequest is the body of POST /api/docs.
type OpenRequest struct {
	Path string `json:"path"` // absolute: the server runs in its own directory
	// Fresh replaces a review that has ended with a new one: galley_open's ask.
	Fresh bool `json:"fresh,omitempty"`
	DocOptions
}

// OpenAnswer is what POST /api/docs answers. URL carries the token, so opening
// it signs a browser in.
type OpenAnswer struct {
	ID   string `json:"id"`
	URL  string `json:"url"`
	Page string `json:"page"` // the file under review
	Room string `json:"room"`
	// Pages is how many pages hold it now, so an opener opens one only when
	// none does.
	Pages int `json:"pages"`
}

// hostedDoc is one open document and its routes, built once.
type hostedDoc struct {
	path    string
	options DocOptions
	server  *EditServer
	handler http.Handler
}

// Host holds the open documents.
type Host struct {
	sessions pageserve.Live // where an owner's presence is read
	log      io.Writer
	savePath string // docs.json; "": not kept
	token    string // what the control routes' header must carry; "": refuses all

	mu      sync.Mutex
	docs    map[string]hostedDoc // by id
	address string               // the server's URL with its token

	misses map[string]int // id -> checks in a row an unload rule held; the watch's own

	exe     string      // the binary serve runs, watched for an install
	exeInfo os.FileInfo // exe as it was when serve started
	stale   bool        // exe was replaced and the entry says so; the watch's own

	agents *agents // the sessions waiting on their documents
}

// NewHost returns a Host with nothing open.
func NewHost() *Host {
	return &Host{docs: map[string]hostedDoc{}, misses: map[string]int{}, log: io.Discard, agents: newAgents()}
}

// Open serves the document at path and returns its id, the same for the same
// file always, however it is named. A document already open keeps its server
// and its options: two servers on one file each parse it into their own
// document and project it over the other's, erasing it with nothing logged.
func (h *Host) Open(path string, o DocOptions) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id, added, err := h.openLocked(path, o)
	if err != nil || !added {
		return id, err
	}
	if err := h.saveLocked(); err != nil {
		d := h.docs[id]
		delete(h.docs, id)
		return "", errors.Join(fmt.Errorf("keeping %s open: %w", path, err), d.server.Close())
	}
	return id, nil
}

// openLocked opens the document unless it is open already. h.mu is held.
func (h *Host) openLocked(path string, o DocOptions) (id string, added bool, err error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", false, err
	}
	id, open := h.openIDLocked(abs)
	if open {
		return id, false, nil
	}
	if err := refuseOlderEditor(abs); err != nil {
		return "", false, err
	}
	s, err := newServerFor(abs, o.Root)
	if err != nil {
		return "", false, err
	}
	s.Base = strings.TrimSuffix(docsPrefix, "/") + "/" + id
	s.Log = func(line string) { _, _ = fmt.Fprintf(h.log, "%s: %s\n", abs, line) }
	s.OnRevise = o.OnRevise
	s.HookDir = o.Dir
	s.Notify.Dir = o.Dir
	if o.Quiet > 0 {
		s.Notify.Quiet = o.Quiet
	}
	if o.OnSettle != "" {
		s.Notify.Command = o.OnSettle
		s.Notify.Log = s.Log
	}
	// What the document arrived carrying is not news.
	s.SeedNotify()
	// The bar's Done closes the document, and only it.
	s.OnStop = func() {
		if err := h.Close(id); err != nil {
			s.Log(fmt.Sprintf("closing: %v", err))
		}
	}
	h.docs[id] = hostedDoc{path: abs, options: o, server: s, handler: http.StripPrefix(s.Base, s.Handler())}
	return id, true, nil
}

// openIDLocked is the id for the file at abs, and whether it is open already:
// under that id, or under another name for the same file, such as a page's
// content.md, a page's .htm twin, or another case on a case-insensitive disk.
// h.mu is held.
func (h *Host) openIDLocked(abs string) (string, bool) {
	id := pageserve.Token(canonicalPath(abs))
	if _, open := h.docs[id]; open {
		return id, true
	}
	for other, d := range h.docs {
		if sameFile(abs, d.path) || sameFile(abs, d.server.MdPath) ||
			sameFile(AdvertisedPath(abs), d.path) || sameFile(AdvertisedPath(abs), d.server.MdPath) {
			return other, true
		}
	}
	return id, false
}

// sameFile says whether two paths are one file now. A path that isn't there is
// no file: a page's content.md before its first open.
func sameFile(a, b string) bool {
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	return err == nil && os.SameFile(ai, bi)
}

// refuseOlderEditor refuses a document an editor from before one server still
// holds: it runs on until its session ends and nothing migrates it, and two
// servers on one file erase each other with nothing logged. Read only. This goes
// once no such editors remain.
func refuseOlderEditor(abs string) error {
	for _, doc := range []string{abs, AdvertisedPath(abs)} {
		advert := strings.TrimSuffix(doc, filepath.Ext(doc)) + ".serve.json"
		raw, err := os.ReadFile(advert)
		if err != nil {
			continue
		}
		var held struct {
			URL string `json:"url"`
			PID int    `json:"pid"`
		}
		if json.Unmarshal(raw, &held) == nil && held.PID > 0 && tools.PIDAlive(held.PID) {
			return fmt.Errorf("%s is open in an editor from an older galley, at %s (pid %d); stop that editor first, or it and this one would erase each other",
				filepath.Base(abs), held.URL, held.PID)
		}
	}
	return nil
}

// newServerFor opens a page as a page and anything else as markdown.
func newServerFor(abs, root string) (*EditServer, error) {
	switch strings.ToLower(filepath.Ext(abs)) {
	case ".html", ".htm":
		if root != "" {
			return NewEditPageRoot(abs, root)
		}
		return NewEditPage(abs)
	default:
		if root != "" {
			return nil, fmt.Errorf("--root applies to an HTML page, not %s", filepath.Ext(abs))
		}
		return NewEdit(abs)
	}
}

// Close projects the document to disk and stops serving it, and it stays
// closed across a restart. Its peers' connections close with it; every other
// document is untouched.
func (h *Host) Close(id string) error {
	h.mu.Lock()
	d, open := h.docs[id]
	delete(h.docs, id)
	var saved error
	if open {
		saved = h.saveLocked()
	}
	h.mu.Unlock()
	if !open {
		return fmt.Errorf("document %s is not open", id)
	}
	// In this order: Close closes the peers, and what has not reached disk by
	// then never will.
	err := errors.Join(saved, d.server.Flush(), d.server.Close())
	h.tellClosed(id, d, noteStopped)
	return err
}

// closeAll is the server stopping: every document flushed and closed, and left
// in docs.json for the next one.
func (h *Host) closeAll() error {
	h.stopAgents()
	h.mu.Lock()
	docs := h.docs
	h.docs = map[string]hostedDoc{}
	h.mu.Unlock()
	var errs []error
	for _, d := range docs {
		errs = append(errs, d.server.Flush(), d.server.Close())
	}
	return errors.Join(errs...)
}

// List reports the open documents, by path.
func (h *Host) List() []DocView {
	h.mu.Lock()
	defer h.mu.Unlock()
	views := make([]DocView, 0, len(h.docs))
	for id, d := range h.docs {
		views = append(views, DocView{
			ID: id, Path: d.path, Page: d.server.MdPath, Room: d.server.Room,
			URL: h.baseLocked(id), Owner: d.options.Owner,
		})
	}
	slices.SortFunc(views, func(a, b DocView) int { return strings.Compare(a.Path, b.Path) })
	return views
}

// saveLocked writes the open documents to docs.json. h.mu is held.
func (h *Host) saveLocked() error {
	if h.savePath == "" {
		return nil
	}
	docs := make([]savedDoc, 0, len(h.docs))
	for _, d := range h.docs {
		docs = append(docs, savedDoc{Path: d.path, DocOptions: d.options})
	}
	slices.SortFunc(docs, func(a, b savedDoc) int { return strings.Compare(a.Path, b.Path) })
	return saveDocs(h.savePath, docs)
}

// reopenSaved opens each saved document that has no owner or whose owner is
// still live. One that fails says so and is dropped: it fails alone. A crash
// here leaves docs.json as it was, because it is written once, at the end.
func (h *Host) reopenSaved() {
	saved, err := loadDocs(h.savePath)
	if err != nil {
		_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not read: %v\n", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, d := range saved {
		if d.Owner != "" && !h.sessions.SessionLive(d.Owner) {
			if !d.Adopted {
				_, _ = fmt.Fprintf(h.log, "galley serve: not reopening %s: its session has gone\n", d.Path)
				continue
			}
			d.Owner, d.Adopted = "", false
		}
		if _, _, err := h.openLocked(d.Path, d.DocOptions); err != nil {
			_, _ = fmt.Fprintf(h.log, "galley serve: not reopening %s: %v\n", d.Path, err)
			h.tellNotReopened(d, err)
		}
	}
	if err := h.saveLocked(); err != nil {
		_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not saved: %v\n", err)
	}
}

// setAddress records the server's URL with its token, once it listens.
func (h *Host) setAddress(url string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.address = url
}

// docURL is the document's address with the token; just the path before the
// server has an address.
func (h *Host) docURL(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	path := docsPrefix + id + "/"
	u, err := url.Parse(h.address)
	if err != nil || h.address == "" {
		return path
	}
	u.Path = path
	return u.String()
}

// baseLocked is the document's base, without the token or a trailing slash: what
// a client adds a route to. h.mu is held.
func (h *Host) baseLocked(id string) string {
	path := docsPrefix + id
	u, err := url.Parse(h.address)
	if err != nil || h.address == "" {
		return path
	}
	return u.Scheme + "://" + u.Host + path
}

// watch checks the binary and the unload rules every tick until ctx ends, then
// lets every blocked `galley wait` go: one held open would hold shutdown for
// its whole grace period and have its connection torn.
func (h *Host) watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			h.stopAgents()
			h.mu.Lock()
			for _, d := range h.docs {
				d.server.ReleaseWaiters()
			}
			h.mu.Unlock()
			return
		case <-t.C:
			h.checkBinary()
			h.sweep()
			h.reconcile()
		}
	}
}

// sweep is one check of the unload rules: a document leaves when its owner's
// session is gone, or when it is approved and no page holds it, once that has
// held for unloadGrace checks in a row. A document with no owner that is not
// approved stays until closed, so one opened with none only goes back to none
// when the session that adopted it ends.
func (h *Host) sweep() {
	h.mu.Lock()
	docs := maps.Clone(h.docs)
	h.mu.Unlock()
	for id := range h.misses {
		if _, open := docs[id]; !open {
			delete(h.misses, id)
		}
	}
	for id, d := range docs {
		ownerGone := d.options.Owner != "" && !h.sessions.SessionLive(d.options.Owner)
		if !ownerGone && (!d.server.Sealed() || d.server.pages.Load() > 0) {
			delete(h.misses, id)
			continue
		}
		h.misses[id]++
		if h.misses[id] < unloadGrace {
			continue
		}
		delete(h.misses, id)
		if ownerGone && d.options.Adopted {
			h.disown(id, d.options.Owner)
			continue
		}
		if err := h.Close(id); err != nil {
			_, _ = fmt.Fprintf(h.log, "galley serve: unloading %s: %v\n", d.path, err)
		}
	}
}

// disown gives an adopted document back to no session, unless it has moved on.
func (h *Host) disown(id, owner string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	d, open := h.docs[id]
	if !open || d.options.Owner != owner {
		return
	}
	d.options.Owner, d.options.Adopted = "", false
	h.docs[id] = d
	if err := h.saveLocked(); err != nil {
		_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not saved: %v\n", err)
	}
}

// watchBinary records the binary serve runs, so checkBinary can tell when an
// install replaces it.
func (h *Host) watchBinary(exe string) error {
	st, err := os.Stat(exe)
	if err != nil {
		return err
	}
	h.exe, h.exeInfo = exe, st
	return nil
}

// checkBinary marks serve's entry stale once its binary is replaced (an install
// writes a new file, so the inode changes): the next channel call restarts it
// through Client.Fresh. A running serve keeps its old code, so without this it
// would stay on the old build.
func (h *Host) checkBinary() {
	if h.exe == "" || h.stale {
		return
	}
	now, err := os.Stat(h.exe)
	if err != nil {
		return // mid-install the file may briefly be missing
	}
	// Linux can hand a replaced file its old inode number, so the same inode
	// alone isn't the same build: its size or time changes too.
	if os.SameFile(h.exeInfo, now) && now.Size() == h.exeInfo.Size() && now.ModTime().Equal(h.exeInfo.ModTime()) {
		return
	}
	// Only this serve's own entry is marked, and not before it is written: a
	// check that finds none looks again on the next tick.
	e, err := Running()
	if err != nil || e.PID != os.Getpid() {
		return
	}
	e.Stale = true
	if err := Live().Advertise(e); err == nil {
		h.stale = true
	}
}

// parseMarkdown and extractPage are the parsers a file from outside goes
// through; tests make them panic.
var (
	parseMarkdown = markdown.Parse
	extractPage   = htmlpage.Extract
)

// parseOutside parses a file galley did not write. A panic in the parser is an
// error like any other unreadable file: the document says so and every other
// document in the process carries on.
func parseOutside(raw []byte) (doc docmodel.Doc, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("the parser panicked: %v", r)
		}
	}()
	// Inline notes the parse lifts are not imported, by design: see NewEdit.
	doc, _, err = parseMarkdown(raw)
	return doc, err
}

// extractOutside is parseOutside for a page.
func extractOutside(raw []byte) (ex *htmlpage.Extraction, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("the page parser panicked: %v", r)
		}
	}()
	return extractPage(raw)
}

// handleOpen is POST /api/docs.
func (h *Host) handleOpen(w http.ResponseWriter, r *http.Request) {
	var in OpenRequest
	if !decode(w, r, &in) {
		return
	}
	if !filepath.IsAbs(in.Path) {
		http.Error(w, "path must be absolute: the server does not run in your directory", http.StatusBadRequest)
		return
	}
	id, err := h.openFor(in)
	switch {
	case errors.Is(err, errOwned):
		http.Error(w, strings.TrimSuffix(err.Error(), ": "+errOwned.Error()), http.StatusConflict)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	d, open := h.doc(id)
	if !open {
		http.NotFound(w, r)
		return
	}
	h.reconcile()
	writeJSON(w, OpenAnswer{ID: id, URL: h.docURL(id), Page: d.server.MdPath, Room: d.server.Room, Pages: int(d.server.pages.Load())})
}

// openFor opens the document for whoever asks, or decides between them when it
// is open already. A document keeps its first options (see Open), except its
// owner: one no session owns goes to the session asking, one whose session has
// gone is taken up by the session asking, without what that session configured,
// and one a live session owns is that session's and is refused, as is any owned
// document to an asker with no session.
func (h *Host) openFor(in OpenRequest) (string, error) {
	h.mu.Lock()
	id, open := h.openIDLocked(in.Path)
	d := h.docs[id]
	if open && d.options.Owner != in.Owner {
		owner := d.options.Owner
		switch {
		case owner != "" && h.sessions.SessionLive(owner):
			h.mu.Unlock()
			return "", fmt.Errorf("open in session %s; its wakes go there: %w", owner, errOwned)
		case in.Owner == "":
			h.mu.Unlock()
			return "", fmt.Errorf("opened by session %s, which has stopped; it is closing, retry in a few seconds: %w", owner, errOwned)
		}
		switch {
		case owner == "":
			d.options.Adopted = true
		case !d.options.Adopted:
			// The gone session's commands: an adopted document's are the
			// terminal's that opened it.
			d.options.OnRevise, d.options.OnSettle, d.options.Dir = "", "", ""
			d.server.clearHooks()
		}
		d.options.Owner = in.Owner
		h.docs[id] = d
		if err := h.saveLocked(); err != nil {
			_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not saved: %v\n", err)
		}
	}
	h.mu.Unlock()
	// By the name it was opened by: a page named by its content.md stays a page.
	path := in.Path
	if open {
		path = d.path
	}
	// Closed and opened again rather than in one step under the lock: Close
	// flushes to disk, and the reopen must read what it wrote.
	if open && in.Fresh && d.server.Sealed() {
		if err := h.Close(id); err != nil {
			return "", err
		}
	}
	return h.Open(path, in.DocOptions)
}

// handleClose is DELETE /api/docs/{id}.
func (h *Host) handleClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, open := h.doc(id); !open {
		http.NotFound(w, r)
		return
	}
	if err := h.Close(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// control is a route that runs what it's given or reaches beyond one document:
// it takes the token's header and never the cookie. A page under review holds
// the cookie and can't read the token, so it can't name a command or a file, or
// take a session's wakes. localweb has already checked one or the other.
func (h *Host) control(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get(localweb.TokenHeader)), []byte(h.token)) != 1 {
			http.Error(w, "this route needs the "+localweb.TokenHeader+" header; a page's cookie is not enough", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// Handler routes /api/docs/{id}/... to that document with the prefix stripped.
func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/agent/wait", h.control(h.handleAgentWait))
	mux.HandleFunc("POST /api/agent/report", h.control(h.handleAgentReport))
	mux.HandleFunc("GET /api/agent/status", h.control(h.handleAgentStatus))
	mux.HandleFunc("POST /api/docs", h.control(h.handleOpen))
	mux.HandleFunc("GET /api/docs", h.control(func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, h.List()) }))
	mux.HandleFunc("DELETE /api/docs/{id}", h.control(h.handleClose))
	mux.HandleFunc(docsPrefix+"{id}/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		d, open := h.doc(r.PathValue("id"))
		if !open {
			http.NotFound(w, r)
			return
		}
		d.handler.ServeHTTP(w, r)
	})
	return mux
}

// doc returns the open document.
func (h *Host) doc(id string) (hostedDoc, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	d, open := h.docs[id]
	return d, open
}
