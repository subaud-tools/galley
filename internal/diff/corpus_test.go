package diff

import (
	"os"
	"path/filepath"
	"testing"
)

// corpus_test.go PINS THE SPIKE'S OWN MEASURED CASES, BYTE FOR BYTE.
//
// The full sweep needs somebody else's git history and cannot run in CI, so on
// its own it would leave the numbers this design rests on unguarded on every
// ordinary push. These five pairs are real revisions of this repository's own
// markdown, carried into testdata so `just verify` measures them: four are the
// cases the spike's artifact was built from, and the fifth is the worst
// paragraph in the whole corpus — the 1,486-word CLAUDE.md entry the spec names
// as the case that does not reach one and never will.
//
// THE NUMBERS ARE THE ASSERTION. A port that reads well and counts differently
// is a different algorithm, and only a pinned count can say so.
func TestTheSpikesMeasuredCases(t *testing.T) {
	cases := []struct {
		name            string
		word, reg, runs int
		note            string
	}{
		{"case-rewrite", 14, 7, 8,
			"a 192-word paragraph rewritten by its author — the hard case, where word-level shreds"},
		{"case-oneword", 1, 1, 1,
			"Four became Seven inside a 56-word sentence — where paragraph granularity is uselessly blunt"},
		{"case-deleted", 1, 1, 1,
			"a four-sentence paragraph the user deleted in the editor — coalescing is what makes it one"},
		{"case-move", 29, 17, 18,
			"a sentence that left one paragraph and arrived in another, through a one-word change"},
		{"worst", 26, 7, 9,
			"the worst paragraph in the corpus: a 1,486-word CLAUDE.md entry"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before, after := readCase(t, c.name)
			ops := Diff(before, after)
			if got := WordFragments(before, after); got != c.word {
				t.Errorf("word-level fragments = %d, want %d (%s)", got, c.word, c.note)
			}
			if got := Regions(ops); got != c.reg {
				t.Errorf("sentence-level regions = %d, want %d (%s)", got, c.reg, c.note)
			}
			if got := Runs(ops); got != c.runs {
				t.Errorf("painted runs = %d, want %d (%s)", got, c.runs, c.note)
			}
		})
	}
}

// TestTheMoveCaseIsWhereTheOpenDECISIONLives keeps the one artefact nobody has
// ruled on in front of whoever changes this package: the corpus's real
// relocation, detected, and rendered outside the ins/del vocabulary.
func TestTheRealRelocationIsDetected(t *testing.T) {
	before, after := readCase(t, "case-move")
	ops := Diff(before, after)
	ends := 0
	for _, o := range ops {
		if o.Moved {
			ends++
		}
	}
	if ends == 0 {
		t.Fatal("the corpus's own relocated sentence was not detected")
	}
	if ends%2 != 0 {
		t.Errorf("%d move ends is an odd number, so one of them has no partner", ends)
	}
}

// TestEveryViewRendersEveryCase is the cheap breadth check the pinned counts do
// not give: no view may panic, and none may come back empty, on any real pair.
func TestEveryViewRendersEveryCase(t *testing.T) {
	for _, name := range []string{"case-rewrite", "case-oneword", "case-deleted", "case-move", "worst"} {
		before, after := readCase(t, name)
		for _, v := range Views {
			if got := Render(before, after, v); got == "" {
				t.Errorf("%s rendered %s as nothing", name, v)
			}
		}
	}
}

func readCase(t *testing.T, name string) (string, string) {
	t.Helper()
	read := func(suffix string) string {
		b, err := os.ReadFile(filepath.Join("testdata", name+"."+suffix+".md"))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		return string(b)
	}
	return read("before"), read("after")
}
