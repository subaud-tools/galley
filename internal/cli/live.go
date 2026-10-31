package cli

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

// live is where session presence is kept: a channel announces its session here
// for as long as it runs, and the server reads it (serve.Options.Sessions) to
// know whose documents stay. The server's own entry is in serve.Live.
//
// The directory is $GALLEY_LIVE_DIR when set — tests, and anyone isolating
// registries — else ~/.galley/live, read on every call so a test's Setenv
// takes. It stays out of tools-common's state dir on purpose: every galley
// build on the machine meets here, and editors from before one server still
// advertise here until their sessions end.
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
// to nothing else. A document's routes are the verbs' to call by its base
// address, as they called an editor's; only the token is new.
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

// serverClient is what the verbs call a document's routes with. No timeout: the
// server bounds every poll.
var serverClient = &http.Client{Transport: tokenTransport{next: http.DefaultTransport}}
