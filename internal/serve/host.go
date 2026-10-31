// host.go is one process holding many documents: a Host keeps one EditServer
// per open document, each with its own ygo room and websocket server, behind
// /api/docs/<id>/ on pageserve's one port and token.
package serve

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/subaud-tools/tools-common/pageserve"
)

// docsPrefix is where every open document's routes live.
const docsPrefix = "/api/docs/"

// DocOptions is how a document is opened. It holds nothing yet: the flags
// `galley edit` passes arrive with `galley serve`.
type DocOptions struct{}

// DocView is one open document as List reports it.
type DocView struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// hostedDoc is one open document and its routes, built once.
type hostedDoc struct {
	server  *EditServer
	handler http.Handler
}

// Host holds the open documents.
type Host struct {
	mu   sync.Mutex
	docs map[string]hostedDoc // by id
}

// NewHost returns a Host with nothing open.
func NewHost() *Host { return &Host{docs: map[string]hostedDoc{}} }

// Open serves the document at path and returns its id, the same for the same
// path always. A document already open keeps its server: a second one would be
// a second live document erasing the first (see claimDocument).
func (h *Host) Open(path string, _ DocOptions) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	id := pageserve.Token(abs)
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, open := h.docs[id]; open {
		return id, nil
	}
	s, err := NewEdit(abs)
	if err != nil {
		return "", err
	}
	s.Base = strings.TrimSuffix(docsPrefix, "/") + "/" + id
	h.docs[id] = hostedDoc{server: s, handler: http.StripPrefix(s.Base, s.Handler())}
	return id, nil
}

// Close projects the document to disk and stops serving it. Its peers'
// connections close with it; every other document is untouched.
func (h *Host) Close(id string) error {
	h.mu.Lock()
	d, open := h.docs[id]
	delete(h.docs, id)
	h.mu.Unlock()
	if !open {
		return fmt.Errorf("document %s is not open", id)
	}
	// In this order: Close closes the peers, and what has not reached disk by
	// then never will.
	return errors.Join(d.server.Flush(), d.server.Close())
}

// List reports the open documents, by path.
func (h *Host) List() []DocView {
	h.mu.Lock()
	defer h.mu.Unlock()
	views := make([]DocView, 0, len(h.docs))
	for id, d := range h.docs {
		views = append(views, DocView{ID: id, Path: d.server.MdPath})
	}
	slices.SortFunc(views, func(a, b DocView) int { return strings.Compare(a.Path, b.Path) })
	return views
}

// Handler routes /api/docs/{id}/... to that document with the prefix stripped.
func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
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
