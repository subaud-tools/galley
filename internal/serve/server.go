// server.go is `galley serve`: every open document behind pageserve's one
// local server per machine, which writes the entry other processes find (and
// stop) it by.
package serve

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/pageserve"
)

// StateDir is galley serve's state directory.
func StateDir() string { return tools.StateDir("galley") }

// Live is where galley serve's entry is, under StateDir/live.
func Live() pageserve.Live { return pageserve.LiveFor("galley") }

// Running returns the live serve's entry, or pageserve.ErrNotRunning.
func Running() (pageserve.Entry, error) { return Live().Running() }

// Process is how serve starts in the background: `galley serve`, which runs in
// the foreground and opens no browser, in StateDir, not the starter's folder,
// which may be a temp dir deleted later.
func Process() pageserve.Process {
	return pageserve.Process{Live: Live(), Args: []string{"serve"}, Dir: StateDir()}
}

// Options configures Run.
type Options struct {
	Port    int // 0: remembered, else free
	Version string
	Exe     string // the binary, watched for a newer install; "": not watched
	// Sessions is where session presence is read: a document leaves with its
	// owner, and an owner's channel announces itself here.
	Sessions pageserve.Live
	Log      io.Writer // one line per start, stop and document that fails
	Ready    func(url string)
	Every    time.Duration // the unload and binary check; default 1s
}

// Run serves until ctx ends or /api/stop. pageserve holds serve.lock from
// finding no live entry to writing its own, so the saved documents are opened
// by the one serve that won, before its entry can be found. There is no idle
// exit. On the way out every document is flushed and closed and stays in
// docs.json: a stop is not a close.
func Run(ctx context.Context, o Options) error {
	if o.Log == nil {
		o.Log = io.Discard
	}
	if o.Every <= 0 {
		o.Every = time.Second
	}
	if err := os.MkdirAll(StateDir(), 0o700); err != nil {
		return err
	}
	token, err := keptToken()
	if err != nil {
		return err
	}
	h := NewHost()
	h.sessions, h.log, h.savePath, h.token = o.Sessions, o.Log, DocsPath(), token
	var watching sync.WaitGroup
	err = pageserve.Run(ctx, pageserve.Options{
		Live: Live(), API: h.Handler(),
		Port: o.Port, Token: token, Version: o.Version, Log: o.Log, Ready: o.Ready,
		OnStart: func(ctx context.Context, url string) {
			h.setAddress(url)
			if o.Exe != "" {
				if err := h.watchBinary(o.Exe); err != nil {
					_, _ = fmt.Fprintf(o.Log, "galley serve: not watching %s for updates: %v\n", o.Exe, err)
				}
			}
			h.reopenSaved()
			watching.Add(1)
			go func() {
				defer watching.Done()
				h.watch(ctx, o.Every)
			}()
		},
	})
	watching.Wait()
	return errors.Join(err, h.closeAll())
}

// Runtime is what the server says about one open document. URL is its base,
// without the token: a caller sends the token in the header.
type Runtime struct {
	URL   string
	Room  string
	Page  string // the file under review
	Owner string
}

// FindRuntime asks the running server whether it holds this document, by any
// path that names it: a page's .html or its content.md, in either spelling of
// a symlinked directory. No server, or one that does not answer, holds nothing.
func FindRuntime(path string) (Runtime, bool) {
	return FindOn(context.Background(), pageserve.NewClient(Live(), nil), path)
}

// FindOn is FindRuntime through client: a channel's, which starts a server that
// has crashed.
func FindOn(ctx context.Context, client *pageserve.Client, path string) (Runtime, bool) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Runtime{}, false
	}
	var docs []DocView
	if _, err := client.Do(ctx, http.MethodGet, "/api/docs", nil, &docs); err != nil {
		return Runtime{}, false
	}
	want := canonicalPath(abs)
	for _, d := range docs {
		if canonicalPath(d.Path) == want || canonicalPath(d.Page) == want {
			return Runtime{URL: d.URL, Room: d.Room, Page: d.Page, Owner: d.Owner}, true
		}
	}
	return Runtime{}, false
}

// canonicalPath is what a path really is, so one file has one answer however
// it was spelled: /tmp is /private/tmp on macOS. A path that does not resolve
// (the file was deleted while under review) stands for itself, with its
// directory resolved when that exists.
func canonicalPath(abs string) string {
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	if dir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		return filepath.Join(dir, filepath.Base(abs))
	}
	return abs
}
