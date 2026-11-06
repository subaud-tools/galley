package cli

import (
	"strings"
	"testing"

	"github.com/subaud-tools/galley/internal/serve"
)

// `galley pending` says nothing is pending only when there are neither
// instructions nor edits, and counts and lists the edits otherwise.
func TestPendingListsEditsWithoutInstructions(t *testing.T) {
	got := pendingText("draft.md", "live", pendingPayload{Changes: []serve.ReviewerChange{{Kind: "removed", Before: "A cut sentence."}}})
	for _, want := range []string{"0 instruction(s), 1 direct edit(s)", "Do not undo these", "A cut sentence."} {
		if !strings.Contains(got, want) {
			t.Errorf("the pending view lacks %q:\n%s", want, got)
		}
	}
	if got := pendingText("draft.md", "live", pendingPayload{}); got != "nothing pending on draft.md (live)\n" {
		t.Errorf("an empty pending view reads %q", got)
	}
}
