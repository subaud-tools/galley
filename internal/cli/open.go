// open.go is galley_open: the channel adding a document to the server for its
// own session.
//
// THE CHANNEL IS THE SESSION'S PRESENCE INSIDE GALLEY, so it is the one
// process that knows, with certainty and without reading an environment
// variable, which session a document belongs to. Before this tool the agent
// ran `galley edit` from its shell and the editor stamped whatever session id
// that shell carried — which under pi, after an in-process subagent had run,
// was the subagent's (measured 2026-09-08). The channel then refused the
// editor as another session's, correctly, and the reviewer typed into a
// document nobody was attached to. Spec: session identity at spawn.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/pageserve"
)

// openResult is what galley_open returns, as JSON text: enough for the agent
// to hand the reviewer a URL and to recognise the document in later wakes.
// URL signs a browser in. Preview is the branded page's address, for a markdown
// review only — a page under review is already its own HTML and has no preview
// route.
type openResult struct {
	URL     string `json:"url"`
	Room    string `json:"room"`
	Page    string `json:"page"`
	Preview string `json:"preview,omitempty"`
}

// previewOf is the preview address beside a signed-in document address: the same
// query, one route further on.
func previewOf(docURL string) (string, error) {
	u, err := url.Parse(docURL)
	if err != nil {
		return "", err
	}
	u.Path += "_galley/render"
	return u.String(), nil
}

// open is the tool body. The session's folder does not apply: the path is this
// session's explicit ask. The server decides between sessions (see
// serve.Host.openFor): this session's own is handed back, an unowned one or one
// whose session has gone becomes this session's, and another live session's is
// refused as theirs. One whose review has ended is replaced with a fresh review.
func open(ctx context.Context, ch *pageserve.Channel, doc string) (string, error) {
	if doc == "" {
		return "", fmt.Errorf("galley_open needs a document path")
	}
	abs, err := filepath.Abs(doc)
	if err != nil {
		return "", err
	}
	var a serve.OpenAnswer
	if _, err := ch.Client.Do(ctx, http.MethodPost, "/api/docs", serve.OpenRequest{
		Path: abs, Fresh: true, DocOptions: serve.DocOptions{Owner: ch.ID.Session, Dir: ch.ID.CWD},
	}, &a); err != nil {
		// The server's own sentence, without its status.
		var refused *pageserve.StatusError
		if errors.As(err, &refused) {
			return "", errors.New(refused.Msg)
		}
		return "", err
	}
	// THE PAGE IS OPENED ONLY WHEN NO TAB IS THERE TO SHOW THE REVIEW, so a
	// galley_open after the reviewer closed the tab brings it back, and one on a
	// document already in front of them opens no second tab.
	if a.Tab == serve.TabOpened {
		if err := ch.Open(a.URL); err != nil {
			_, _ = fmt.Fprintf(ch.Log, "galley channel: opening the browser: %v\n", err)
		}
	}
	r := openResult{URL: a.URL, Room: a.Room, Page: a.Page}
	if abs == serve.AdvertisedPath(abs) {
		if r.Preview, err = previewOf(a.URL); err != nil {
			return "", err
		}
	}
	b, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
