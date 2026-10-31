// edit.go is the CLI surface for edit mode: `edit`, `pending`, `revise`. Live
// through the server's JSON endpoints when it holds the document
// (serve.FindRuntime), offline from the files otherwise.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/galley/internal/versions"
	"github.com/subaud-tools/tools-common/pageserve"
)

// pendingPayload mirrors the JSON shape of serve.EditServer's internal
// pendingView exactly (same field names, same tags) — GET /_galley/pending
// decodes straight into this, and the offline path builds one from a plain
// parse, so callers never see a different shape depending on where the data
// came from.
// instructionPayload and pendingPayload ARE the server's own types, aliased.
//
// They used to be hand-written near-copies, and the copy is what cost us: the
// CLI's instruction struct carried Text, Quote and At and NO KEY, while
// `serve.InstructionView` had carried `key` all along. Both carriers told the
// agent to answer "by the key the round handed you" and the round handed over
// none, so a paired agent sent `answers` on none of 23 changes across three
// rounds — it had nothing to answer with. Nothing failed loudly because a JSON
// decoder ignores what it is not asked for, and no test compared the two
// shapes.
//
// AN ALIAS CANNOT DISAGREE WITH ITSELF, which is the whole point. These are
// the same types the server marshals and the same types `web/wire.d.ts` is
// generated from, so a field added, renamed or removed on the server reaches
// every CLI surface and the browser in one move — and `just verify` fails on
// drift rather than a reviewer noticing months later.
//
// The CLI reads only some of these fields. That is fine and is not a reason to
// keep a narrower copy: the cost of the copy was never the unused fields, it
// was the one field nobody noticed was missing.
type instructionPayload = serve.InstructionView

type pendingPayload = serve.PendingView

// --- galley edit ---

// editFlags is galley edit's flag set, built by newEditFlags so the app
// registry (NewFlags) and runEdit share one side-effect-free construction.
type editFlags struct {
	port     *int
	noOpen   *bool
	onRevise *string
	onSettle *string
	quiet    *time.Duration
	root     *string
	owner    *string
}

func newEditFlags() (*flag.FlagSet, *editFlags) {
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	v := &editFlags{
		port:   fs.Int("port", 0, "port for the server, when this command starts it (default: the last one used, else a free one)"),
		noOpen: fs.Bool("no-open", false, "do not open a browser"),
		onRevise: fs.String("on-revise", "", "shell command that hands the round's instructions to an agent, "+
			"run on demand (POST /_galley/revise, or the editor's Revise button)"),
		onSettle: fs.String("on-settle", "", "shell command to run once the document settles in live mode "+
			"(e.g. 'muster nudge galley')"),
		quiet: fs.Duration("quiet", 8*time.Second, "how long the document must sit unchanged before --on-settle fires"),
		root: fs.String("root", "", "site root to serve preview assets from, for an HTML page (default: the page's own "+
			"directory). Set it to the site root so a subpage's ../shared assets resolve in the preview "+
			"as they do when the whole site is served from that root."),
		owner: fs.String("owner", "", "session id that owns this document — set by the channel's galley_open tool, "+
			"never by hand. That session's channel must be live; the document closes when it stops. "+
			"Omit it for a document that belongs to no session (a plain terminal)."),
	}
	return fs, v
}

