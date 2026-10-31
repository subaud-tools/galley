package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/channelmcp"
	"github.com/subaud-tools/tools-common/pageserve"
)

// buildGalley compiles the real binary once per test that needs it: `galley
// edit` starts the server from the binary it is.
func buildGalley(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "galley")
	cmd := exec.Command("go", "build", "-buildvcs=false", "-o", exe, "../../cmd/galley")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("building galley: %v", err)
	}
	return exe
}

// chanRig is one session's channel on pipes with a live MCP client behind it:
// handshake done, events drained into a queue, tool calls answered.
type chanRig struct {
	t      *testing.T
	ch     *pageserve.Channel
	in     *io.PipeWriter
	notes  chan map[string]any
	reply  chan map[string]any
	id     int
	opened chan string
}

// sessionChannel is a channel for session in folder, on the running server,
// waiting in short polls, that records the pages it opens.
func sessionChannel(session, folder string) *pageserve.Channel {
	ch := pageserve.New(channelSpec(), pageserve.Identity{Session: session, Harness: "pi", CWD: folder},
		pageserve.NewClient(serve.Live(), nil))
	ch.Poll, ch.Retry = time.Second, 20*time.Millisecond
	return ch
}

func newRig(t *testing.T, session, folder string) *chanRig {
	t.Helper()
	return newRigFor(t, sessionChannel(session, folder))
}

func newRigFor(t *testing.T, ch *pageserve.Channel) *chanRig {
	t.Helper()
	r := &chanRig{
		t: t, ch: ch,
		notes:  make(chan map[string]any, 8),
		reply:  make(chan map[string]any, 8),
		opened: make(chan string, 8),
	}
	ch.Open = func(url string) error { r.opened <- url; return nil }
	clientOut, serverIn := io.Pipe()
	serverOut, clientIn := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = aroundChannel(ctx, ch, func() error { return ch.Run(ctx, clientOut, clientIn) })
	}()
	t.Cleanup(func() {
		cancel()
		_ = serverIn.Close()
		<-done
	})
	r.in = serverIn
	r.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	r.id = 1
	sc := bufio.NewScanner(serverOut)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	if !sc.Scan() {
		t.Fatal("no handshake reply")
	}
	go func() {
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			if m["method"] == "notifications/claude/channel" {
				params, _ := m["params"].(map[string]any)
				meta, _ := params["meta"].(map[string]any)
				if meta == nil {
					meta = map[string]any{}
				}
				meta["content"], _ = params["content"].(string)
				r.notes <- meta
				continue
			}
			if _, ok := m["result"]; ok {
				r.reply <- m
			}
		}
	}()
	return r
}

func (r *chanRig) send(line string) {
	r.t.Helper()
	if _, err := io.WriteString(r.in, line+"\n"); err != nil {
		r.t.Fatal(err)
	}
}

