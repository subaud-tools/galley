package cli

import (
	_ "embed"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/subaud-tools/galley/internal/version"
	"github.com/subaud-tools/galley/skills"
	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/setupbundle"
	commonskills "github.com/subaud-tools/tools-common/skills"
)

//go:embed setup.toml
var setupManifest string

// setupCommand publishes only the embedded skill and selected registrations.
// Harness destinations come from the same contract as direct skill installation.
func setupCommand() tools.Command {
	var manifest strings.Builder
	manifest.WriteString(setupManifest)
	targets := commonskills.UserTargets()
	for _, agent := range slices.Sorted(maps.Keys(targets)) {
		_, _ = fmt.Fprintf(&manifest, "\n[[packages.integration.managed-file]]\nfrom = %q\nto = %q\nmode = \"0644\"\n", skills.Name+"/SKILL.md", targets[agent]+"/"+skills.Name+"/SKILL.md")
	}
	return setupbundle.BundleCommand("galley", version.Version(), setupbundle.Source{
		Manifest: []byte(manifest.String()),
		Files:    skills.FS,
	})
}
