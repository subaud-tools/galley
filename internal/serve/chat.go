// chat.go is the review's Chat: a conversation with the agent that never
// changes the document. A message is a msgstate.Message appended to chat.jsonl
// in the review's versions folder, so the thread survives reloads and restarts
// and reads on an approved review.
//
// IT IS DELIVERED THROUGH THE WAIT, NOT BESIDE IT. waitOnce answers with the
// oldest message still sent before it blocks, and moves it to with_agent, so a
// message posted while no reader is attached (or between two reads) is
// delivered on the next read rather than dropped. A reader already blocked
// hears the store's bell: a channel closed and replaced on each post. Not the
// waiters' event slot: that slot holds one release and a send into a full one is
// dropped, so a chat nudge sitting in it would cost the Revise that arrived
// next.
//
// The agent answers with galley_reply (POST /_galley/chat/reply), which settles
// the message's state and appends its words as the agent's message. Nothing
// here touches the round: its message, its window and approveOnAnswer are
// reviseMu's, and chat takes only its own lock.
package serve

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/subaud-tools/galley/internal/render"
	"github.com/subaud-tools/galley/internal/review"
	"github.com/subaud-tools/tools-common/msgstate"
)

// chatThread is every chat message's Thread: a review has one conversation.
const chatThread = "chat"

// ChatWake is the message a chat wake carries to the agent.
type ChatWake struct {
	ID   int64  `json:"id"`
	Text string `json:"text"`
}

// chatMessageView is one message as the page draws it. HTML is the agent's
// text rendered by the server, and only the agent's: the reviewer's words stay
// plain, as diazo's threads draw them.
type chatMessageView struct {
	ID      int64          `json:"id"`
	From    string         `json:"from"`
	At      time.Time      `json:"at"`
	Text    string         `json:"text"`
	HTML    string         `json:"html,omitempty"`
	State   msgstate.State `json:"state,omitempty"`
	Line    string         `json:"line,omitempty"`
	ReplyTo int64          `json:"replyTo,omitempty"`
}

// chatView is GET /_galley/chat's answer, oldest first.
type chatView struct {
	Messages []chatMessageView `json:"messages"`
}

// chatStore is chat.jsonl: append-only, one msgstate.Message a line. A state
// change appends the message again, and reading keeps the last line per id.
type chatStore struct {
	mu     sync.Mutex
	path   string
	loaded bool
	msgs   []msgstate.Message // the last line of each id, in id order
	bellCh chan struct{}
}

// chatLog is this review's store, opened on first use.
func (s *EditServer) chatLog() *chatStore {
	s.chatOnce.Do(func() {
		s.chat = &chatStore{path: filepath.Join(s.Versions().Dir(), "chat.jsonl"), bellCh: make(chan struct{})}
	})
	return s.chat
}

// loadLocked reads the file once. A line it cannot read is skipped: one bad
// line must not cost the conversation. c.mu is held.
func (c *chatStore) loadLocked() error {
	if c.loaded {
		return nil
	}
	raw, err := os.ReadFile(c.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	at := map[int64]int{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var m msgstate.Message
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.ID <= 0 {
			continue
		}
		if i, ok := at[m.ID]; ok {
			c.msgs[i] = m
			continue
		}
		at[m.ID] = len(c.msgs)
		c.msgs = append(c.msgs, m)
	}
	c.loaded = true
	return nil
}

// appendLocked writes m as a line and then keeps it: a line that could not be
// written changes nothing. c.mu is held.
func (c *chatStore) appendLocked(m msgstate.Message) error {
	line, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(c.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	for i := range c.msgs {
		if c.msgs[i].ID == m.ID {
			c.msgs[i] = m
			return nil
		}
	}
	c.msgs = append(c.msgs, m)
	return nil
}

func (c *chatStore) nextIDLocked() int64 {
	var n int64
	for _, m := range c.msgs {
		n = max(n, m.ID)
	}
	return n + 1
}

// bell is what a blocked reader listens on for a new message: closed on the
// next post. Take it before claiming, so a post between the two still rings.
func (c *chatStore) bell() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bellCh
}

// send records the reviewer's message as sent and rings the bell.
func (c *chatStore) send(text string) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.loadLocked(); err != nil {
		return 0, err
	}
	m := msgstate.Message{
		ID: c.nextIDLocked(), Thread: chatThread, Who: review.AuthorUser, Text: text,
		When: time.Now().UTC(), State: msgstate.Sent,
	}
	if err := c.appendLocked(m); err != nil {
		return 0, err
	}
	close(c.bellCh)
	c.bellCh = make(chan struct{})
	return m.ID, nil
}

