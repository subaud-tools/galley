package serve

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reearth/ygo/crdt"
	"github.com/subaud-tools/galley/internal/docmodel"
	"github.com/subaud-tools/galley/internal/markdown"
	"github.com/subaud-tools/galley/internal/review"
	"github.com/subaud-tools/galley/internal/versions"
	"github.com/subaud-tools/galley/internal/ydoc"
)

func editServerWith(t *testing.T, body string) *EditServer {
	t.Helper()
	dir := t.TempDir()
	md := filepath.Join(dir, "d.md")
	if err := os.WriteFile(md, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewEdit(md)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// dropBlock deletes the block whose text is `said`, the way a reviewer
// selecting a paragraph and pressing Backspace does — through the live
// document, not through the file.
func dropBlock(t *testing.T, s *EditServer, said string) {
	t.Helper()
	if _, err := s.mutate(byReviewer, func(model docmodel.Doc) (docmodel.Doc, func(*crdt.Doc, review.Tx), error) {
		out := docmodel.Doc{}
		for _, b := range model.Blocks {
			var text string
			for _, in := range b.Inlines {
				text += in.Text
			}
			if text == said {
				continue
			}
			out.Blocks = append(out.Blocks, b)
		}
		return out, nil, nil
	}); err != nil {
		t.Fatal(err)
	}
}

// TestTheRailCarriesTheReviewersOwnEdits is the whole point: the rail is the
// list of what this round carries, and an edit is half of that. It showed
// instructions only, so the reviewer could not see the half of their own round
// that the agent is told about.
func TestTheRailCarriesTheReviewersOwnEdits(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n")
	dropBlock(t, s, "Beta two here.")

	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Changes) == 0 {
		t.Fatal("the reviewer deleted a paragraph and the pending view reports no changes at all")
	}
	var removed []string
	for _, c := range view.Changes {
		if c.Kind == "removed" {
			removed = append(removed, c.Before)
		}
	}
	if len(removed) != 1 || removed[0] != "Beta two here." {
		t.Errorf("want one removal naming the deleted paragraph, got %+v", view.Changes)
	}
}

// TestAnUntouchedDocumentReportsNoChanges — the list is what THIS round
// carries, so a document nobody has edited since the last round has an empty
// one. Without this, every poll would report the whole document as changed the
// moment the diff was pointed at the wrong baseline.
func TestAnUntouchedDocumentReportsNoChanges(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n")
	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Changes) != 0 {
		t.Errorf("an untouched document reports %d changes: %+v", len(view.Changes), view.Changes)
	}
}

// TestTheAgentsWorkIsNeverReportedAsTheReviewersHand is the guard, and it is
// the same attribution inversion ReviewerChanges filters ReasonRevise to avoid,
// arriving through the other door.
//
// While a handoff window is open the file belongs to the agent, its saves
// stream into the live document, and the browser is read-only — so a diff
// against the last version describes the AGENT's in-progress work. Reporting it
// in the reviewer's own list would tell them they had made edits they never
// made, and offer to revert them.
func TestTheAgentsWorkIsNeverReportedAsTheReviewersHand(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n")
	dropBlock(t, s, "Beta two here.")
	if view, err := s.pending(); err != nil || len(view.Changes) == 0 {
		t.Fatalf("the fixture produced no change to hide: %v %+v", err, view.Changes)
	}

	s.handoffLive.Store(true)
	defer s.handoffLive.Store(false)
	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Changes) != 0 {
		t.Errorf("mid-handoff the rail reported %d change(s) as the reviewer's: %+v — those are the agent's saves",
			len(view.Changes), view.Changes)
	}
}

// TestRevertingAnEditThroughTheEndpoint is the whole verb, end to end: the
// reviewer deletes a paragraph, the rail offers it back, and pressing revert
// restores it without touching anything else.
func TestRevertingAnEditThroughTheEndpoint(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	dropBlock(t, s, "Beta two here.")

	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	var key string
	for _, c := range view.Changes {
		if c.Kind == "removed" && c.Before == "Beta two here." {
			key = c.Key
		}
	}
	if key == "" {
		t.Fatalf("the removal is not addressable: %+v", view.Changes)
	}

	if rec := postRec(t, s, "/_galley/revert", map[string]any{"key": key}); rec.Code >= 300 {
		t.Fatalf("revert: %d %s", rec.Code, rec.Body.String())
	}
	model, err := s.readLive()
	if err != nil {
		t.Fatal(err)
	}
	got := string(markdown.Serialize(model))
	if !strings.Contains(got, "Beta two here.") {
		t.Errorf("the reverted paragraph did not come back:\n%s", got)
	}
	if !strings.Contains(got, "Gamma three here.") {
		t.Errorf("reverting took something else with it:\n%s", got)
	}
	after, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Changes) != 0 {
		t.Errorf("the reverted edit is still listed as pending: %+v", after.Changes)
	}
}