// runEdit is a client of the server: it starts the server if none is running,
// registers the document, prints its address and stays until the document
// closes. Ctrl-C, SIGTERM and SIGHUP (the terminal closing) close it. The owner's session, an approve and the
// page's Done are the server's to act on; this process hears the document go.
func runEdit(args []string, out, errw io.Writer) error {
	fs, v := newEditFlags()
	pos, err := splitPositional(fs, args, out)
	if err != nil {
		return err
	}
	// From 0.23.0 a channel opens documents on the server itself, so only an
	// older one, still running since before the install, starts this with --owner.
	if *v.owner != "" {
		_, _ = fmt.Fprintln(errw, "galley edit --owner comes from a galley channel older than 0.23.0, which can't use this server; restart that agent session")
	}
	if err := requireLiveOwner(*v.owner); err != nil {
		return err
	}
	abs, err := filepath.Abs(pos[0])
	if err != nil {
		return err
	}
	dir, err := os.Getwd()
	if err != nil {
		return err
	}

	if e, err := serve.Running(); err == nil && *v.port != 0 && e.Base != fmt.Sprintf("http://127.0.0.1:%d", *v.port) {
		_, _ = fmt.Fprintf(errw, "galley serve is already running at %s; --port %d is not used\n", e.Base, *v.port)
	}
	client := pageserve.NewClient(serve.Live(), func() (pageserve.Entry, error) {
		if *v.port != 0 {
			return serve.Process().Start(pageserve.Executable(), *v.port)
		}
		return serve.Process().Ensure(pageserve.Executable())
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	var doc serve.OpenAnswer
	if _, err := client.Do(ctx, http.MethodPost, "/api/docs", serve.OpenRequest{
		Path: abs,
		DocOptions: serve.DocOptions{
			Owner: *v.owner, OnRevise: *v.onRevise, OnSettle: *v.onSettle, Quiet: *v.quiet, Root: *v.root, Dir: dir,
		},
	}, &doc); err != nil {
		// The server's own sentence, without its status.
		var refused *pageserve.StatusError
		if errors.As(err, &refused) {
			return errors.New(refused.Msg)
		}
		return err
	}

	_, _ = fmt.Fprintf(out, "document  %s\n", doc.Page)
	_, _ = fmt.Fprintf(out, "room      %s\n", doc.Room)
	_, _ = fmt.Fprintf(out, "serving   %s\n", doc.URL)
	for _, line := range editStartupLines(filepath.Base(doc.Page), *v.onRevise, *v.onSettle, *v.quiet) {
		_, _ = fmt.Fprintln(out, line)
	}
	_, _ = fmt.Fprintln(out, "\nEdits sync as you type. Ctrl-C to stop.")
	if !*v.noOpen {
		openBrowser(doc.URL)
	}

	if holdDocument(ctx, client.Passive(), doc.ID, *v.owner, errw) {
		_, _ = fmt.Fprintln(out, "the document was closed")
		return nil
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), closeWait)
	defer cancel()
	if _, err := client.Passive().Do(closeCtx, http.MethodDelete, "/api/docs/"+doc.ID, nil, nil); err != nil {
		var refused *pageserve.StatusError
		if !errors.As(err, &refused) || refused.Code != http.StatusNotFound {
			return fmt.Errorf("closing %s: %w", doc.Page, err)
		}
	}
	_, _ = fmt.Fprintf(out, "\n%s\n", doc.Page)
	return nil
}

// closeWait bounds the final flush a close waits for.
const closeWait = 10 * time.Second

// holdInterval is how often `galley edit` looks for its document.
const holdInterval = 500 * time.Millisecond

// holdDocument waits for the document to leave the server, and reports true
// when it has; false means ctx ended first. A stopped server is not a closed
// document: it comes back holding it, so this keeps waiting, unless the owner's
// session has gone too, when it would not come back.
func holdDocument(ctx context.Context, client *pageserve.Client, id, owner string, errw io.Writer) bool {
	t := time.NewTicker(holdInterval)
	defer t.Stop()
	saidGone := false
	for {
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
		}
		var docs []serve.DocView
		if _, err := client.Do(ctx, http.MethodGet, "/api/docs", nil, &docs); err != nil {
			if ctx.Err() != nil {
				return false
			}
			if owner != "" && !live().SessionLive(owner) {
				return true
			}
			if !saidGone {
				_, _ = fmt.Fprintf(errw, "galley serve is not answering (%v); waiting for it to come back\n", err)
				saidGone = true
			}
			continue
		}
		saidGone = false
		if !slices.ContainsFunc(docs, func(d serve.DocView) bool { return d.ID == id }) {
			return true
		}
	}
}

