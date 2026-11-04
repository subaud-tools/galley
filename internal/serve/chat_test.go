package serve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subaud-tools/tools-common/msgstate"
)

// chatSend posts one reviewer message and answers its id.
func chatSend(t *testing.T, h http.Handler, text string) int64 {
	t.Helper()
	rec := post(t, h, "/_galley/chat", map[string]any{"text": text})
	if rec.Code != http.StatusOK {
		t.Fatalf("chat answered %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func chatRead(t *testing.T, h http.Handler) chatView {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/_galley/chat", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET chat answered %d: %s", rec.Code, rec.Body.String())
	}
	var v chatView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func chatMessage(t *testing.T, v chatView, id int64) chatMessageView {
	t.Helper()
	for _, m := range v.Messages {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("no message %d in %+v", id, v.Messages)
	return chatMessageView{}
}

func TestChatMessageIsDeliveredOnTheNextRead(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello.\n")
	t.Cleanup(func() { _ = s.Close() })
	h := s.Handler()

	id := chatSend(t, h, "Why this title?")
	got, err := s.waitOnce(context.Background(), "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got.Reason != waitChat || got.Chat == nil || got.Chat.ID != id || got.Chat.Text != "Why this title?" {
		t.Fatalf("wait = %+v (chat %+v), want a chat wake for message %d", got, got.Chat, id)
	}
	if st := chatMessage(t, chatRead(t, h), id).State; st != msgstate.WithAgent {
		t.Fatalf("state = %q, want with_agent", st)
	}
}

func TestChatMessageIsDeliveredOnce(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello.\n")
	t.Cleanup(func() { _ = s.Close() })
	h := s.Handler()

	chatSend(t, h, "Why this title?")
	if got, err := s.waitOnce(context.Background(), "", time.Second); err != nil || got.Reason != waitChat {
		t.Fatalf("first wait = %+v, %v; want chat", got, err)
	}
	got, err := s.waitOnce(context.Background(), "", 200*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Reason != waitTimeout {
		t.Fatalf("second wait = %+v, want timeout", got)
	}
}

func TestChatReplySettlesTheMessage(t *testing.T) {
	dir := t.TempDir()
	s := newEditServer(t, dir, "doc.md", "# Title\n\nHello.\n")
	h := s.Handler()

	id := chatSend(t, h, "Why this title?")
	if _, err := s.waitOnce(context.Background(), "", time.Second); err != nil {
		t.Fatal(err)
	}
	rec := post(t, h, "/_galley/chat/reply", map[string]any{"message": id, "state": "answered", "text": "It names the **topic**."})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("reply answered %d: %s", rec.Code, rec.Body.String())
	}
	check := func(v chatView) {
		t.Helper()
		if len(v.Messages) != 2 {
			t.Fatalf("messages = %+v, want the question and its answer", v.Messages)
		}
		q, a := v.Messages[0], v.Messages[1]
		if q.ID != id || q.State != msgstate.Answered {
			t.Fatalf("question = %+v, want message %d answered", q, id)
		}
		if a.From != "agent" || a.ReplyTo != id || a.Text != "It names the **topic**." || !strings.Contains(a.HTML, "<strong>topic</strong>") {
			t.Fatalf("answer = %+v, want the agent's reply to %d with its HTML", a, id)
		}
	}
	check(chatRead(t, h))
	_ = s.Close()

	again, err := NewEdit(s.MdPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = again.Close() })
	check(chatRead(t, again.Handler()))
}

func TestChatReplyRefusesAnUnknownMessage(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello.\n")
	t.Cleanup(func() { _ = s.Close() })

	rec := post(t, s.Handler(), "/_galley/chat/reply", map[string]any{"message": 999, "state": "answered", "text": "x"})
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "no message 999 in this review") {
		t.Fatalf("reply answered %d %q, want 404 naming the message", rec.Code, rec.Body.String())
	}
}

func TestChatDoesNotTouchTheRound(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello world.\n")
	t.Cleanup(func() { _ = s.Close() })
	h := s.Handler()

	if rec := post(t, h, "/_galley/instruct", map[string]any{
		"op": "comment_document", "text": "Shorter.", "author": "user",
	}); rec.Code != http.StatusOK {
		t.Fatalf("instruction: %d %s", rec.Code, rec.Body.String())
	}
	reply := blockedWait(h, "", time.Hour)
	waitersRegistered(t, s, 1)
	press(t, s, `{"approveOnAnswer":true}`)
	if got := <-reply; got.Reason != waitRevise {
		t.Fatalf("wake = %+v, want revise", got)
	}
	snapshot := func() string {
		s.reviseMu.Lock()
		defer s.reviseMu.Unlock()
		b, _ := json.Marshal(map[string]any{
			"state": s.msg.state, "line": s.msg.line, "token": s.msg.token,
			"approve": s.approveOnAnswer, "watch": s.watch, "lease": s.handoffLease,
		})
		return string(b)
	}
	before := snapshot()

	id := chatSend(t, h, "While you work: why?")
	if got, err := s.waitOnce(context.Background(), "", time.Second); err != nil || got.Reason != waitChat {
		t.Fatalf("wait = %+v, %v; want chat", got, err)
	}
	if rec := post(t, h, "/_galley/chat/reply", map[string]any{"message": id, "state": "answered", "text": "Because."}); rec.Code != http.StatusNoContent {
		t.Fatalf("reply answered %d: %s", rec.Code, rec.Body.String())
	}
	if after := snapshot(); after != before {
		t.Fatalf("the round moved:\nbefore %s\nafter  %s", before, after)
	}
}

func TestChatIsReadOnlyOnceSealed(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello.\n")
	t.Cleanup(func() { _ = s.Close() })
	h := s.Handler()

	id := chatSend(t, h, "Before the end.")
	press(t, s, `{"verdict":"approve"}`)
	if rec := post(t, h, "/_galley/chat", map[string]any{"text": "After."}); rec.Code != http.StatusConflict {
		t.Fatalf("chat after approve answered %d: %s", rec.Code, rec.Body.String())
	}
	chatMessage(t, chatRead(t, h), id)
}

// A Revise pressed at the moment a read delivers a chat message must not be
// lost: both wakes arrive, the Revise first and the chat on the next read. The
// hook presses Revise while the reader is still registered, which is when a
// press is told 204 and its event goes into the reader's buffer.
func TestAChatWakeNeverDropsARevise(t *testing.T) {
	for _, tc := range []struct {
		name    string
		blocked bool
	}{{"queued before the read", false}, {"posted while the read blocks", true}} {
		t.Run(tc.name, func(t *testing.T) {
			s := newEditServer(t, t.TempDir(), "doc.md", "# Title\n\nHello world.\n")
			t.Cleanup(func() { _ = s.Close() })
			h := s.Handler()
			commentAs(t, s, "world", "Say galley.")
			var once sync.Once
			s.testChatTake = func() { once.Do(func() { press(t, s, "{}") }) }

			first := make(chan waitReply, 1)
			if tc.blocked {
				go func() {
					r, _ := s.waitOnce(context.Background(), "", 5*time.Second)
					first <- r
				}()
				waitersRegistered(t, s, 1)
				chatSend(t, h, "A question.")
			} else {
				chatSend(t, h, "A question.")
				r, _ := s.waitOnce(context.Background(), "", 5*time.Second)
				first <- r
			}
			got := []string{(<-first).Reason}
			r, err := s.waitOnce(context.Background(), "", time.Second)
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, r.Reason)
			if got[0] != waitRevise || got[1] != waitChat {
				t.Fatalf("reads = %v, want [revise chat]: a wake was dropped", got)
			}
		})
	}
}
