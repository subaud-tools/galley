package serve

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// writeBackPage is the shape of tackle.tools' sift page, where galley#49 was
// seen: a head galley re-rendered (doctype, void tags), shell with entities,
// and content blocks holding inline markup galley does not extract — classed
// links, a <span> inside a <p>, <span>s inside a <pre>.
const writeBackPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sift — audits</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>

<div class="statusbar">
  <div class="wrap">
    <a class="sb-brand" href="/"><span class="dot">●</span> <b>tackle</b></a>
    &nbsp; <button class="theme-toggle" id="tt" aria-label="Toggle color theme">theme</button>
  </div>
</div>

<header class="hero" id="top">
  <div class="wrap">
    <p class="eyebrow">sift · audits of the instruction files your agents read</p>
    <h1 class="lede">Keep the files your agents read short and true.</h1>
    <p class="sub">
      <span class="mstr">sift</span> audits the instruction files coding agents read and finds
      what is too big, duplicated, stale, dead or misplaced.
    </p>
    <p><a class="btn btn-primary" href="#install">Install sift →</a> <a class="btn btn-ghost" href="https://github.com/subaud-tools/tackle">Source</a></p>
    <div class="term" role="img" aria-label="An agent session">
      <div class="term-bar"><span class="lamp"></span><span class="title">~ your agent</span></div>
<pre><span class="c-dim">&gt;</span> audit my instruction files

sift found 4 findings in 2 files: <span class="c-sig">http://127.0.0.1:52741/</span>
</pre>
    </div>
  </div>
</header>

<section id="files">
  <div class="wrap">
    <p class="kicker">what it reads</p>
    <p class="lead">An <b>instruction file</b> is a file a coding agent reads, such as
    <code>AGENTS.md</code>.</p>
    <p>This sentence is the one the reviewer edits.</p>
  </div>
</section>

<footer>
  <div class="wrap foot">
    <a href="https://github.com/subaud-tools/tackle">GitHub</a> &nbsp;·&nbsp;
  </div>
</footer>

<script src="../site.js"></script>
</body>
</html>
`

// TestApprovingAnEditedPageChangesOnlyTheEditedText is galley#49: approving a
// page after editing one paragraph rewrote the whole page from what galley
// extracts, dropping every class on a link, every <span>, and the head's own
// spelling. The page must come back byte for byte except the edited sentence.
func TestApprovingAnEditedPageChangesOnlyTheEditedText(t *testing.T) {
	dir := t.TempDir()
	page := writePage(t, dir, "index.html", writeBackPage)
	s, err := NewEditPage(page)
	if err != nil {
		t.Fatalf("NewEditPage: %v", err)
	}
	defer func() { _ = s.Close() }()
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	const before, after = "This sentence is the one the reviewer edits.", "This sentence was edited by the reviewer."
	retext(t, s, before, after)
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if rec := postRec(t, s, "/_galley/revise", map[string]any{"verdict": "approve"}); rec.Code/100 != 2 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	got, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(writeBackPage, before, after, 1)
	if string(got) != want {
		t.Errorf("the approved page changed more than the edited sentence:\n--- got\n%s\n--- want\n%s", got, want)
	}
}

// TestAWriteThatCannotKeepThePageSaysSo: a <p> closed by the next block's
// start has no bytes of its own, so the write falls back to Render's page and
// loses what the page held beyond extraction. That must show in the log.
func TestAWriteThatCannotKeepThePageSaysSo(t *testing.T) {
	dir := t.TempDir()
	page := writePage(t, dir, "index.html", "<!doctype html><html><head></head><body><p>One.<p>Two.</p></body></html>\n")
	s, err := NewEditPage(page)
	if err != nil {
		t.Fatalf("NewEditPage: %v", err)
	}
	defer func() { _ = s.Close() }()
	var mu sync.Mutex
	var lines []string
	s.Log = func(line string) { mu.Lock(); lines = append(lines, line); mu.Unlock() }
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	retext(t, s, "Two.", "Three.")
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	if rec := postRec(t, s, "/_galley/revise", map[string]any{"verdict": "approve"}); rec.Code/100 != 2 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	if err := s.Project(); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if got := string(mustRead(t, page)); !strings.Contains(got, "Three.") {
		t.Fatalf("the edit was not written: %s", got)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, l := range lines {
		if strings.Contains(l, "could not keep the page's own bytes") {
			return
		}
	}
	t.Errorf("no log line said the write fell back to the rendered page; log: %q", lines)
}
