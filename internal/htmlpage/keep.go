package htmlpage

import (
	"bytes"
	"reflect"
	"strings"

	"golang.org/x/net/html"
)

// Keep returns the page to write over base, given the page Render made: base's
// own bytes everywhere the two say the same thing, and Render's only for the
// blocks that changed (galley#49).
//
// RENDER REBUILDS THE WHOLE PAGE FROM WHAT EXTRACT READ, AND EXTRACT READS LESS
// THAN THE PAGE HOLDS. A <span> inside a <p>, the class on an <a>, the <span>s
// that colour a <pre>, the head's own spelling (<!doctype html>, <meta …>
// without a slash), an &nbsp; in the shell and the whitespace between blocks
// are all gone from a rendered page. Writing it back over a page where the
// reviewer changed one sentence threw every one of them away.
//
// So the write splices instead: each slot's blocks are matched to the page's
// own by what extraction makes of them (kind, tag, attributes, markdown), the
// blocks that match keep their bytes, and only the rest come from Render. A
// changed block is still Render's whole: what it held that markdown cannot say
// goes with the edit.
//
// RENDER STAYS THE AUTHORITY. The splice is kept only when it reads back
// exactly as Render's page does (the same markdown and the same template), so
// the loop, which re-extracts what was written, cannot tell the two apart. Any
// page the splice cannot place a block in, or whose shell Render changed (an
// emptied container pruned, a restructure), gets Render's page as before, and
// kept is false so the caller can say so: a fallback loses what the page held
// beyond extraction, and must not do it silently.
func Keep(base, rendered []byte) (out []byte, kept bool) {
	if bytes.Equal(base, rendered) {
		return rendered, true
	}
	out, ok := keep(base, rendered)
	if !ok {
		return rendered, false
	}
	return out, true
}

func keep(base, rendered []byte) ([]byte, bool) {
	b, err := split(base)
	if err != nil {
		return nil, false
	}
	r, err := split(rendered)
	if err != nil {
		return nil, false
	}
	if !sameShell(b.ex.Template, r.ex.Template) {
		return nil, false
	}
	bSpans, ok := locate(base, b.slots)
	if !ok {
		return nil, false
	}
	rSpans, ok := locate(rendered, r.slots)
	if !ok {
		return nil, false
	}

	var out bytes.Buffer
	at := 0
	for i, spans := range bSpans {
		seps, ok := separators(base, spans)
		if !ok {
			return nil, false
		}
		first, last := spans[0], spans[len(spans)-1]
		out.Write(base[at:first.start])
		writeSlot(&out, base, rendered, b.slots[i], r.slots[i], spans, rSpans[i], seps, lineBreak(base, first.start))
		at = last.end
	}
	out.Write(base[at:])

	// The guarantee: what was written reads back as Render's page does.
	got, err := split(out.Bytes())
	if err != nil || !bytes.Equal(got.ex.Markdown, r.ex.Markdown) || !reflect.DeepEqual(got.ex.Template, r.ex.Template) {
		return nil, false
	}
	return out.Bytes(), true
}

// sameShell reports whether two templates have the same head, tail and shell
// segments, with slots in the same places. Wrappers may differ: they are the
// blocks, which is what the splice is for.
func sameShell(a, b Template) bool {
	if a.Head != b.Head || a.Tail != b.Tail || len(a.Segments) != len(b.Segments) {
		return false
	}
	for i := range a.Segments {
		sa, sb := a.Segments[i], b.Segments[i]
		if (sa.Slot == nil) != (sb.Slot == nil) || sa.Shell != sb.Shell {
			return false
		}
	}
	return true
}

// span is one content block's bytes in its page, [start, end).
type span struct{ start, end int }

// writeSlot writes one slot's blocks: base's bytes for each block the page
// still holds, in order (a longest common run of keys), and the rendered
// page's for each block the edit added or changed. Between two blocks goes
// the whitespace base had after the last base block passed, so a slot whose
// blocks sat one per line keeps doing so.
func writeSlot(out *bytes.Buffer, base, rendered []byte, bNodes, rNodes []contentNode, bSpans, rSpans []span, seps []string, dflt string) {
	n, m := len(bNodes), len(rNodes)
	// lcs[i][j] is the longest common run of keys of bNodes[i:] and rNodes[j:].
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			switch {
			case bNodes[i].key == rNodes[j].key:
				lcs[i][j] = lcs[i+1][j+1] + 1
			case lcs[i+1][j] >= lcs[i][j+1]:
				lcs[i][j] = lcs[i+1][j]
			default:
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}

	wrote := false
	sep := dflt
	emit := func(b []byte) {
		if wrote {
			out.WriteString(sep)
		}
		out.Write(b)
		wrote = true
	}
	passed := func(i int) {
		if i < len(seps) {
			sep = seps[i]
		}
	}
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && bNodes[i].key == rNodes[j].key:
			emit(base[bSpans[i].start:bSpans[i].end])
			passed(i)
			i++
			j++
		case i < n && (j == m || lcs[i+1][j] >= lcs[i][j+1]):
			// A block the edit removed or changed: its bytes go.
			passed(i)
			i++
		default:
			emit(rendered[rSpans[j].start:rSpans[j].end])
			j++
		}
	}
}

