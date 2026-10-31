// agent.go is the server's side of pageserve's channel: one long poll per
// session, GET /api/agent/wait, in place of a channel attaching to each editor.
// The server decides which session a document's wakes go to, from its owner.
//
// A POLL CANNOT HOLD A WAITER ON EACH DOCUMENT. An event goes to the readers
// registered at that moment (wakeRound), so two presses on two documents during
// one answer would lose the second with the poll that went back. Each owned
// document therefore has one attachment here, a goroutine that stays registered
// and re-arms at once, and puts each wake on its session's queue; the poll only
// takes from the queue. An attachment lives while its session is waiting: one
// that stopped has nobody reading, and a press must be refused as unheard.
package serve

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subaud-tools/tools-common/channelmcp"
)

const (
	// agentWaitDefault and agentWaitMax bound one poll, in seconds.
	agentWaitDefault = 30
	agentWaitMax     = 60
	// agentPoll is how long an attachment holds one poll on its document. Its
	// expiry only renews the cursor.
	agentPoll = 5 * time.Minute
	// agentBusyBackoff is how long an attachment pauses on a busy document.
	agentBusyBackoff = 250 * time.Millisecond
	// agentGoneKept is how many documents a session's status recalls leaving.
	agentGoneKept = 8
	// noteStopped is why a closed wake was sent, as the agent reads it.
	noteStopped = "the editor stopped"
)

// agentGrace is how long a session counts as waiting after its last poll ended:
// pageserve's loop comes back at once after an answer, 5 seconds after an error,
// and a Claude Code mod restarts `galley watch` within about as long.
var agentGrace = 15 * time.Second

// AgentWake is GET /api/agent/wait's answer, one document's wake. Pending is the
// captured round, nil when there is nothing left to read it from (a closed
// document). Report is the token the harness names in POST /api/agent/report.
type AgentWake struct {
	Page        string       `json:"page"`
	Room        string       `json:"room"`
	Reason      string       `json:"reason"`
	Fingerprint string       `json:"fingerprint,omitempty"`
	Note        string       `json:"note,omitempty"`
	Pending     *PendingView `json:"pending,omitempty"`
	Report      string       `json:"report,omitempty"`
}

// AgentStatus is GET /api/agent/status's answer: what galley_channel_status
// reads. Waiting is whether the session is attached to its documents right now,
// Gone what recently left it, in a line each.
type AgentStatus struct {
	Docs    []DocView `json:"docs"`
	Waiting bool      `json:"waiting"`
	Gone    []string  `json:"gone,omitempty"`
}

// agentAttachment is one document's goroutine for one session.
type agentAttachment struct{ cancel context.CancelFunc }

// agentSession is what the server knows of one session's waits.
type agentSession struct {
	root     string // the folder its unowned documents come from; "": none
	waits    int    // polls open now
	last     time.Time
	queue    []AgentWake
	notify   chan struct{} // closed and replaced when the queue grows
	attached map[string]*agentAttachment
	cursors  map[string]string // doc id -> the fingerprint it last heard
	told     map[string]bool   // doc id -> its verdict was delivered
	gone     []string
}

func (a *agentSession) active(now time.Time) bool {
	return a.waits > 0 || now.Sub(a.last) < agentGrace
}

func (a *agentSession) push(w AgentWake) {
	a.queue = append(a.queue, w)
	close(a.notify)
	a.notify = make(chan struct{})
}

// agents is the sessions the server has heard from. Taken alone or under h.mu,
// never the other way round.
type agents struct {
	mu       sync.Mutex
	sessions map[string]*agentSession
	ctx      context.Context // ends when the server stops
	stop     context.CancelFunc
	running  sync.WaitGroup
}

func newAgents() *agents {
	ctx, stop := context.WithCancel(context.Background())
	return &agents{sessions: map[string]*agentSession{}, ctx: ctx, stop: stop}
}

// session returns the session's state. a.mu is held.
func (g *agents) session(id string) *agentSession {
	a, ok := g.sessions[id]
	if !ok {
		a = &agentSession{
			notify: make(chan struct{}), attached: map[string]*agentAttachment{},
			cursors: map[string]string{}, told: map[string]bool{},
		}
		g.sessions[id] = a
	}
	return a
}

// stopAgents ends every attachment and answers every poll: a stop is not a
// close, so nothing is told, and an attachment left holding a poll would be told
// "closed" by the document it is on.
func (h *Host) stopAgents() {
	g := h.agents
	g.mu.Lock()
	g.stop() // under the lock, so no reconcile starts one after this
	g.mu.Unlock()
	g.running.Wait()
}

