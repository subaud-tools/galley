// server.go is `galley serve`: every open document behind pageserve's one
// local server per machine, which writes the entry other processes find (and
// stop) it by.
package serve

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/pageserve"
)

// StateDir is galley serve's state directory.
func StateDir() string { return tools.StateDir("galley") }

// Live is where galley serve's entry is: StateDir/live/serve.json.
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
	h.sessions, h.log, h.savePath = o.Sessions, o.Log, DocsPath()
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