// call makes one tool call through MCP and returns its text.
func (r *chanRig) call(tool, args string) (string, bool) {
	r.t.Helper()
	r.id++
	r.send(`{"jsonrpc":"2.0","id":` + strconv.Itoa(r.id) + `,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + args + `}}`)
	select {
	case m := <-r.reply:
		res, _ := m["result"].(map[string]any)
		content, _ := res["content"].([]any)
		if len(content) == 0 {
			r.t.Fatalf("empty tool result: %v", m)
		}
		first, _ := content[0].(map[string]any)
		text, _ := first["text"].(string)
		bad, _ := res["isError"].(bool)
		return text, bad
	case <-time.After(10 * time.Second):
		r.t.Fatalf("%s never answered", tool)
		return "", false
	}
}

func (r *chanRig) status() string {
	r.t.Helper()
	text, bad := r.call("galley_channel_status", "{}")
	if bad {
		r.t.Fatalf("galley_channel_status failed: %s", text)
	}
	return text
}

func (r *chanRig) open(doc string) openResult {
	r.t.Helper()
	text, bad := r.call("galley_open", `{"doc":`+strconvQuote(doc)+`}`)
	if bad {
		r.t.Fatalf("galley_open: %s", text)
	}
	var res openResult
	if err := json.Unmarshal([]byte(text), &res); err != nil {
		r.t.Fatalf("galley_open returned non-JSON %q: %v", text, err)
	}
	return res
}

func (r *chanRig) note(when string) map[string]any {
	r.t.Helper()
	select {
	case m := <-r.notes:
		return m
	case <-time.After(5 * time.Second):
		r.t.Fatalf("%s: no event arrived", when)
		return nil
	}
}

func (r *chanRig) silence(d time.Duration) {
	r.t.Helper()
	select {
	case m := <-r.notes:
		r.t.Fatalf("unexpected event: %v", m)
	case <-time.After(d):
	}
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// baseOf is a signed-in address without its query, the base a route goes on.
func baseOf(u string) string {
	base, _, _ := strings.Cut(u, "/?")
	return base
}

// press presses Revise until a reader is there: a channel attaches a moment
// after a document opens.
func press(t *testing.T, base string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := serverClient.Post(base+"/_galley/revise", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusNoContent {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Revise answered %d: nobody heard it", resp.StatusCode)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func until(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The whole loop, in one process: a document opens, a Revise press becomes an
// event with the round in it, and a SECOND press becomes a second one, which is
// the re-arm guarantee a channel's whole life is.
func TestChannelForwardsARevisePress(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	opened := r.open(doc)
	base := baseOf(opened.URL)

	notification := func(when, instruction string) string {
		t.Helper()
		m := r.note(when)
		content, _ := m["content"].(string)
		if m["reason"] != "revise" || m["doc"] != doc || m["instructions"] != "1" {
			t.Errorf("%s: meta = %v", when, m)
		}
		tok, _ := m[channelmcp.MetaReport].(string)
		if !reportToken.MatchString(tok) {
			t.Errorf("%s: meta.report = %q, want the window's 16-hex token", when, tok)
		}
		for _, want := range []string{"Revision requested on " + doc, "Hello.", instruction, "galley_ack"} {
			if !strings.Contains(content, want) {
				t.Errorf("%s: the event lost %q:\n%s", when, want, content)
			}
		}
		if strings.Contains(content, "Run `galley pending") {
			t.Errorf("%s: told the agent to discard the captured round:\n%s", when, content)
		}
		return tok
	}

	instructAs(t, base, "Hello.", "Make the greeting warmer.")
	press(t, base)
	first := notification("first press", "Make the greeting warmer.")
	r.silence(300 * time.Millisecond) // one press, one event

	// The first press opened the agent's handoff window and nobody answered
	// it, so the document is read-only to the reviewer. Taking it back files
	// the round's instruction again, and the second press sends it.
	resp, err := serverClient.Post(base+"/_galley/handoff/cancel", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("cancel handoff: %d", resp.StatusCode)
	}
	// Taking the round back moves the document past the channel's cursor only
	// as a re-arm would see it; drain whatever that says.
	press(t, base)
	var second string
	for second == "" {
		m := r.note("second press")
		if m["reason"] == "revise" {
			second, _ = m[channelmcp.MetaReport].(string)
		}
	}
	if second == first {
		t.Errorf("second press carried the first window's report token %q: the first wake was emitted twice", first)
	}
}

// A page-backed Revise carries the page-mode guidance, end to end.
func TestChannelWakeOnAPageCarriesPageGuidance(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	page := writeDoc(t, dir, "post.html", minimalHTML)
	r := newRig(t, "session-me", dir)
	opened := r.open(page)
	press(t, baseOf(opened.URL))
	content, _ := r.note("the press")["content"].(string)
	if !strings.Contains(content, "backed by an HTML page") {
		t.Fatalf("no page guidance:\n%s", content)
	}
}

// A document another live session owns never reaches this one: its status says
// whose it is, and a Revise goes there.
func TestChannelIgnoresAnotherSessionsDocument(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	theirs := newRig(t, "other-session", dir)
	opened := theirs.open(doc)
	mine := newRig(t, "session-me", dir)
	press(t, baseOf(opened.URL))
	if got := theirs.note("the owner")["reason"]; got != "revise" {
		t.Fatalf("reason = %v", got)
	}
	mine.silence(300 * time.Millisecond)
	if s := mine.status(); !strings.Contains(s, "owned by session other-session") || !strings.Contains(s, doc) {
		t.Errorf("status does not name the owning session and the document:\n%s", s)
	}
}

