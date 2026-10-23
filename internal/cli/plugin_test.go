package cli

import (
	"path/filepath"
	"testing"

	"github.com/subaud-tools/tools-common/claudeplugin"
)

// The galley plugin is rendered by tools-common, not written by hand: its
// manifest, the .mcp.json that runs `galley channel` for the tools, and the
// mod that runs `galley watch` and starts a turn with each event. The skill
// beside them is galley's own and is not rendered. Regenerate with
// CLAUDEPLUGIN_UPDATE=1 go test -run '^TestPluginIsCurrent$' ./internal/cli
func TestPluginIsCurrent(t *testing.T) {
	claudeplugin.AssertCurrent(t, filepath.Join("..", "..", "plugin", "galley"), claudeplugin.Spec{
		Name:        "galley",
		DisplayName: "galley",
		Bin:         "galley",
		ServerName:  "galley",
		Description: "Review documents in the browser; rounds land in the session that wrote them.",
		Author:      "Court Schuett",
		AuthorURL:   "https://galley.tools",
		Homepage:    "https://galley.tools",
		Repository:  "https://github.com/subaud-tools/galley",
		License:     "BUSL-1.1",
		Keywords:    []string{"review", "markdown", "writing", "editing"},
	})
}
