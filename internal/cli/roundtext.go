package cli

import (
	"fmt"
	"strings"
)

// editsOnlyClose ends a round that carries the reviewer's edits and no
// instructions. Such a round asks for nothing, and without this line an agent
// had nothing to answer and the reviewer's round ended declined.
const editsOnlyClose = `This round has no instructions, only the reviewer's direct edits. Keep them. ` +
	`If nothing more is needed, answer with galley_ack state "answered" (` + "`galley ack --state answered`" + ` from a shell) and a one-sentence note.`

// roundEdits is how many direct edits a round carries, the ones the cap left
// out included.
func roundEdits(p pendingPayload) int {
	return len(p.Changes) + p.ChangesDropped
}

// renderRound is THE ONE RENDERING OF A CAPTURED ROUND, and every carrier
// calls it: the channel wake, `galley wait` and `galley pending`. When each
// carrier spelled its own, `galley wait` never listed the reviewer's edits and
// the channel dropped them whenever the round had no instructions.
//
// The headline counts both halves, the edits lead the body (an agent acts in
// order, and "do not undo these" after the asks has already lost), and a round
// of edits alone ends with how to answer it. sent is false for the unsent view
// `galley pending` prints: its headline says pending, and it has nothing to
// answer yet.
func renderRound(page string, p pendingPayload, sent bool) string {
	lead := "Revision requested on"
	if !sent {
		lead = "Pending on"
	}
	edits := roundEdits(p)
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s: %d instruction(s), %d direct edit(s).\n", lead, page, len(p.Instructions), edits)
	body := formatReviewerChanges(p.Changes, p.ChangesDropped) + formatInstructions(p.Instructions)
	if body != "" {
		b.WriteByte('\n')
		b.WriteString(body)
	}
	if sent && edits > 0 && len(p.Instructions) == 0 {
		b.WriteString(editsOnlyClose + "\n")
	}
	return b.String()
}