// TestAStaleCardIsRefusedRatherThanGuessed. The browser sends a key and nothing
// else, and the server recomputes — so a card left open while the document
// moved cannot revert text the server never computed.
func TestAStaleCardIsRefused(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n")
	dropBlock(t, s, "Beta two here.")
	rec := postRec(t, s, "/_galley/revert", map[string]any{"key": "ch-deadbeefdeadbeef"})
	if rec.Code != http.StatusNotFound {
		t.Errorf("a key the server does not recognise got %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

// TestAnInstructionIsNotAnEdit is the bug the undo gate found by being made to
// prove its own precondition.
//
// Filing an instruction writes a `{==…==}` highlight, with its
// `{>>@comment …<<}` ID mark, into the document, so a
// diff of the last version against the live model reported the highlight as
// something the reviewer had CHANGED — and the rail listed it as an edit,
// directly beneath the instruction card it is. One thing, twice, on the one
// surface that exists so there is only one list. It was also offered a revert,
// which would have "put back" prose that never moved by deleting the anchor of
// an instruction just written.
func TestAnInstructionIsNotAnEdit(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n")
	if rec := postRec(t, s, "/_galley/instruct", map[string]any{
		"op": "comment", "target": "Beta two here.", "text": "tighten this",
	}); rec.Code >= 300 {
		t.Fatalf("instruct: %d %s", rec.Code, rec.Body.String())
	}
	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Instructions) != 1 {
		t.Fatalf("the fixture filed %d instructions", len(view.Instructions))
	}
	if len(view.Changes) != 0 {
		t.Errorf("filing an instruction was reported as %d hand edit(s): %+v — "+
			"that is the instruction's own highlight, listed twice on one surface",
			len(view.Changes), view.Changes)
	}
}

// TestAnEditBesideAnInstructionIsStillReported — the fix must not silence real
// edits made in the same round as an instruction, which is the obvious way to
// over-correct it.
func TestAnEditBesideAnInstructionIsStillReported(t *testing.T) {
	s := editServerWith(t, "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	if rec := postRec(t, s, "/_galley/instruct", map[string]any{
		"op": "comment", "target": "Beta two here.", "text": "tighten this",
	}); rec.Code >= 300 {
		t.Fatalf("instruct: %d %s", rec.Code, rec.Body.String())
	}
	dropBlock(t, s, "Gamma three here.")

	view, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	var removed int
	for _, c := range view.Changes {
		if c.Kind == "removed" && c.Before == "Gamma three here." {
			removed++
		}
	}
	if removed != 1 {
		t.Errorf("a real deletion alongside an instruction was not reported: %+v", view.Changes)
	}
	if len(view.Changes) != 1 {
		t.Errorf("want exactly the one real edit, got %+v", view.Changes)
	}
}

// A HELD EDIT CAN BE REVERTED FROM THE RAIL (DCSN2). The reviewer deletes a
// block, then the file changes outside the editor: the deletion is held and
// stays on the rail, so its card must still revert it. The revert reads the
// same span the rail does, and the rail then shows the reviewer's net hand,
// which is nothing.
func TestAHeldEditIsRevertedFromTheRail(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "h.md", "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	dropBlock(t, s, "Beta two here.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	writeFile(t, s.MdPath, "# T\n\nAlpha one here.\n\nGamma three here.\n\nA section written outside.\n")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	var key string
	for _, c := range getPending(t, s).Changes {
		if c.Kind == "removed" && c.Before == "Beta two here." {
			key = c.Key
		}
	}
	if key == "" {
		t.Fatalf("the held deletion is not on the rail: %+v", getPending(t, s).Changes)
	}
	if rec := postRec(t, s, "/_galley/revert", map[string]any{"key": key}); rec.Code >= 300 {
		t.Fatalf("revert: %d %s", rec.Code, rec.Body.String())
	}
	got := liveText(t, s)
	if !strings.Contains(got, "Beta two here.") {
		t.Errorf("the held deletion did not come back:\n%s", got)
	}
	if !strings.Contains(got, "A section written outside.") {
		t.Errorf("the revert took the outside section with it:\n%s", got)
	}
	if after := getPending(t, s).Changes; len(after) != 0 {
		t.Errorf("after the revert the rail lists %+v, want nothing: the reviewer's net hand is none", after)
	}
	if sent := sendAndHandOver(t, s); len(sent) != 0 {
		t.Errorf("the next Revise hands over %+v for an edit the reviewer reverted, want nothing", sent)
	}
}

// sendAndHandOver cuts a Revise and returns the changes handed to the agent.
func sendAndHandOver(t *testing.T, s *EditServer) []ReviewerChange {
	t.Helper()
	s.requestCut(versions.ReasonRevise, "", 0)
	_, view, err := s.waitFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	return view.Changes
}

// reviewerTypesLast is reviewerTypes on the last block holding old only.
func reviewerTypesLast(t *testing.T, s *EditServer, old, repl string) {
	t.Helper()
	before, err := s.readLive()
	if err != nil {
		t.Fatal(err)
	}
	after := docmodel.Clone(before)
	for i := len(after.Blocks) - 1; i >= 0; i-- {
		for j, in := range after.Blocks[i].Inlines {
			if strings.Contains(in.Text, old) {
				after.Blocks[i].Inlines[j].Text = strings.Replace(in.Text, old, repl, 1)
				if err := s.yjs.Apply(t.Context(), s.Room, func(doc *crdt.Doc, transact func(func(*crdt.Transaction))) {
					ydoc.Write(doc, transact, before, after)
				}); err != nil {
					t.Fatal(err)
				}
				return
			}
		}
	}
	t.Fatalf("the live document has no %q", old)
}

// heldThenOutside projects the reviewer's edits so far, then loads an outside
// section over them, so they are held.
func heldThenOutside(t *testing.T, s *EditServer, file string) {
	t.Helper()
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	writeFile(t, s.MdPath, file)
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(liveText(t, s), "A section written outside.") {
		t.Fatal("the outside section was not loaded")
	}
}

// TWO REAL EDITS THAT HAPPEN TO MIRROR EACH OTHER ARE BOTH KEPT (DCSN3). Only a
// Revert cancels; matching words hid both of these.
func TestMirroredEditsAcrossAHoldAreBothKept(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "m.md", "# A\n\nStatus is pending.\n\n# B\n\nStatus is approved.\n")
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	reviewerTypes(t, s, "Status is pending.", "Status is approved.")
	heldThenOutside(t, s, "# A\n\nStatus is approved.\n\n# B\n\nStatus is approved.\n\nA section written outside.\n")
	reviewerTypesLast(t, s, "Status is approved.", "Status is pending.")

	if got := getPending(t, s).Changes; len(got) != 2 {
		t.Errorf("the rail lists %+v, want both of the reviewer's edits", got)
	}
	if sent := sendAndHandOver(t, s); len(sent) != 2 {
		t.Errorf("the Revise hands over %+v, want both of the reviewer's edits", sent)
	}
}

