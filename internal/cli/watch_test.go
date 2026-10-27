package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/tools-common/channelmcp"
	"github.com/subaud-tools/tools-common/pageserve"
)

// reportToken is a window's report token: 16 hex characters.
var reportToken = regexp.MustCompile(`^[0-9a-f]{16}$`)

// `galley watch` is the channel's scan and attach loop with a JSON line on
// stdout for each wake, which is what the Claude Code plugin's mod reads. A
// Revise press in an editor this session may attach to arrives as one line,
// {"content": ..., "meta": {...}}, with the same meta the channel sends.
func TestWatchPrintsARevisePressAsOneLine(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	srv, ts, _ := liveEditor(t, doc, pageserve.Entry{})

	r, w := io.Pipe()
	c := newChannel(dir, "me")
	c.scanEvery = 20 * time.Millisecond
	c.push = channelmcp.NewLinesFor(w, "galley")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go c.watch(ctx)

	until(t, "the attach", func() bool { return srv.Waiting() > 0 })
	press(t, ts)

	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		if sc.Scan() {
			lines <- sc.Text()
		}
	}()
	var line string
	select {
	case line = <-lines:
	case <-time.After(5 * time.Second):
		t.Fatal("no line printed for the Revise press")
	}
	var ev struct {
		Content string            `json:"content"`
		Meta    map[string]string `json:"meta"`
		Report  string            `json:"report"`
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", line, err)
	}
	if ev.Meta["reason"] != reasonRevise || ev.Meta["doc"] != doc {
		t.Fatalf("meta = %v", ev.Meta)
	}
	// The plugin passes the line's report token back as `galley report landed`.
	if !reportToken.MatchString(ev.Report) {
		t.Fatalf("report = %q, want the window's 16-hex token", ev.Report)
	}
	if !strings.Contains(ev.Content, "Revision requested on "+doc) {
		t.Fatalf("content = %q", ev.Content)
	}
}

// Under Claude Code the plugin's mod runs `galley watch`, so `galley channel`
// must not take rounds too: it serves the tools and leaves every editor
// unattached. Under pi it attaches as it always has.
func TestChannelAttachesOnlyOutsideClaudeCode(t *testing.T) {
	cases := []struct {
		name       string
		claude, pi string
		attaches   bool
	}{
		{"pi", "", "pi-session", true},
		{"claude code", "claude-session", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
			t.Setenv("CLAUDE_CODE_SESSION_ID", tc.claude)
			t.Setenv("AGENT_SESSION_ID", tc.pi)
			t.Setenv("AGENT_SESSION_CHILD", "")
			dir := t.TempDir()
			doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
			srv, _, _ := liveEditor(t, doc, pageserve.Entry{})

			ch := channelFromEnv(dir)
			ch.scanEvery = 20 * time.Millisecond
			r := newRigFor(t, ch)
			if tc.attaches {
				until(t, "the attach", func() bool { return srv.Waiting() > 0 })
				return
			}
			time.Sleep(200 * time.Millisecond)
			if n := srv.Waiting(); n != 0 {
				t.Fatalf("the channel attached under Claude Code (%d waiters); only watch may", n)
			}
			// It still serves its tools.
			if s := r.status(); !strings.Contains(s, "galley watch") {
				t.Fatalf("status does not say rounds go through galley watch:\n%s", s)
			}
		})
	}
}

// Inside pi's claude-bridge the hosting pi session's channel delivers the
// rounds, so `galley watch` prints one stop line and returns at once: the mod
// then never restarts it, and no editor is attached a second time.
func TestWatchStopsInABridgeChild(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	t.Setenv("AGENT_SESSION_CHILD", "1")
	t.Setenv("AGENT_SESSION_ID", "x")
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- runWatch([]string{"--scope", t.TempDir()}, &out, io.Discard) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runWatch = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("galley watch started its loop in a bridge child")
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	var stop struct {
		Stop string `json:"stop"`
	}
	if len(lines) != 1 || json.Unmarshal([]byte(lines[0]), &stop) != nil || stop.Stop == "" {
		t.Fatalf("want exactly one stop line, got %q", out.String())
	}
}

// Outside the bridge `galley watch` prints each wake with `text`, the whole
// prompt the plugin's mod submits as the turn.
func TestWatchLineCarriesText(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	t.Setenv("AGENT_SESSION_CHILD", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	t.Setenv("AGENT_SESSION_ID", "me")
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	srv, ts, _ := liveEditor(t, doc, pageserve.Entry{})

	r, w := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = watchUntil(ctx, []string{"--scope", dir}, w, io.Discard) }()

	until(t, "the attach", func() bool { return srv.Waiting() > 0 })
	press(t, ts)

	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		if sc.Scan() {
			lines <- sc.Text()
		}
	}()
	var line string
	select {
	case line = <-lines:
	case <-time.After(5 * time.Second):
		t.Fatal("no line printed for the Revise press")
	}
	var ev struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", line, err)
	}
	if !strings.HasPrefix(ev.Text, "galley event") {
		t.Fatalf("text = %q, want it to start with \"galley event\"", ev.Text)
	}
}
