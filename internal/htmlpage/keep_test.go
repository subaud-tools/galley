package htmlpage

import (
	"bytes"
	"strings"
	"testing"
)

const keepPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
</head>
<body>
<main class="wrap">
  <p class="lead">The <span class="mstr">sift</span> wordmark leads.</p>
  <p>Plain one.</p>
  <p><a class="btn" href="/a">Install</a> &amp; more.</p>
</main>
<aside class="tg"><p>Alone.</p></aside>
</body>
</html>
`

// TestKeepSplicesOnlyWhatChanged pours edited markdown back through Render
// and checks the written page is the original with only the edit in it.
func TestKeepSplicesOnlyWhatChanged(t *testing.T) {
	ex, err := Extract([]byte(keepPage))
	if err != nil {
		t.Fatal(err)
	}
	md := string(ex.Markdown)
	for _, tc := range []struct {
		name     string
		old, now string // markdown edit
		want     string // the page Keep must return; "" means Render's own
	}{
		{"unchanged", "", "", keepPage},
		{"one block changed", "Plain one.", "Plain two.",
			strings.Replace(keepPage, "Plain one.", "Plain two.", 1)},
		{"a block added", "Plain one.", "Plain one.\n\nAdded.",
			strings.Replace(keepPage, "<p>Plain one.</p>", "<p>Plain one.</p>\n  <p>Added.</p>", 1)},
		{"a block removed", "Plain one.\n\n", "",
			strings.Replace(keepPage, "  <p>Plain one.</p>\n", "", 1)},
		{"a lone block gains a neighbour", "Alone.", "Alone.\n\nNext.",
			strings.Replace(keepPage, "<p>Alone.</p>", "<p>Alone.</p><p>Next.</p>", 1)},
		// Emptying a slot prunes its container: the shell changed, so the
		// page is Render's.
		{"a slot emptied", "Alone.", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			edited := md
			if tc.old != "" {
				if !strings.Contains(md, tc.old) {
					t.Fatalf("markdown has no %q:\n%s", tc.old, md)
				}
				edited = strings.Replace(md, tc.old, tc.now, 1)
			}
			rendered, err := Render(ex.Template, []byte(edited))
			if err != nil {
				t.Fatal(err)
			}
			want := tc.want
			if want == "" {
				want = string(rendered)
			}
			got := Keep([]byte(keepPage), rendered)
			if string(got) != want {
				t.Errorf("Keep:\n--- got\n%s\n--- want\n%s", got, want)
			}
		})
	}
}

// TestKeepFallsBackWhenABlockCannotBePlaced: a <p> closed by the next block's
// start, not by </p>, has no bytes of its own to keep, so the page is Render's.
func TestKeepFallsBackWhenABlockCannotBePlaced(t *testing.T) {
	page := "<!doctype html><html><head></head><body><p>One.<p>Two.</p></body></html>"
	ex, err := Extract([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	rendered, err := Render(ex.Template, bytes.Replace(ex.Markdown, []byte("Two."), []byte("Three."), 1))
	if err != nil {
		t.Fatal(err)
	}
	if got := Keep([]byte(page), rendered); !bytes.Equal(got, rendered) {
		t.Errorf("Keep = %q, want Render's page %q", got, rendered)
	}
}