// A HELD DELETION RETYPED BY HAND IS NOT A REVERT: both edits stay listed.
func TestAHeldDeletionRetypedByHandListsBoth(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "r.md", "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	dropBlock(t, s, "Beta two here.")
	heldThenOutside(t, s, "# T\n\nAlpha one here.\n\nGamma three here.\n\nA section written outside.\n")
	reviewerTypes(t, s, "Alpha one here.", "Alpha one here.\n\nBeta two here.")

	got := getPending(t, s).Changes
	var removed, added int
	for _, c := range got {
		if c.Kind == "removed" && c.Before == "Beta two here." {
			removed++
		}
		if c.Kind == "added" && c.After == "Beta two here." {
			added++
		}
	}
	if removed != 1 || added != 1 {
		t.Errorf("the rail lists %+v, want the held removal and the retyped addition", got)
	}
}

// dropLastBlock deletes only the last block whose text is said.
func dropLastBlock(t *testing.T, s *EditServer, said string) {
	t.Helper()
	if _, err := s.mutate(byReviewer, func(model docmodel.Doc) (docmodel.Doc, func(*crdt.Doc, review.Tx), error) {
		for i := len(model.Blocks) - 1; i >= 0; i-- {
			var text string
			for _, in := range model.Blocks[i].Inlines {
				text += in.Text
			}
			if text == said {
				out := docmodel.Doc{Blocks: append(append([]docmodel.Block{}, model.Blocks[:i]...), model.Blocks[i+1:]...)}
				return out, nil, nil
			}
		}
		return docmodel.Doc{}, nil, errors.New("no such block")
	}); err != nil {
		t.Fatal(err)
	}
}

