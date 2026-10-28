package render

import (
	"strings"
	"testing"

	"github.com/subaud-tools/tools-common/mermaidkit"
)

// The page itself is mermaidkit's, tested there; what galley adds is what it
// removes before rendering.
func TestRenderDropsInstructions(t *testing.T) {
	out, err := Render([]byte("Keep {==this==}{>>change it<<} text\n"), mermaidkit.BaseTheme(), []byte("/*MERMAID*/"), "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "this") {
		t.Error("anchored text lost")
	}
	for _, bad := range []string{"change it", "{=="} {
		if strings.Contains(string(out), bad) {
			t.Errorf("output contains %q", bad)
		}
	}
}