// editStartupLines reports how this session is configured to answer a Revise
// press: pull (`galley wait`), then the two push variants layered on top of
// it. Pull comes first and is printed unconditionally, because it is the
// primary loop — the session already in the room blocks on it, no flag
// required — and push (--on-revise, --on-settle) is the cold-start and
// live-notify fallback for when nobody is. Presenting push first would read
// as though the two were equals; they are not.
//
// Deliberately silent about who is actually waiting right now. At the point
// this runs the listener has not accepted a single connection yet, so
// "waiting: 0" would be true but meaningless — and even once the server is
// serving, a waiter can attach or leave between one line of output and the
// next (see EditServer.Waiting). These lines describe how the server was
// CONFIGURED; asking who is listening this second belongs to the moment a
// Revise press actually asks, which is exactly what handleRevise's 501
// message does.
//
// KEPT DELIBERATELY SHORT. This prints on every single `galley edit`, unlike
// `document`/`room`/`serving` above it whose length is the path's
// fault, not the label's. An early draft spelled out the full reasoning here
// — why a waiter is dynamic, why a settle only wakes one in ● live — and
// that reasoning is real, but it belongs somewhere a reader goes once
// (`galley edit -h`, and this doc comment), not somewhere it is read and
// re-read on every startup. Each line keeps exactly one fact: what is
// configured, that a waiter is reached either way, and — for on-settle — the
// mode asymmetry, since that is the one a reader cannot guess.
func editStartupLines(mdBase, onRevise, onSettle string, quiet time.Duration) []string {
	const label = "%-9s  %s"
	lines := []string{
		fmt.Sprintf(label, "pull", fmt.Sprintf(
			"`galley wait %s` — waits for Revise (● live: also a settle)", mdBase)),
	}

	if onRevise != "" {
		lines = append(lines, fmt.Sprintf(label, "on-revise",
			fmt.Sprintf("%s  (on demand only — the editor's Revise button, or `galley revise`)", onRevise)))
	} else {
		// The half that used to go unsaid: a missing --on-revise announced
		// nothing, while a missing --on-settle got a line below. One dead hook
		// silent and the other narrated cost a live diagnosis, twice — this
		// says the same thing --on-settle's unset branch always has, at the
		// same length. The full "refuses only if neither is listening" case
		// is in `galley edit -h`, not repeated here.
		lines = append(lines, fmt.Sprintf(label, "on-revise",
			"unset — a Revise press still reaches `galley wait "+mdBase+"` if blocked"))
	}

	// Said out loud in both directions. Live mode with no command configured
	// is silence, and silence is indistinguishable from a broken agent — so
	// the reviewer learns here, at startup, rather than by flipping the toggle
	// and waiting for nothing to happen.
	if onSettle != "" {
		lines = append(lines, fmt.Sprintf(label, "on-settle",
			fmt.Sprintf("%s  (after %s of quiet, in ● live mode only)", onSettle, quiet)))
	} else {
		// NOT "still wakes" unqualified — that claim went stale the moment
		// this handled --on-revise being optional. A Revise press wakes a
		// `galley wait` session in EITHER mode; a settle only wakes one once
		// the session has been switched to ● live, whether or not --on-settle
		// itself is set (Notifier.SetWake is the pull half of the same event
		// Command pushes). Collapsing that into one unconditional "wakes"
		// would be wrong within a minute of `on ask`, the default, staying
		// the default — so the mode asymmetry stays even in the short form.
		lines = append(lines, fmt.Sprintf(label, "on-settle",
			"unset — `galley wait "+mdBase+"` wakes on Revise always, on settle only in ● live"))
	}

	return lines
}

// requireLiveOwner is the whole of the ownership check: --owner names a
// session, and that session must have a channel listening right now.
//
// THE OWNER IS AN ARGUMENT, NEVER THE ENVIRONMENT. This command used to read
// CLAUDE_CODE_SESSION_ID / AGENT_SESSION_ID and stamp whatever it found. Under
// pi, in-process subagents rewrite the shared AGENT_SESSION_ID, so an editor
// launched from the parent's shell after a dispatch was stamped with a child's
// id and the parent's channel — correctly — refused it (2026-09-08). The
// channel now opens editors for its own session and passes the id here;
// nothing else is trusted to know it. An owner with no live presence is
// refused outright rather than served unbound: an editor that claims a
// session nothing is listening for is the misroute this flag exists to end.
func requireLiveOwner(owner string) error {
	if owner == "" {
		return nil
	}
	if !live().SessionLive(owner) {
		return fmt.Errorf("owner session %s has no live channel", owner)
	}
	return nil
}

