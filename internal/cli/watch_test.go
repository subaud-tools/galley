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

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/pageserve"
)

// reportToken is a window's report token: 16 hex characters.
var reportToken = regexp.MustCompile(`^[0-9a-f]{16}$`)

// `galley watch` is the channel's wait loop with a JSON line on stdout for each
// wake, which is what the Claude Code plugin's mod reads. A Revise press in a
// document this session owns arrives as one line: {"text", "content", "meta",
// "report"}, the same meta the channel sends, and text the whole prompt the mod
// submits as the turn.
func TestWatchPrintsARevisePressAsOneLine(t *testing.T) {
	startServer(t)
	t.Setenv("AGENT_SESSION_CHILD", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	t.Setenv("AGENT_SESSION_ID", "me")
	if err := live().AnnounceSession("me"); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	rt := openOnRunning(t, doc, serve.DocOptions{Owner: "me"})

	r, w := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = shell().Watch(ctx, w, io.Discard, pageserve.NewClient(serve.Live(), nil).Passive())
	}()
	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		if sc.Scan() {
			lines <- sc.Text()
		}
	}()
	press(t, rt.URL)

	var line string
	select {
	case line = <-lines:
	case <-time.After(5 * time.Second):
		t.Fatal("no line printed for the Revise press")
	}
	var ev struct {
		Text    string            `json:"text"`
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
	if !reportToken.MatchString(ev.Report) {
		t.Fatalf("report = %q, want the window's 16-hex token", ev.Report)
	}
	if !strings.Contains(ev.Content, "Revision requested on "+doc) {
		t.Fatalf("content = %q", ev.Content)
	}
	if !strings.HasPrefix(ev.Text, "galley event") {
		t.Fatalf("text = %q, want it to start with \"galley event\"", ev.Text)
	}
}

// Inside pi's claude-bridge the hosting pi session's channel delivers the
// rounds, so `galley watch` prints one stop line and returns at once: the mod
// then never restarts it.
func TestWatchStopsInABridgeChild(t *testing.T) {
	isolate(t)
	t.Setenv("AGENT_SESSION_CHILD", "1")
	t.Setenv("AGENT_SESSION_ID", "x")
	var out bytes.Buffer
	var errw strings.Builder
	if code := dispatch([]string{"watch"}, &out, &errw); code != 0 {
		t.Fatalf("watch exited %d: %s", code, errw.String())
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	var stop struct {
		Stop string `json:"stop"`
	}
	if len(lines) != 1 || json.Unmarshal([]byte(lines[0]), &stop) != nil || stop.Stop == "" {
		t.Fatalf("want exactly one stop line, got %q", out.String())
	}
}
