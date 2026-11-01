package serve

import (
	"testing"

	"github.com/subaud-tools/tools-common/pageserve/conformance"
)

// galley's serve keeps every server rule in PAGE-STANDARD.md, tested from
// outside against the real binary.
func TestServerConforms(t *testing.T) {
	conformance.Check(t, conformance.Server{
		Tool: "galley", Binary: conformance.Build(t, "../../cmd/galley"),
		Args: []string{"serve"}, Channel: true, SkillName: "reviewing-a-document",
	})
}
