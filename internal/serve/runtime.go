package serve

import (
	"path/filepath"
	"strings"
	"time"
)

// roomIdleTimeout is applied to every ws.Server this package constructs
// (EditServer.NewEdit). An EditServer serves exactly one
// room for its whole lifetime, and pins doc = yjs.GetDoc(room) once, in the
// constructor, before any peer can ever reconnect. ws.NewServer's default
// RoomIdleTimeout is 0 — eager-evict: the room is destroyed the instant its
// last websocket peer disconnects (a page reload, a tab close, a transient
// network drop). The NEXT connection then creates a brand-new room with a
// brand-new *crdt.Doc, and every later browser edit lands there — invisible
// to the doc this process pinned, and so invisible to Project, /_galley/pending,
// and pending.json, which all read the pinned doc. Silent data loss.
//
// ws.Server's config surface has no "never evict" sentinel (RoomIdleTimeout
// must be > 0 to switch out of eager-evict at all — see ygo's idle_sweep.go),
// so this is set to a duration long enough that it cannot fire within the
// life of any real server: the server itself is
// the room's only owner, and there is nothing else to reclaim the room from.
const roomIdleTimeout = 100 * 365 * 24 * time.Hour

// roomFor names the y-websocket room for a page. The basename is enough — one
// server serves one page — and it keeps the websocket URL legible.
func roomFor(pagePath string) string {
	base := filepath.Base(pagePath)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// closeTimeout is how long Close waits for peer goroutines to exit. Short: by
// the time it is called the document is already on disk, so nothing is lost by
// giving up on a stuck connection.
const closeTimeout = 3 * time.Second
