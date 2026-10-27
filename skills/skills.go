// Package skills embeds the agent skill galley ships, so a binary installs
// and refreshes the skill it was built with (galley skills install, galley
// channel). Every harness, Claude Code included, reads the copy the binary
// writes: the plugin in subaud-tools/plugins carries no skill.
package skills

import "embed"

// Name is the skill's name: its front matter's name: and its directory.
const Name = "reviewing-a-document"

// FS holds the skill as <Name>/SKILL.md.
//
//go:embed reviewing-a-document/SKILL.md
var FS embed.FS

// Body is the skill's SKILL.md.
func Body() ([]byte, error) { return FS.ReadFile(Name + "/SKILL.md") }