// A second session's galley_open on the first's document is refused as theirs.
func TestOpenRefusesADocumentAnotherLiveSessionOwns(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n")
	newRig(t, "session-other", dir).open(doc)
	me := newRig(t, "session-me", dir)
	text, bad := me.call("galley_open", `{"doc":`+strconvQuote(doc)+`}`)
	if !bad || text != "open in session session-other; its wakes go there" {
		t.Fatalf("answered %v %q", bad, text)
	}
	if len(me.opened) != 0 {
		t.Fatal("the refusal opened a page")
	}
}

// A document whose session has gone can be taken up: reopening makes it this
// session's, and its next Revise wakes here.
func TestOpenTakesUpADocumentWhoseSessionHasGone(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	if err := live().AnnounceSession("session-gone"); err != nil {
		t.Fatal(err)
	}
	openOnRunning(t, doc, serve.DocOptions{Owner: "session-gone"})
	if err := live().WithdrawSession("session-gone"); err != nil {
		t.Fatal(err)
	}
	me := newRig(t, "session-me", dir)
	if s := me.status(); !strings.Contains(s, "no longer running") {
		t.Errorf("status does not say the owner has gone:\n%s", s)
	}
	opened := me.open(doc)
	if rt, ok := serve.FindRuntime(doc); !ok || rt.Owner != "session-me" {
		t.Fatalf("after taking it up: %+v, %v", rt, ok)
	}
	press(t, baseOf(opened.URL))
	if got := me.note("the press")["reason"]; got != "revise" {
		t.Fatalf("reason = %v", got)
	}
}

// A document no session owns reaches the first session under its folder, in
// either spelling of a symlinked folder, and no other; the status names the rest.
func TestChannelTakesAnUnownedDocumentUnderItsFolder(t *testing.T) {
	for _, which := range []string{"plain", "folder is the symlink", "document is the symlink"} {
		t.Run(which, func(t *testing.T) {
			startServer(t)
			real := t.TempDir()
			link := filepath.Join(t.TempDir(), "work")
			if err := os.Symlink(real, link); err != nil {
				t.Skipf("no symlinks here: %v", err)
			}
			docDir, folder := real, real
			switch which {
			case "folder is the symlink":
				folder = link
			case "document is the symlink":
				docDir = link
			}
			doc := writeDoc(t, docDir, "doc.md", "# T\n\nHello.\n")
			rt := openOnRunning(t, doc, serve.DocOptions{})
			r := newRig(t, "session-me", folder)
			press(t, rt.URL)
			if got := r.note("the press")["reason"]; got != "revise" {
				t.Fatalf("reason = %v", got)
			}
			if got, ok := serve.FindRuntime(doc); !ok || got.Owner != "session-me" {
				t.Fatalf("owner: %+v", got)
			}
		})
	}
}

