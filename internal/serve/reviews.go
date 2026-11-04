// reviews.go is the list of reviews galley keeps in reviews.json, beside
// docs.json: one entry per document, so an approved review stays listed after
// its document closes and across a restart, and opens again sealed.
package serve

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/pageserve"
)

// ReviewsPath keeps the reviews across restarts (0600, as docs.json).
func ReviewsPath() string { return filepath.Join(StateDir(), "reviews.json") }

// keptReview is one review in reviews.json, by the document's absolute path.
type keptReview struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Folder string `json:"folder"`
	// State is PageWithYou, PageWithAgent or PageApproved, as last recorded.
	State      string    `json:"state"`
	ApprovedAt time.Time `json:"approvedAt,omitzero"`
	// VerdictN and Digest are the verdict round's number and the sha256 of its
	// bytes: the text as approved, and how a file that moved on since is told.
	VerdictN int    `json:"verdictN,omitempty"`
	Digest   string `json:"digest,omitempty"`
	Rounds   int    `json:"rounds"`
}

// reviews is the kept list. Its own lock, never held with the Host's or a
// server's: a server's hooks reach it with that server's lock held.
type reviews struct {
	path string // reviews.json; "": kept in memory only
	log  io.Writer

	mu     sync.Mutex
	byPath map[string]keptReview
}

// loadReviews reads reviews.json; no file is no reviews, and one that can't be
// read says so and starts empty.
func loadReviews(path string, log io.Writer) *reviews {
	r := &reviews{path: path, log: log, byPath: map[string]keptReview{}}
	if path == "" {
		return r
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return r
	}
	var list []keptReview
	if err == nil {
		err = json.Unmarshal(b, &list)
	}
	if err != nil {
		_, _ = fmt.Fprintf(log, "galley serve: the kept reviews were not read: %v\n", err)
		return r
	}
	for _, k := range list {
		r.byPath[k.Path] = k
	}
	return r
}

// saveLocked writes reviews.json whole. r.mu is held.
func (r *reviews) saveLocked() {
	if r.path == "" {
		return
	}
	list := slices.Collect(maps.Values(r.byPath))
	slices.SortFunc(list, func(a, b keptReview) int { return strings.Compare(a.Path, b.Path) })
	b, err := json.MarshalIndent(list, "", "  ")
	if err == nil {
		err = tools.WriteFileAtomic(r.path, append(b, '\n'), 0o600)
	}
	if err != nil {
		_, _ = fmt.Fprintf(r.log, "galley serve: the kept reviews were not saved: %v\n", err)
	}
}

// update changes the entry for path, made if missing, and saves.
func (r *reviews) update(path string, fn func(*keptReview)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	k, ok := r.byPath[path]
	if !ok {
		k = keptReview{Path: path, Name: filepath.Base(path), Folder: filepath.Base(filepath.Dir(path)), State: PageWithYou}
	}
	fn(&k)
	r.byPath[path] = k
	r.saveLocked()
}

// begin records a new review of path: waiting on the reader, no rounds yet.
func (r *reviews) begin(path string) {
	r.update(path, func(k *keptReview) {
		*k = keptReview{Path: k.Path, Name: k.Name, Folder: k.Folder, State: PageWithYou}
	})
}

// get is the entry for path.
func (r *reviews) get(path string) (keptReview, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	k, ok := r.byPath[path]
	return k, ok
}

// forget drops the entry for path.
func (r *reviews) forget(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byPath[path]; !ok {
		return
	}
	delete(r.byPath, path)
	r.saveLocked()
}

// list is every entry.
func (r *reviews) list() []keptReview {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Collect(maps.Values(r.byPath))
}

// reviewKey is the key a review is named by in the page's routes: the id its
// document has when open.
func reviewKey(path string) string { return pageserve.Token(canonicalPath(path)) }

// ReviewKeyRequest is the body of POST /api/reviews/open and /remove.
type ReviewKeyRequest struct {
	Key string `json:"key"`
}

// ReviewOpenView is what POST /api/reviews/open answers: the open document's
// id, the page to go to.
type ReviewOpenView struct {
	ID string `json:"id"`
}

// keptByKey is the kept review named by key.
func (r *reviews) keptByKey(key string) (keptReview, bool) {
	for _, k := range r.list() {
		if reviewKey(k.Path) == key {
			return k, true
		}
	}
	return keptReview{}, false
}

// handleReviewOpen is POST /api/reviews/open: a kept approved review opened
// again, sealed, owned by no session. One open already answers as it is.
func (h *Host) handleReviewOpen(w http.ResponseWriter, r *http.Request) {
	var in ReviewKeyRequest
	if !decode(w, r, &in) {
		return
	}
	if _, open := h.doc(in.Key); open {
		writeJSON(w, ReviewOpenView{ID: in.Key})
		return
	}
	k, ok := h.reviews.keptByKey(in.Key)
	if !ok || k.State != PageApproved {
		http.NotFound(w, r)
		return
	}
	h.mu.Lock()
	id, added, err := h.openLocked(k.Path, DocOptions{}, true)
	if err == nil && added {
		if serr := h.saveLocked(); serr != nil {
			_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not saved: %v\n", serr)
		}
	}
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, ReviewOpenView{ID: id})
}

// handleReviewRemove is POST /api/reviews/remove: Remove from list. An open
// review is closed first, which tells its session; the file and its versions
// stay on disk.
func (h *Host) handleReviewRemove(w http.ResponseWriter, r *http.Request) {
	var in ReviewKeyRequest
	if !decode(w, r, &in) {
		return
	}
	if d, open := h.doc(in.Key); open {
		if err := h.Close(in.Key); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		h.reviews.forget(d.path)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	k, ok := h.reviews.keptByKey(in.Key)
	if !ok {
		http.NotFound(w, r)
		return
	}
	h.reviews.forget(k.Path)
	w.WriteHeader(http.StatusNoContent)
}
