package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/registry"
	"github.com/subaud-tools/tools-common/channelmcp"
)

// `galley watch` is the channel's scan and attach loop with a JSON line on
// stdout for each wake, which is what the Claude Code plugin's mod reads. A
// Revise press in an editor this session may attach to arrives as one line,
// {"content": ..., "meta": {...}}, with the same meta the channel sends.
func TestWatchPrintsARevisePressAsOneLine(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	srv, ts, _ := liveEditor(t, doc, registry.Entry{})

	r, w := io.Pipe()
	c := newChannel(dir, "me")
	c.scanEvery = 20 * time.Millisecond
	c.push = channelmcp.NewLines(w)
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
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", line, err)
	}
	if ev.Meta["reason"] != reasonRevise || ev.Meta["doc"] != doc {
		t.Fatalf("meta = %v", ev.Meta)
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
			srv, _, _ := liveEditor(t, doc, registry.Entry{})

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
