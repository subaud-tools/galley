package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/registry"
)

// recordingEditor is an advertised editor that records each report posted to
// it, owned by owner.
func recordingEditor(t *testing.T, dir, name, owner string) chan map[string]string {
	t.Helper()
	got := make(chan map[string]string, 8)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_galley/report" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		got <- b
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(ts.Close)
	doc := writeDoc(t, dir, name, "# T\n")
	room := "room" + name[:1] + "0123456789abcdef0123456789abcdef"
	if err := registry.Write(registry.Entry{URL: ts.URL, Room: room, Page: doc, PID: os.Getpid(), Owner: owner}); err != nil {
		t.Fatal(err)
	}
	return got
}

// `galley report`, which the Claude Code plugin runs, posts the report to
// every editor the session owns, and to no other.
func TestReportReachesOnlyTheSessionsEditors(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	t.Setenv("CLAUDE_CODE_SESSION_ID", "sess-a")
	t.Setenv("AGENT_SESSION_ID", "")
	t.Setenv("AGENT_SESSION_CHILD", "")
	dir := t.TempDir()
	mine := recordingEditor(t, dir, "a.md", "sess-a")
	theirs := recordingEditor(t, dir, "b.md", "sess-b")

	for _, c := range []struct {
		args         []string
		event, token string
	}{
		{[]string{"landed", "0123456789abcdef"}, "landed", "0123456789abcdef"},
		{[]string{"held", "0123456789abcdef"}, "held", "0123456789abcdef"},
		{[]string{"turn-ended"}, "turn_ended", ""},
	} {
		if out, errw, code := galleyCLI(t, append([]string{"report"}, c.args...)...); code != 0 {
			t.Fatalf("report %v: exit %d: %s %s", c.args, code, out, errw)
		}
		select {
		case b := <-mine:
			if b["event"] != c.event || b["token"] != c.token {
				t.Fatalf("report %v posted %v", c.args, b)
			}
		default:
			t.Fatalf("report %v did not reach the session's editor", c.args)
		}
		select {
		case b := <-theirs:
			t.Fatalf("report %v reached another session's editor: %v", c.args, b)
		default:
		}
	}
}

// Under pi, channels.tools sends the channel a report notification; the
// channel posts each to the session's editors in the order sent, and an
// editor slow to answer never holds up a tool call.
func TestTheChannelPostsReportsInOrderOffTheReadLoop(t *testing.T) {
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())
	dir := t.TempDir()
	release := make(chan struct{})
	got := make(chan map[string]string, 4)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_galley/report" {
			// The channel attaches to the editor it owns; hold its poll.
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return
		}
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		<-release // a slow editor
		got <- b
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(ts.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	doc := writeDoc(t, dir, "a.md", "# T\n")
	if err := registry.Write(registry.Entry{URL: ts.URL, Room: "room-a0123456789abcdef", Page: doc, PID: os.Getpid(), Owner: "sess-a"}); err != nil {
		t.Fatal(err)
	}

	r := newRig(t, dir, "sess-a", time.Hour)
	r.send(`{"jsonrpc":"2.0","method":"notifications/channels/report","params":{"event":"landed","report":"0123456789abcdef"}}`)
	r.send(`{"jsonrpc":"2.0","method":"notifications/channels/report","params":{"event":"turn_ended"}}`)
	r.send(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"galley_channel_status","arguments":{}}}`)
	select {
	case <-r.reply:
	case <-time.After(2 * time.Second):
		t.Fatal("a tool call waited on the editor's report answer")
	}
	close(release)
	for i, w := range []map[string]string{
		{"event": "landed", "token": "0123456789abcdef"},
		{"event": "turn_ended", "token": ""},
	} {
		select {
		case b := <-got:
			if b["event"] != w["event"] || b["token"] != w["token"] {
				t.Fatalf("report %d posted %v, want %v", i+1, b, w)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("report %d never reached the editor", i+1)
		}
	}
}
