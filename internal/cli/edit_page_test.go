package cli

import (
	"strings"
	"testing"
)

// minimalHTML is the smallest page Extract accepts: a doctype, head/title,
// and one prose paragraph in the body.  The exact shape mirrors the fixture in
// internal/htmlpage/extract_test.go so we know Extract will not reject it.
const minimalHTML = `<!doctype html><html><head><title>x</title></head><body>
<p>Hello world, edited in rounds.</p>
</body></html>`

// TestAgentPromptPageBackedContainsLayerWarning asserts the page-backed
// paragraph is appended when the doc lives under .galley/pages/.
func TestAgentPromptPageBackedContainsLayerWarning(t *testing.T) {
	doc := "/x/.galley/pages/index/content.md"
	got := agentPrompt(doc)
	want := "backed by an HTML page"
	if !strings.Contains(got, want) {
		t.Errorf("agentPrompt(%q) missing %q:\n%s", doc, want, got)
	}
}

// TestAgentPromptPlainMDHasNoPageWarning asserts the page paragraph is absent
// for a plain .md file.
func TestAgentPromptPlainMDHasNoPageWarning(t *testing.T) {
	doc := "/x/plan.md"
	got := agentPrompt(doc)
	if strings.Contains(got, "backed by an HTML page") {
		t.Errorf("agentPrompt(%q) should not contain page-backed paragraph:\n%s", doc, got)
	}
}