// reconcile matches the attachments to the documents: for each session waiting,
// it claims the unowned documents under its folder and attaches to what it owns;
// for the rest it attaches to nothing, and forgets a session with nothing left
// to tell. It runs on each poll, each open and each tick of the watch.
func (h *Host) reconcile() {
	g := h.agents
	h.claimUnowned()
	h.mu.Lock()
	docs := maps.Clone(h.docs)
	h.mu.Unlock()
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ctx.Err() != nil {
		return
	}
	for session, a := range g.sessions {
		if !a.active(now) {
			for id, at := range a.attached {
				at.cancel()
				delete(a.attached, id)
			}
			if len(a.queue) == 0 && !h.sessions.SessionLive(session) {
				delete(g.sessions, session)
			}
			continue
		}
		for id, at := range a.attached {
			if d, open := docs[id]; !open || d.options.Owner != session {
				at.cancel()
				delete(a.attached, id)
			}
		}
		for id, d := range docs {
			if d.options.Owner != session || a.attached[id] != nil || a.told[id] {
				continue
			}
			ctx, cancel := context.WithCancel(g.ctx)
			at := &agentAttachment{cancel: cancel}
			a.attached[id] = at
			g.running.Add(1)
			go func() {
				defer g.running.Done()
				defer cancel()
				h.attach(ctx, session, id, d, at)
			}()
		}
	}
}

// claimUnowned gives each unowned document under a waiting session's folder to
// one such session, which is what a plain-terminal `galley edit` has always
// meant: it belongs to no session, and exactly one channel takes it. A session
// never takes an ended review: there is nothing in it to hear.
func (h *Host) claimUnowned() {
	now := time.Now()
	g := h.agents
	g.mu.Lock()
	roots := map[string]string{}
	for session, a := range g.sessions {
		if a.root != "" && a.active(now) {
			roots[session] = canonicalPath(a.root)
		}
	}
	g.mu.Unlock()
	if len(roots) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	changed := false
	for id, d := range h.docs {
		if d.options.Owner != "" || d.server.Sealed() {
			continue
		}
		for session, root := range roots {
			if underRoot(canonicalPath(d.server.MdPath), root) {
				d.options.Owner = session
				h.docs[id] = d
				changed = true
				break
			}
		}
	}
	if changed {
		if err := h.saveLocked(); err != nil {
			_, _ = fmt.Fprintf(h.log, "galley serve: the open documents were not saved: %v\n", err)
		}
	}
}

func underRoot(path, root string) bool {
	return path == root || strings.HasPrefix(path, strings.TrimSuffix(root, string(filepath.Separator))+string(filepath.Separator))
}

// attach holds one document's poll for one session until ctx ends or the review
// has nothing more to say, re-arming at once and putting each wake on the queue.
// A document closing says nothing here: Close tells the session, whether or not
// an attachment was there to see it.
func (h *Host) attach(ctx context.Context, session, id string, d hostedDoc, at *agentAttachment) {
	g := h.agents
	g.mu.Lock()
	since := g.session(session).cursors[id]
	g.mu.Unlock()
	defer func() {
		// The cursor outlives the attachment, for a session that stops waiting
		// and comes back, but not the document: a new review starts with none.
		cur, open := h.doc(id)
		g.mu.Lock()
		defer g.mu.Unlock()
		a := g.session(session)
		if a.attached[id] == at {
			delete(a.attached, id)
		}
		if open && cur.server == d.server {
			a.cursors[id] = since
		}
	}()
	for {
		reply, err := d.server.waitOnce(ctx, since, agentPoll)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			// The document was being written to throughout: come back in a moment.
			select {
			case <-ctx.Done():
				return
			case <-time.After(agentBusyBackoff):
			}
			continue
		}
		switch reply.Reason {
		case waitClosedR:
			return
		case waitTimeout:
			since = reply.Fingerprint
			continue
		}
		since = reply.Fingerprint
		wake := AgentWake{
			Page: d.server.MdPath, Room: d.server.Room, Reason: reply.Reason,
			Fingerprint: reply.Fingerprint, Pending: reply.Pending, Report: reply.Report,
		}
		ended := reply.Reason == waitApprove
		g.mu.Lock()
		a := g.session(session)
		a.push(wake)
		if ended {
			a.told[id] = true
		}
		g.mu.Unlock()
		if ended {
			return
		}
	}
}

