package serve

import (
	"net/http"

	gws "github.com/gorilla/websocket"
)

// PagesView is GET /_galley/pages: how many pages hold this editor's room
// over its websocket right now.
type PagesView struct {
	Pages int `json:"pages"`
}

// countPages counts each websocket upgrade to the room for as long as the
// connection lasts: ygo's ServeHTTP returns only when the peer is gone. Besides
// localweb.Tabs, whose list holds only pages that check in with a tab id: this
// sees every page on the document, and the unload rule and Host.showIn ask it.
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