// --- galley pending ---

// pendingFlags is galley pending's flag set, built by newPendingFlags so the
// app registry (NewFlags) and runPending share one construction.
type pendingFlags struct {
	asJSON *bool
}

func newPendingFlags() (*flag.FlagSet, *pendingFlags) {
	fs := flag.NewFlagSet("pending", flag.ContinueOnError)
	v := &pendingFlags{
		asJSON: fs.Bool("json", false, "emit the pending view verbatim"),
	}
	return fs, v
}

func runPending(args []string, out, errw io.Writer) error {
	fs, v := newPendingFlags()
	pos, err := splitPositional(fs, args, out)
	if err != nil {
		return err
	}
	asJSON := v.asJSON
	doc := pos[0]

	view, live, err := loadPending(doc)
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(view)
	}

	source := "on disk"
	if live {
		source = "live"
	}
	if len(view.Instructions) == 0 {
		fmt.Printf("nothing pending on %s (%s)\n", filepath.Base(doc), source)
		return nil
	}
	fmt.Printf("%d instruction(s) on %s (%s)\n\n", len(view.Instructions), filepath.Base(doc), source)
	fmt.Print(formatReviewerChanges(view.Changes, view.ChangesDropped))
	fmt.Print(formatInstructions(view.Instructions))
	return nil

}

// formatInstructions is the one human rendering of a captured instruction
// round. Both wake carriers use it because the Revise handoff clears the live
// pending marks: re-reading /pending after the wake cannot recover the quote
// that says where the instruction belongs.
// formatReviewerChanges is what the reviewer changed BY HAND, rendered above
// their instructions.
//
// IT LEADS THE ROUND, and that placement is the whole point. An agent reads a
// round in order and acts on it in order; a list of "do not undo these" that
// arrives after eight instructions telling it to expand and clarify has
// already lost. The measured failure it exists to prevent — a deleted section
// rewritten back inside an expansion answering a different ask — happened to
// an agent that was told to be clearer and told nothing about the deletion.
//
// Removals lead within it for the same reason: an addition the agent
// duplicates is untidy, a removal it reverses is the reviewer's work destroyed.
func formatReviewerChanges(changes []serve.ReviewerChange, dropped int) string {
	if len(changes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("The reviewer also edited the document directly. Do not undo these.\n\n")
	for _, kind := range []string{"removed", "changed", "added"} {
		var lines []string
		for _, c := range changes {
			if c.Kind != kind {
				continue
			}
			switch kind {
			case "removed":
				lines = append(lines, fmt.Sprintf("  · %s", quoteClip(c.Before)))
			case "changed":
				lines = append(lines, fmt.Sprintf("  · %s → %s", quoteClip(c.Before), quoteClip(c.After)))
			case "added":
				lines = append(lines, fmt.Sprintf("  · %s", quoteClip(c.After)))
			}
		}
		if len(lines) == 0 {
			continue
		}
		fmt.Fprintf(&b, "%s (%d):\n%s\n\n", strings.ToUpper(kind), len(lines), strings.Join(lines, "\n"))
	}
	if dropped > 0 {
		// SAID OUT LOUD. A cap nobody is told about reads as "that is all of
		// them", which is worse than the cap.
		fmt.Fprintf(&b, "(%d more not listed — the reviewer reworked a lot by hand; read the document.)\n\n", dropped)
	}
	return b.String()
}

// quoteClip keeps a summary line readable without hiding that it was clipped.
func quoteClip(s string) string {
	const max = 120
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return strconv.Quote(s)
	}
	return strconv.Quote(s[:max]) + "…"
}