// THE SILENCES A STATUS TELLS APART.
func TestChannelStatusTellsTheSilencesApart(t *testing.T) {
	t.Run("no document is open", func(t *testing.T) {
		startServer(t)
		if s := newRig(t, "me", t.TempDir()).status(); !strings.Contains(s, "no live editor") {
			t.Errorf("status does not say nothing is open:\n%s", s)
		}
	})
	t.Run("open outside my scope", func(t *testing.T) {
		startServer(t)
		doc := writeDoc(t, t.TempDir(), "doc.md", "# T\n\nHello.\n")
		rt := openOnRunning(t, doc, serve.DocOptions{})
		scope := t.TempDir()
		r := newRig(t, "me", scope)
		s := r.status()
		if !strings.Contains(s, "outside this channel's scope") || !strings.Contains(s, scope) {
			t.Errorf("status does not report the scope mismatch (scope %s):\n%s", scope, s)
		}
		time.Sleep(100 * time.Millisecond)
		if got, ok := serve.FindRuntime(rt.Page); !ok || got.Owner != "" {
			t.Fatalf("outside the folder it was claimed: %+v", got)
		}
	})
	t.Run("mine, heard", func(t *testing.T) {
		startServer(t)
		dir := t.TempDir()
		doc := writeDoc(t, dir, "doc.md", "# T\n")
		r := newRig(t, "me", dir)
		r.open(doc)
		until(t, "the session to be waiting", func() bool { return strings.Contains(r.status(), "attached (1)") })
		if s := r.status(); !strings.Contains(s, doc) {
			t.Errorf("status does not list the document:\n%s", s)
		}
	})
	t.Run("mine, nobody waiting", func(t *testing.T) {
		startServer(t)
		dir := t.TempDir()
		doc := writeDoc(t, dir, "doc.md", "# T\n")
		ch := sessionChannel("me", dir)
		ch.ServeOnly = true
		r := newRigFor(t, ch)
		r.open(doc)
		s := r.status()
		if !strings.Contains(s, "NOTHING of this session is waiting") || !strings.Contains(s, "galley watch") {
			t.Errorf("status does not say nothing is waiting, and where to look:\n%s", s)
		}
	})
}

// The agent cannot tell "still reading" from "gone", and one of them means stop
// waiting. A document closed under a review says so, once, and status recalls it.
func TestChannelSaysOnceWhenTheDocumentIsGone(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	opened := r.open(doc)
	if err := postStop(baseOf(opened.URL)); err != nil {
		t.Fatal(err)
	}
	m := r.note("the document closing")
	content, _ := m["content"].(string)
	if m["reason"] != reasonClosed || m["doc"] != doc || m["instructions"] != "unknown" || m["note"] != "the editor stopped" {
		t.Fatalf("meta = %v", m)
	}
	if !strings.Contains(content, "GONE") || !strings.Contains(content, doc) {
		t.Errorf("the sentence does not say the editor is gone: %q", content)
	}
	r.silence(300 * time.Millisecond)
	if s := r.status(); !strings.Contains(s, "recently gone") {
		t.Errorf("status forgot it:\n%s", s)
	}
}

// An approve wakes once with its sentence, and the review closing after it is no
// news.
func TestChannelHearsAnApproveOnce(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	r.open(doc)
	until(t, "the session to be waiting", func() bool { return strings.Contains(r.status(), "attached (1)") })
	if text, bad := r.call("galley_approve", `{"doc":`+strconvQuote(doc)+`}`); bad {
		t.Fatalf("galley_approve: %s", text)
	}
	m := r.note("the approve")
	if content, _ := m["content"].(string); m["reason"] != reasonApprove || !strings.Contains(content, "APPROVED "+doc) {
		t.Fatalf("event = %v", m)
	}
	r.silence(7 * time.Second) // past the unload of an approved review with no page
	if _, ok := serve.FindRuntime(doc); ok {
		t.Fatal("the approved review with no page stayed open")
	}
}

// A SERVER RESTART IS NOT THE EDITOR STOPPING. The document comes back from
// docs.json, the session is told nothing, its next Revise wakes it, and a
// presence record that went missing is written again for the new server.
func TestChannelSaysNothingAcrossARestart(t *testing.T) {
	stop := startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	opened := r.open(doc)
	until(t, "the session to be waiting", func() bool { return strings.Contains(r.status(), "attached (1)") })
	stop()
	r.silence(200 * time.Millisecond)
	runServer(t)
	press(t, baseOf(opened.URL))
	if got := r.note("the press after the restart")["reason"]; got != "revise" {
		t.Fatalf("reason = %v", got)
	}
	r.silence(200 * time.Millisecond)
}

func TestOnServeAnnouncesAMissingSessionAndLeavesALiveOne(t *testing.T) {
	isolate(t)
	ch := sessionChannel("session-me", t.TempDir())
	reannounce(context.Background(), ch, pageserve.Entry{})
	if !live().SessionLive("session-me") {
		t.Fatal("a missing record was not written again")
	}
	// Another process holds the record, as the channel does for `galley watch`.
	holder := exec.Command("sleep", "60")
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Process.Kill(); _ = holder.Wait() })
	file := filepath.Join(live().Dir, "sessions", "session-me.json")
	held := fmt.Sprintf(`{"v":1,"session":"session-me","pid":%d}`, holder.Process.Pid)
	if err := os.WriteFile(file, []byte(held), 0o600); err != nil {
		t.Fatal(err)
	}
	reannounce(context.Background(), ch, pageserve.Entry{})
	if got, err := os.ReadFile(file); err != nil || string(got) != held {
		t.Fatalf("the live record was replaced: %s, %v", got, err)
	}
}

