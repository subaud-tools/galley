package serve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

// pagesNow reads GET /_galley/pages: how many pages hold the editor's room.
func pagesNow(t *testing.T, ts *httptest.Server) int {
	t.Helper()
	resp, err := http.Get(ts.URL + "/_galley/pages")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /_galley/pages: %s", resp.Status)
	}
	var v PagesView
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v.Pages
}

// A page counts while its websocket holds the room, and stops counting once
// it closes: galley_open asks this before opening a second tab.
func TestPagesCountsConnectedPages(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# T\n")
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	if n := pagesNow(t, ts); n != 0 {
		t.Fatalf("pages before any connected: %d, want 0", n)
	}
	conn := dialRoom(t, ts, s.Room)
	drainHandshake(t, conn, crdt.New())
	if n := pagesNow(t, ts); n != 1 {
		t.Fatalf("pages with one connected: %d, want 1", n)
	}
	_ = conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for pagesNow(t, ts) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the closed page still counts after 2s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