// tellClosed is a document leaving, told to the session that owns it: an ended
// review it has heard the end of is no news, one it has not is told now, and any
// other is the review gone with no verdict. A session that has gone hears
// nothing. The document is already out of h.docs, and its cursors go with it.
func (h *Host) tellClosed(id string, d hostedDoc, why string) {
	g := h.agents
	owner := d.options.Owner
	g.mu.Lock()
	defer g.mu.Unlock()
	told := false
	for _, a := range g.sessions {
		if at := a.attached[id]; at != nil {
			at.cancel()
			delete(a.attached, id)
		}
		told = told || a.told[id]
		delete(a.told, id)
		delete(a.cursors, id)
	}
	if owner == "" || g.ctx.Err() != nil || !h.sessions.SessionLive(owner) {
		return
	}
	a := g.session(owner)
	page, room := d.server.MdPath, d.server.Room
	if d.server.Sealed() {
		if !told {
			a.push(AgentWake{Page: page, Room: room, Reason: waitApprove, Pending: &PendingView{Instructions: []InstructionView{}}})
		}
		return
	}
	a.push(AgentWake{Page: page, Room: room, Reason: waitClosedR, Note: why})
	a.gone = append(a.gone, fmt.Sprintf("%s — %s (no verdict was given)", page, why))
	if len(a.gone) > agentGoneKept {
		a.gone = a.gone[len(a.gone)-agentGoneKept:]
	}
}

// tellNotReopened is a saved document that failed to come back after a restart:
// its session, still live, would otherwise wait on it forever. h.mu is held.
func (h *Host) tellNotReopened(d savedDoc, err error) {
	if d.Owner == "" {
		return
	}
	g := h.agents
	g.mu.Lock()
	defer g.mu.Unlock()
	why := fmt.Sprintf("it did not come back after a restart: %v", err)
	g.session(d.Owner).push(AgentWake{Page: AdvertisedPath(d.Path), Reason: waitClosedR, Note: why})
}

// handleAgentWait is GET /api/agent/wait?session=&root=&timeout=: it answers 200
// with the session's next wake from any document it owns, or 204 at the timeout
// (seconds) or when the server stops. root is the session's folder, which
// unowned documents are claimed from.
func (h *Host) handleAgentWait(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	session := q.Get("session")
	if session == "" {
		http.Error(w, "session is required", http.StatusBadRequest)
		return
	}
	secs := agentWaitDefault
	if v, err := strconv.Atoi(q.Get("timeout")); err == nil && v > 0 {
		secs = min(v, agentWaitMax)
	}
	g := h.agents
	g.mu.Lock()
	a := g.session(session)
	a.waits++
	if root := q.Get("root"); root != "" {
		a.root = root
	}
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		a := g.session(session)
		a.waits--
		a.last = time.Now()
	}()
	h.reconcile()

	deadline := time.NewTimer(time.Duration(secs) * time.Second)
	defer deadline.Stop()
	for {
		g.mu.Lock()
		a := g.session(session)
		notify := a.notify
		var wake *AgentWake
		if len(a.queue) > 0 && r.Context().Err() == nil {
			wake = &a.queue[0]
			a.queue = a.queue[1:]
		}
		g.mu.Unlock()
		if wake != nil {
			writeJSON(w, wake)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-g.ctx.Done():
			w.WriteHeader(http.StatusNoContent)
			return
		case <-deadline.C:
			w.WriteHeader(http.StatusNoContent)
			return
		case <-notify:
		}
	}
}

// handleAgentReport is POST /api/agent/report {session, event, token}: the
// harness saying where a wake stands, for every document the session owns. Each
// resolves it against its own message, so a token that is not its message's
// changes nothing there.
func (h *Host) handleAgentReport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Session string                 `json:"session"`
		Event   channelmcp.ReportEvent `json:"event"`
		Token   string                 `json:"token"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Session == "" {
		http.Error(w, "session is required", http.StatusBadRequest)
		return
	}
	if err := checkReportEvent(in.Event); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	docs := maps.Clone(h.docs)
	h.mu.Unlock()
	for _, d := range docs {
		if d.options.Owner == in.Session {
			d.server.applyReport(in.Event, in.Token)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAgentStatus is GET /api/agent/status?session=.
func (h *Host) handleAgentStatus(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	st := AgentStatus{Docs: h.List()}
	g := h.agents
	g.mu.Lock()
	if a, ok := g.sessions[session]; ok {
		st.Waiting = a.active(time.Now())
		st.Gone = append(st.Gone, a.gone...)
	}
	g.mu.Unlock()
	writeJSON(w, st)
}

// errOwned refuses an open of a document that is another session's.
var errOwned = errors.New("owned")