// claim takes the oldest message still sent and moves it to with_agent: the
// one read that delivers it. ok is false when there is none.
func (c *chatStore) claim() (*ChatWake, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.loadLocked(); err != nil {
		return nil, false, err
	}
	for _, m := range c.msgs {
		if m.Who != review.AuthorUser || m.State != msgstate.Sent {
			continue
		}
		m.State = msgstate.WithAgent
		if err := c.appendLocked(m); err != nil {
			return nil, false, err
		}
		return &ChatWake{ID: m.ID, Text: m.Text}, true, nil
	}
	return nil, false, nil
}

// errNoChatMessage is a reply naming a message this review does not have.
var errNoChatMessage = errors.New("no such message")

// reply is the agent's answer to message id: working sets its line; answered,
// declined and failed settle it and append the agent's words after it.
func (c *chatStore) reply(id int64, to msgstate.State, text string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.loadLocked(); err != nil {
		return err
	}
	var asked *msgstate.Message
	for i := range c.msgs {
		if c.msgs[i].ID == id && c.msgs[i].Who == review.AuthorUser {
			m := c.msgs[i]
			asked = &m
			break
		}
	}
	if asked == nil {
		return fmt.Errorf("%w: no message %d in this review", errNoChatMessage, id)
	}
	if !msgstate.Acknowledge(asked.State, to) {
		return fmt.Errorf("message %d is %s and cannot become %s", id, asked.State.Label(), to.Label())
	}
	asked.State, asked.Line = to, ""
	if to == msgstate.Working {
		asked.Line = text
	}
	if err := c.appendLocked(*asked); err != nil {
		return err
	}
	if to == msgstate.Working || text == "" {
		return nil
	}
	return c.appendLocked(msgstate.Message{
		ID: c.nextIDLocked(), Thread: chatThread, Who: "agent", Text: text,
		When: time.Now().UTC(), ReplyTo: id,
	})
}

// view is the thread as the page draws it.
func (c *chatStore) view() (chatView, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.loadLocked(); err != nil {
		return chatView{}, err
	}
	out := chatView{Messages: make([]chatMessageView, 0, len(c.msgs))}
	for _, m := range c.msgs {
		v := chatMessageView{
			ID: m.ID, From: m.Who, At: m.When, Text: m.Text,
			State: m.State, Line: m.Line, ReplyTo: m.ReplyTo,
		}
		if m.Who != review.AuthorUser {
			v.From = "agent"
			if html, err := render.Fragment([]byte(m.Text)); err == nil {
				v.HTML = html
			}
		}
		out.Messages = append(out.Messages, v)
	}
	return out, nil
}

// claimChat is waitOnce's delivery: the oldest sent message, now with the
// agent. A store that cannot be written delivers nothing, and the message stays
// sent for the next read.
func (s *EditServer) claimChat() (*ChatWake, bool) {
	m, ok, err := s.chatLog().claim()
	if err != nil {
		if s.Log != nil {
			s.Log("could not deliver a chat message: " + err.Error())
		}
		return nil, false
	}
	return m, ok
}

// handleChat is GET /_galley/chat (the thread) and POST /_galley/chat {text}
// (the reviewer's message, answered with its id). A sealed review's thread
// still reads; it takes no new message.
func (s *EditServer) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		v, err := s.chatLog().view()
		if err != nil {
			http.Error(w, "the chat could not be read: "+err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, v)
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &in) {
		return
	}
	if s.refuseSealed(w, verbReview) {
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" {
		http.Error(w, "a chat message needs words", http.StatusBadRequest)
		return
	}
	id, err := s.chatLog().send(text)
	if err != nil {
		http.Error(w, "the message was not kept: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]int64{"id": id})
}

// handleChatReply is POST /_galley/chat/reply {message, state, text}: the
// agent's galley_reply.
func (s *EditServer) handleChatReply(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Message int64  `json:"message"`
		State   string `json:"state"`
		Text    string `json:"text"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !ackStates[in.State] {
		http.Error(w, fmt.Sprintf("state must be working, answered, declined or failed; got %q", in.State), http.StatusBadRequest)
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" && in.State != string(msgstate.Working) {
		http.Error(w, "a reply needs text: what the reviewer reads under their message", http.StatusBadRequest)
		return
	}
	err := s.chatLog().reply(in.Message, msgstate.State(in.State), text)
	switch {
	case errors.Is(err, errNoChatMessage):
		http.Error(w, fmt.Sprintf("no message %d in this review", in.Message), http.StatusNotFound)
	case err != nil:
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