// revertHeld deletes Beta, holds it under an outside section, and reverts it
// from the rail, projecting after each step as the editor's settle does.
func revertHeld(t *testing.T, s *EditServer) {
	t.Helper()
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	dropBlock(t, s, "Beta two here.")
	heldThenOutside(t, s, "# T\n\nAlpha one here.\n\nGamma three here.\n\nA section written outside.\n")
	var key string
	for _, c := range getPending(t, s).Changes {
		if c.Kind == "removed" && c.Before == "Beta two here." {
			key = c.Key
		}
	}
	if rec := postRec(t, s, "/_galley/revert", map[string]any{"key": key}); rec.Code >= 300 {
		t.Fatalf("revert: %d %s", rec.Code, rec.Body.String())
	}
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if got := getPending(t, s).Changes; len(got) != 0 {
		t.Fatalf("the fixture's revert left %+v on the rail", got)
	}
}

// A REVERT'S RECORD DIES WITH EITHER OF ITS EDITS (DCSN4). Deleting the
// restored paragraph undoes the revert; typing it again afterwards is a new
// edit, listed beside the held deletion rather than cancelled by it.
func TestARevertUndoneByHandEndsItsRecord(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "u.md", "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	t.Cleanup(func() { _ = s.Close() })
	revertHeld(t, s)
	dropBlock(t, s, "Beta two here.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	reviewerTypes(t, s, "Alpha one here.", "Alpha one here.\n\nBeta two here.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	var removed, added int
	for _, c := range getPending(t, s).Changes {
		if c.Kind == "removed" && c.Before == "Beta two here." {
			removed++
		}
		if c.Kind == "added" && c.After == "Beta two here." {
			added++
		}
	}
	if removed != 1 || added != 1 {
		t.Errorf("the rail lists %+v, want the held removal and the retyped addition", getPending(t, s).Changes)
	}
}

// A REVERT HELD UNDER A SECOND OUTSIDE SAVE STAYS CANCELLED (DCSN4). The
// inverse is frozen into a held segment of its own, not the live one.
func TestARevertHeldAgainStaysCancelled(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "a.md", "# T\n\nAlpha one here.\n\nBeta two here.\n\nGamma three here.\n")
	t.Cleanup(func() { _ = s.Close() })
	revertHeld(t, s)
	writeFile(t, s.MdPath, string(mustRead(t, s.MdPath))+"\nAnother section outside.\n")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(liveText(t, s), "Another section outside.") {
		t.Fatal("the second outside save was not loaded")
	}
	if rs := rounds(t, s); rs[len(rs)-2].Reason != versions.ReasonHeld {
		t.Fatalf("the second outside save did not hold the revert: %+v", rs)
	}
	if got := getPending(t, s).Changes; len(got) != 0 {
		t.Errorf("the rail lists %+v, want nothing", got)
	}
	if sent := sendAndHandOver(t, s); len(sent) != 0 {
		t.Errorf("the Revise hands over %+v, want nothing", sent)
	}
}

// A RECORD NAMES ONE OCCURRENCE, NOT ITS WORDS (DCSN4). The outside save
// brings a second copy of the held paragraph; the reviewer reverts the held
// deletion, then deletes the outside copy by hand, and that deletion is listed.
func TestAHandDeletionOfTheSameWordsStaysListed(t *testing.T) {
	s := newEditServer(t, t.TempDir(), "d.md", "# T\n\nAlpha one here.\n\nSame words here.\n\nGamma three here.\n")
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	dropBlock(t, s, "Same words here.")
	heldThenOutside(t, s, "# T\n\nAlpha one here.\n\nGamma three here.\n\nA section written outside.\n\nSame words here.\n")
	var key string
	for _, c := range getPending(t, s).Changes {
		if c.Kind == "removed" && c.Before == "Same words here." {
			key = c.Key
		}
	}
	if rec := postRec(t, s, "/_galley/revert", map[string]any{"key": key}); rec.Code >= 300 {
		t.Fatalf("revert: %d %s", rec.Code, rec.Body.String())
	}
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	dropLastBlock(t, s, "Same words here.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	got := getPending(t, s).Changes
	if len(got) != 1 || got[0].Kind != "removed" || got[0].Before != "Same words here." {
		t.Errorf("the rail lists %+v, want the one hand deletion", got)
	}
	if sent := sendAndHandOver(t, s); len(sent) != 1 || sent[0].Kind != "removed" {
		t.Errorf("the Revise hands over %+v, want the one hand deletion", sent)
	}
}
