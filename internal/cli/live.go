package cli

import (
	"os"
	"path/filepath"

	"github.com/subaud-tools/tools-common/pageserve"
)

// live is where running editors advertise themselves to a channel that starts
// before any document is open: one <room>.json per live editor, its claim
// lock beside it, session presence under sessions/, editor logs under logs/,
// port hints under ports/. pageserve does the reading and writing; the place
// is galley's.
//
// The per-document <doc>.serve.json sibling answers "where is the server for
// THIS path" — discovery for a caller that already knows the path. A channel
// knows no paths; it needs "what is being edited right now, anywhere", and
// that is this directory.
//
// OWNERSHIP is the session id of whoever ran `galley edit`, set from the
// caller's harness session id. Empty means UNOWNED — opened by a human in a
// plain terminal — and unowned entries are claimable by any channel under
// whose root they fall.
//
// The directory is $GALLEY_LIVE_DIR when set — tests, and anyone isolating
// registries — else ~/.galley/live, read on every call so a test's Setenv
// takes. It stays out of tools-common's state dir on purpose: every galley
// build on the machine meets here, so an editor started by an older galley
// is still found by a newer channel, and the other way round.
func live() pageserve.Live {
	d := os.Getenv("GALLEY_LIVE_DIR")
	if d == "" {
		// No home: an empty Dir, which every pageserve call refuses as it
		// creates the directory — the error registry.Dir used to return.
		if home, err := os.UserHomeDir(); err == nil {
			d = filepath.Join(home, ".galley", "live")
		}
	}
	return pageserve.Live{Tool: "galley", Dir: d}
}
