package serve

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	tools "github.com/subaud-tools/tools-common"
)

// TokenPath keeps serve's token across restarts (0600), so a tab opened
// before a restart keeps working after it. The entry goes on stop; this
// file stays.
func TokenPath() string { return filepath.Join(StateDir(), "token") }

// keptToken returns the token in TokenPath, making one the first time (or
// when the file holds anything but 64 hex characters). pageserve takes the
// token before it takes serve.lock, so of serves started at once on a new
// machine the first to write the file sets the token every one of them uses.
func keptToken() (string, error) {
	if t, ok := readToken(); ok {
		return t, nil
	}
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return "", err
	}
	t := hex.EncodeToString(tok)
	tmp := TokenPath() + "." + hex.EncodeToString(tok[:4]) + ".new"
	if err := os.WriteFile(tmp, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(tmp) }()
	// A link fails when the file is there: another serve wrote it first.
	if err := os.Link(tmp, TokenPath()); err == nil {
		return t, nil
	}
	if t, ok := readToken(); ok {
		return t, nil
	}
	// The file there is not a token: replace it.
	if err := tools.WriteFileAtomic(TokenPath(), []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}

// readToken is the token in TokenPath, when it holds one.
func readToken() (string, bool) {
	b, err := os.ReadFile(TokenPath())
	if err != nil {
		return "", false
	}
	t := strings.TrimSpace(string(b))
	if d, err := hex.DecodeString(t); err == nil && len(d) == 32 {
		return t, true
	}
	return "", false
}
