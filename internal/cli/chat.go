// chat.go is the agent's side of a review's Chat: galley_reply's post. A chat
// message reaches the agent as a `chat` wake (see channel.go and wait.go); its
// answer goes back here, to the document's server, which settles the message
// and shows the words under it. Chat never changes the document.
package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// postReply is galley_reply: the agent's state and words on message id.
func postReply(baseURL string, message int64, state, text string) error {
	raw, err := json.Marshal(struct {
		Message int64  `json:"message"`
		State   string `json:"state"`
		Text    string `json:"text"`
	}{Message: message, State: state, Text: text})
	if err != nil {
		return err
	}
	resp, err := serverClient.Post(baseURL+"/_galley/chat/reply", "application/json", bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("the editor did not answer: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("reply refused: %s", strings.TrimSpace(string(body)))
	}
	return nil
}