// The channel says the session is here for as long as it runs, including under
// Claude Code, where it only serves the tools: it is what lasts the session.
func TestChannelAnnouncesItsSession(t *testing.T) {
	startServer(t)
	ch := sessionChannel("session-me", t.TempDir())
	ch.ServeOnly = true
	r := newRigFor(t, ch)
	if !live().SessionLive("session-me") {
		t.Fatal("the channel is running and its session is not live")
	}
	_ = r.status()
}

// Under Claude Code the plugin's mod runs `galley watch`, so `galley channel`
// must not take rounds too. Under pi it waits as it always has.
func TestChannelWaitsOnlyOutsideClaudeCode(t *testing.T) {
	cases := []struct {
		name       string
		claude, pi string
		waits      bool
	}{
		{"pi", "", "pi-session", true},
		{"claude code", "claude-session", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			startServer(t)
			t.Setenv("CLAUDE_CODE_SESSION_ID", tc.claude)
			t.Setenv("AGENT_SESSION_ID", tc.pi)
			t.Setenv("AGENT_SESSION_CHILD", "")
			dir := t.TempDir()
			doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
			ch := pageserve.ForSession(channelSpec(), pageserve.NewClient(serve.Live(), nil))
			ch.Poll, ch.Retry = time.Second, 20*time.Millisecond
			r := newRigFor(t, ch)
			opened := r.open(doc)
			if tc.waits {
				press(t, baseOf(opened.URL))
				return
			}
			time.Sleep(200 * time.Millisecond)
			resp, err := serverClient.Post(baseOf(opened.URL)+"/_galley/revise", "application/json", strings.NewReader(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusNotImplemented {
				t.Fatalf("Revise answered %d; only watch may wait under Claude Code", resp.StatusCode)
			}
			if s := r.status(); !strings.Contains(s, "galley watch") {
				t.Fatalf("status does not say rounds go through galley watch:\n%s", s)
			}
		})
	}
}

// `galley channel` as the harness runs it, `--scope .` and all (channels.json),
// starts the server from its own binary at the first tool call and hands back an
// address that signs a browser in.
func TestTheRealChannelStartsTheServer(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	cmd := exec.Command(buildGalley(t), "channel", "--scope", ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "AGENT_SESSION_ID=session-me", "CLAUDE_CODE_SESSION_ID=", "AGENT_SESSION_CHILD=")
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = in.Close(); _ = cmd.Wait() })
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	_, _ = io.WriteString(in, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`+"\n")
	if !sc.Scan() {
		t.Fatal("no handshake reply")
	}
	_, _ = io.WriteString(in, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"galley_open","arguments":{"doc":`+strconvQuote(doc)+`}}}`+"\n")
	if !sc.Scan() {
		t.Fatal("no answer to galley_open")
	}
	var reply struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(sc.Bytes(), &reply); err != nil || reply.Result.IsError {
		t.Fatalf("galley_open: %s (%v)", sc.Bytes(), err)
	}
	var r openResult
	if err := json.Unmarshal([]byte(reply.Result.Content[0].Text), &r); err != nil {
		t.Fatal(err)
	}
	entry, err := serve.Running()
	if err != nil {
		t.Fatalf("no server: %v", err)
	}
	if !strings.HasPrefix(r.URL, entry.Base+"/api/docs/") || !strings.HasSuffix(r.URL, "t="+entry.Token) {
		t.Fatalf("URL = %q", r.URL)
	}
	if rt, ok := serve.FindRuntime(doc); !ok || rt.Owner != "session-me" {
		t.Fatalf("the server says %+v (found %v)", rt, ok)
	}
}
