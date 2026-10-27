package serve

import (
	"net/http"

	gws "github.com/gorilla/websocket"
)

// PagesView is GET /_galley/pages: how many pages hold this editor's room
// over its websocket right now. galley_open reads it on its reuse path and
// opens the browser only when it is 0, so a second galley_open on a
// document already in front of the reviewer opens no second tab.
type PagesView struct {
	Pages int `json:"pages"`
}

// countPages counts each websocket upgrade to the room for as long as the
// connection lasts: ygo's ServeHTTP returns only when the peer is gone.
// Counted directly rather than through tools-common localweb.Tabs, which
// needs the page to send a tab id and page name on its streams, and whose
// front-page and move rules an editor serving one document has no use for.
func (s *EditServer) countPages(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !gws.IsWebSocketUpgrade(r) {
			next.ServeHTTP(w, r)
			return
		}
		s.pages.Add(1)
		defer s.pages.Add(-1)
		next.ServeHTTP(w, r)
	})
}

func (s *EditServer) handlePages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, PagesView{Pages: int(s.pages.Load())})
}