// separators returns the whitespace between each pair of neighbouring blocks
// in a slot. A slot's blocks are siblings with only whitespace between them
// (anything else is shell, which ends the slot), so anything else means a span
// was misplaced.
func separators(src []byte, spans []span) ([]string, bool) {
	seps := make([]string, 0, len(spans))
	for i := 0; i+1 < len(spans); i++ {
		if spans[i+1].start < spans[i].end {
			return nil, false
		}
		gap := string(src[spans[i].end:spans[i+1].start])
		if strings.TrimSpace(gap) != "" {
			return nil, false
		}
		seps = append(seps, gap)
	}
	return seps, true
}

// lineBreak is the separator for a slot that had a single block: a newline and
// the indentation of the line the slot starts on, or nothing when the slot
// does not start a line.
func lineBreak(src []byte, at int) string {
	i := at
	for i > 0 && (src[i-1] == ' ' || src[i-1] == '\t') {
		i--
	}
	if i > 0 && src[i-1] != '\n' {
		return ""
	}
	return "\n" + string(src[i:at])
}

// pageToken is one token of a page's source with its byte range.
type pageToken struct {
	typ        html.TokenType
	name       string
	attr       []html.Attribute
	start, end int
}

func tokenize(src []byte) []pageToken {
	z := html.NewTokenizer(bytes.NewReader(src))
	var toks []pageToken
	off := 0
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			return toks
		}
		n := len(z.Raw())
		t := z.Token()
		toks = append(toks, pageToken{typ: tt, name: t.Data, attr: t.Attr, start: off, end: off + n})
		off += n
	}
}

// locate finds each content block's bytes in src: its start tag, in document
// order, and the end tag that closes it. Each guess is checked by parsing the
// bytes back in the block's own parent and comparing what they make with the
// block; a block that cannot be found that way fails the whole page, which
// then gets Render's output.
func locate(src []byte, slots [][]contentNode) ([][]span, bool) {
	toks := tokenize(src)
	out := make([][]span, len(slots))
	ti := 0
	for si, nodes := range slots {
		for _, cn := range nodes {
			sp, next, ok := find(src, toks, ti, cn.node)
			if !ok {
				return nil, false
			}
			out[si] = append(out[si], sp)
			ti = next
		}
	}
	return out, true
}

// find returns the first start tag from toks[from:] whose element, closed by
// its matching end tag, makes exactly n. A start tag with n's name and
// attributes whose bytes make something else (a shell <p> before the content
// one) is a look-alike: the search goes on past it.
func find(src []byte, toks []pageToken, from int, n *html.Node) (span, int, bool) {
	for i := from; i < len(toks); i++ {
		t := toks[i]
		if t.typ != html.StartTagToken || t.name != n.Data || !reflect.DeepEqual(t.attr, nodeAttrs(n)) {
			continue
		}
		if end, ok := closes(toks, i, n.Data); ok && sameNode(src[t.start:toks[end].end], n) {
			return span{start: t.start, end: toks[end].end}, end + 1, true
		}
	}
	return span{}, 0, false
}

// closes returns the index of the end tag that closes the start tag at
// toks[i], counting nested tags of the same name.
func closes(toks []pageToken, i int, name string) (int, bool) {
	depth := 0
	for k := i; k < len(toks); k++ {
		switch {
		case toks[k].typ == html.StartTagToken && toks[k].name == name:
			depth++
		case toks[k].typ == html.EndTagToken && toks[k].name == name:
			depth--
		}
		if depth == 0 {
			return k, true
		}
	}
	return 0, false
}

// nodeAttrs is n's attributes in the tokenizer's form, nil when it has none.
func nodeAttrs(n *html.Node) []html.Attribute {
	if len(n.Attr) == 0 {
		return nil
	}
	return n.Attr
}

// sameNode reports whether raw, parsed where n sits, makes exactly n.
func sameNode(raw []byte, n *html.Node) bool {
	if n.Parent == nil || n.Parent.Type != html.ElementNode {
		return false
	}
	nodes, err := html.ParseFragment(bytes.NewReader(raw), n.Parent)
	if err != nil || len(nodes) != 1 {
		return false
	}
	return renderNode(nodes[0]) == renderNode(n)
}
