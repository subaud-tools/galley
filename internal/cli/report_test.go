package cli

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/channelmcp"
)

// A report reaches the document the wake came from, from the CLI the Claude Code
// plugin runs and from pi's report notification alike: the page shows where the
// Revise stands. That only the session's documents hear it is the server's: see
// TestAgentReportReachesOnlyTheSessionsDocuments.
func TestReportsReachTheSessionsDocuments(t *testing.T) {
	cases := []struct {
		name string
		send func(t *testing.T, r *chanRig, token string)
	}{
		{"galley report", func(t *testing.T, _ *chanRig, token string) {
			t.Setenv("CLAUDE_CODE_SESSION_ID", "session-me")
			t.Setenv("AGENT_SESSION_ID", "")
			t.Setenv("AGENT_SESSION_CHILD", "")
			if out, errw, code := galleyCLI(t, "report", "landed", token); code != 0 {
				t.Fatalf("report: exit %d: %s %s", code, out, errw)
			}
		}},
		{"pi's notification", func(t *testing.T, r *chanRig, token string) {
			r.send(`{"jsonrpc":"2.0","method":"notifications/channels/report","params":{"event":"landed","report":"` + token + `"}}`)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			startServer(t)
			dir := t.TempDir()
			doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
			r := newRig(t, "session-me", dir)
			base := baseOf(r.open(doc).URL)
			press(t, base)
			token, _ := r.note("the press")[channelmcp.MetaReport].(string)
			tc.send(t, r, token)
			deadline := time.Now().Add(5 * time.Second)
			for {
				var st serve.ReviseStateView
				resp, err := serverClient.Get(base + "/_galley/revise")
				if err != nil {
					t.Fatal(err)
				}
				err = json.NewDecoder(resp.Body).Decode(&st)
				_ = resp.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				if st.Message != nil && string(st.Message.State) == "with_agent" {
					return
				}
				if time.Now().After(deadline) {
					t.Fatalf("the message is %+v", st.Message)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