func formatInstructions(instructions []instructionPayload) string {
	var b strings.Builder
	for _, instruction := range instructions {
		// THE KEY IS PRINTED FIRST AND LABELLED, because the agent has to copy
		// it into its ack's `answers` and the contract names it by that word.
		// An unlabelled token beside a quote reads as decoration; `key ...` is
		// the field it goes into, spelled the same way the ack spells it.
		//
		// It leads rather than trails for the case with no quote — a
		// whole-document instruction has no heading, and a key printed after
		// the text would be adrift between two instructions with nothing
		// saying which one it belongs to.
		switch {
		case instruction.Key != "" && instruction.Quote != "":
			fmt.Fprintf(&b, "> %s  [key %s]\n", instruction.Quote, instruction.Key)
		case instruction.Key != "":
			fmt.Fprintf(&b, "[key %s]\n", instruction.Key)
		case instruction.Quote != "":
			fmt.Fprintf(&b, "> %s\n", instruction.Quote)
		}
		for _, line := range strings.Split(instruction.Text, "\n") {
			fmt.Fprintf(&b, "  %s\n", line)
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// loadPending reads the live server's pending view when one is running and
// reachable, falling back to an offline parse. Unreachable falls through; a
// real rejection does not.
//
// A page is read where its review lives: the editor on page.html advertises
// and keeps its prose in the page's content.md, with the unsent round beside
// it, and page.html itself carries no comment marks. serve.AdvertisedPath is
// that one mapping, the same the editor uses.
func loadPending(docPath string) (pendingPayload, bool, error) {
	if abs, err := filepath.Abs(docPath); err == nil {
		docPath = serve.AdvertisedPath(abs)
	}
	if rt, ok := serve.FindRuntime(docPath); ok {
		resp, err := getPendingHTTP(rt.URL) //nolint:bodyclose // decodeOK closes it
		if err == nil {
			var view pendingPayload
			if decErr := decodeOK(resp, &view); decErr != nil {
				return pendingPayload{}, false, decErr
			}
			return view, true, nil
		}
	}
	view, err := offlinePending(docPath)
	return view, false, err
}

// offlinePending builds the same shape a live GET /_galley/pending would,
// with no editor running: the unsent round in pending.json, placed against
// the .md, through the one instruction builder the live server uses (see
// serve.OfflineInstructions). A range comment's words live in pending.json,
// so it is listed after the editor stops, as it is while it runs.
func offlinePending(docPath string) (pendingPayload, error) {
	instructions, err := serve.OfflineInstructions(docPath)
	if err != nil {
		return pendingPayload{}, err
	}
	view := pendingPayload{Instructions: instructions}
	// THE SAME ANSWER WITH OR WITHOUT A SERVER. `galley pending` read offline
	// must not report a smaller round than the live one — that equivalence is
	// this repository's own promise, and a reviewer's deletion is exactly the
	// thing an agent must not be told about only sometimes. The store is on
	// disk beside the document, so nothing needs a server to read it.
	view.Changes, view.ChangesDropped = serve.ReviewerChanges(versions.Open(docPath))
	return view, nil
}

// --- galley revise ---

// newReviseFlags is galley revise's flag set: no flags of its own, but built
// the same way as every other migrated command's so NewFlags is uniform.
func newReviseFlags() *flag.FlagSet {
	return flag.NewFlagSet("revise", flag.ContinueOnError)
}

func runRevise(args []string, out, errw io.Writer) error {
	fs := newReviseFlags()
	pos, err := splitPositional(fs, args, out)
	if err != nil {
		return err
	}
	doc := pos[0]

	rt, ok := serve.FindRuntime(doc)
	if !ok {
		return errNoServer(doc)
	}
	resp, err := postReviseHTTP(rt.URL)
	if err != nil {
		return errNoServer(doc)
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusNoContent:
		fmt.Println("revision requested")
		return nil
	case http.StatusConflict:
		return reviseConflict(rt.URL, resp)
	case http.StatusNotImplemented:
		msg, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s (start `galley edit %s --on-revise '...'` to enable it)",
			strings.TrimSpace(string(msg)), doc)
	default:
		msg, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server rejected the revise request: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
}

// reviseConflict decides what a 409 from POST /_galley/revise MEANS, and it
// exists because this command used to assume there was only one thing it could
// mean.
//
// There was, once. handleRevise's single-flight guard answers 409 when a
// --on-revise command is still running, and that is genuinely not an error:
// work is already happening, which is what asking for a revision wanted. So
// `galley revise` printed "a revision is already in flight", returned nil, and
// exited 0 — for EVERY 409.
//
// The seal (#69) added a second, opposite one. `refuseSealed` answers 409 for a
// review that has ENDED: there is no next round to ask for and nothing was
// woken. Read as the first, it printed a reassuring sentence over a refusal and
// exited 0 — measured on a sealed fixture, and left as a comment at a
// deliberately-absent assertion in seal_test.go rather than fixed there.
//
// THE DISCRIMINATOR IS THE SERVER'S OWN ANSWER, NOT A SECOND COPY OF ITS RULE.
// Matching the refusal's wording here would be CLAUDE.md's "six agreeing
// spellings and one silence" with a string literal for a spelling: the seal's
// sentence would be pinned in two repositories' worth of places and the next
// 409 anyone adds would be silently misread again, exactly as this one was. GET
// /_galley/revise already publishes `sealed` and `running` — the same server,
// answering the same question it just answered with the status code — so the
// CLI asks it.
//
// A STATE READ THAT FAILS FALLS TO THE ERROR SIDE. The refusal is what the
// server actually said, and reporting it is never wrong; claiming success we
// cannot justify is. Only a positive "a revision is running" buys the
// reassuring sentence and the zero exit.
func reviseConflict(baseURL string, resp *http.Response) error {
	// The body is closed by runRevise's own defer, like every other branch of
	// its switch.
	raw, _ := io.ReadAll(resp.Body)
	said := strings.TrimSpace(string(raw))
	st, err := reviseState(baseURL)
	if err == nil && st.Running && !st.Sealed {
		fmt.Println("a revision is already in flight — it will act on whatever is pending when it finishes")
		return nil
	}
	if said == "" {
		said = "the server refused the revision request"
	}
	return errors.New(said)
}

// reviseStateView is the part of GET /_galley/revise this file reads. It is
// deliberately narrow: two facts, both of which the same handler uses to decide
// which 409 to answer with.
type reviseStateView struct {
	Running bool `json:"running"`
	Sealed  bool `json:"sealed"`
}

func reviseState(baseURL string) (reviseStateView, error) {
	resp, err := serverClient.Get(baseURL + "/_galley/revise")
	if err != nil {
		return reviseStateView{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return reviseStateView{}, fmt.Errorf("revise state: %s", resp.Status)
	}
	var st reviseStateView
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return reviseStateView{}, err
	}
	return st, nil
}

// errNoServer is TERMINAL, and says so, because the shape it is read in is a
// retry loop. A review exists only while the server holds the document, so every caller
// here — wait, ack, the edit-mode probes — is asking about something that does
// not exist yet rather than something running late. Measured: an agent told
// only "no server running" read it as transient and spun `galley wait` 360
// times against a document nobody had opened. Naming the command was not
// enough; the message has to refuse the retry.
func errNoServer(doc string) error {
	return fmt.Errorf("no server running for %s — a review exists only while `galley edit %s` is running, "+
		"so waiting or retrying will not start one; open it first", doc, doc)
}

// --- HTTP calls, factored out so they can be exercised against an
// httptest.Server directly, with no server and no subprocess. Each one
// is exactly the request; interpreting the response (success, fall back
// offline, or surface the server's own error text) is the caller's job, the
// same division runReply/runResolve in main.go already use. ---

func getPendingHTTP(baseURL string) (*http.Response, error) {
	return serverClient.Get(baseURL + "/_galley/pending")
}

func postReviseHTTP(baseURL string) (*http.Response, error) {
	return serverClient.Post(baseURL+"/_galley/revise", "application/json", nil)
}

// decodeOK reads a 200 response's JSON body into v; a non-200 response is
// turned into an error carrying the server's own message (the same text a
// human running the live endpoint by hand would see), rather than a generic
// "request failed". Either way the body is closed here, so no caller has to
// remember to.
func decodeOK(resp *http.Response, v any) error {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return errors.New(strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}
