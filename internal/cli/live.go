package cli

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

// live is where running editors advertise themselves to a channel that starts
// before any document is open: one <room>.json per live editor, its claim
// lock beside it, session presence under sessions/, editor logs under logs/,
// port hints under ports/. pageserve does the reading and writing; the place
// is galley's.
//
// serve.FindRuntime answers "where is THIS path" for a caller that already
// knows the path. A channel knows no paths; it needs "what is being edited right
// now, anywhere", and that is this directory.
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

// tokenTransport sends the server's token on every request to the server, and
// to nothing else. A document's routes are the verbs' and the channel's to call
// by its base address, as they called an editor's; only the token is new.
//
// On http.DefaultTransport so http.Get, http.Post and each bare http.Client in
// this package carry it. The channel's calls go when it moves onto pageserve's
// client.
type tokenTransport struct{ next http.RoundTripper }

func (t tokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	e, err := serve.Running()
	if err != nil || e.Base != r.URL.Scheme+"://"+r.URL.Host {
		return t.next.RoundTrip(r)
	}
	r = r.Clone(r.Context())
	r.Header.Set(localweb.TokenHeader, e.Token)
	return t.next.RoundTrip(r)
}

func init() { http.DefaultTransport = tokenTransport{next: http.DefaultTransport} }
