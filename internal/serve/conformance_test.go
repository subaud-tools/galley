package serve

import (
	"testing"

	"github.com/subaud-tools/tools-common/pageserve/conformance"
)

// galley's serve keeps every server rule in PAGE-STANDARD.md, tested from
// outside against the real binary. Channel is off only because that rule looks
// for a skill named after the tool, and galley's is reviewing-a-document:
// internal/cli/pluginskill_test.go tests that it installs.
func TestServerConforms(t *testing.T) {
	conformance.Check(t, conformance.Server{
		Tool: "galley", Binary: conformance.Build(t, "../../cmd/galley"),
		Args: []string{"serve"},
	})
}
