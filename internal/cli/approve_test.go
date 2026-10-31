package cli

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subaud-tools/galley/internal/serve"
)

// galley_approve IS THE PAGE'S APPROVE BUTTON, CALLED FROM THE CONVERSATION.
// It must leave the editor exactly where a press leaves it: sealed. A second
// call meets the seal like a second press would, and says so.
func TestGalleyApproveSealsTheReview(t *testing.T) {
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# Title\n\nThe budget should stay explicit.\n")
	base := openOnServer(t, doc, serve.DocOptions{}).URL

	ch := sessionChannel("", dir)
	args, _ := json.Marshal(map[string]any{"doc": doc})
	if _, err := callTool(context.Background(), ch, "galley_approve", args); err != nil {
		t.Fatalf("galley_approve: %v", err)
	}
	if st, err := reviseState(base); err != nil || !st.Sealed {
		t.Fatalf("galley_approve returned without sealing the review: %+v, %v", st, err)
	}
	if _, err := callTool(context.Background(), ch, "galley_approve", args); err == nil || !strings.Contains(err.Error(), "sealed") {
		t.Errorf("a second approve was not refused as sealed: %v", err)
	}
}

func TestGalleyApproveWithNoEditorIsAnError(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	args, _ := json.Marshal(map[string]any{"doc": filepath.Join(dir, "nobody.md")})
	if _, err := callTool(context.Background(), sessionChannel("", dir), "galley_approve", args); err == nil ||
		!strings.Contains(err.Error(), "no running editor") {
		t.Errorf("approve with no editor did not say so: %v", err)
	}
}
