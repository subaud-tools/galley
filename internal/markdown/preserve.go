package markdown

import (
	"reflect"
	"strings"

	"github.com/subaud-tools/galley/internal/docmodel"
	"github.com/yuin/goldmark/ast"
)

// SerializeOnto writes d as markdown, KEEPING THE AUTHOR'S OWN BYTES for every
// top-level block that has not changed.
//
// WHY THIS EXISTS. Serialize renders the document model, and the model does not
// carry spelling: a setext heading comes back "# h", "* item" comes back "-
// item", "__bold__" comes back "**bold**", and a paragraph hard-wrapped over
// three lines comes back on one, because Parse turns a soft line break into a
// space. None of that is a change anybody made. Measured 2026-08-22 on a real
// document: opening it in the editor and quitting without touching a key
// rewrote six separate things, because cmd/galley's shutdown Flush projects
// unconditionally and a projection is Serialize's output.
//
// The paper-over was to skip the write when nothing changed. That leaves the
// harm exactly where the reviewer actually meets it — fix one typo in a
// forty-paragraph post and the other thirty-nine are reformatted around it, in
// the same commit, and the diff no longer says what was done.
//
// THE RULE IS SELF-VERIFYING, WHICH IS WHY IT NEEDS NO ALIGNMENT ARGUMENT.
// prev is chopped into the source of each of its top-level blocks; a chunk is
// KEPT as a candidate only if parsing that chunk on its own yields exactly one
// block, and the candidate is only USED for a block whose rendering is byte-
// identical to the rendering of the chunk's own reparse. So a substituted chunk
// provably reparses to the block it replaced. Nothing here has to reason about
// how Parse's block list lines up with goldmark's children — through
// splitNoteLines, legalize and extractCritic, all three of which can change the
// count — because no index is ever carried across.
//
// IT IS TOP-LEVEL ONLY, and that is a floor rather than a limit: a list whose
// third item was edited re-renders whole, because the candidate for the list no
// longer matches. Recursing into containers is a later change; it cannot make
// this one wrong, only tighter.
//
// The rendering used as the key is renderedBlocks' own, taken from the SAME
// call that produces the output, so a list's marker style (which is decided by
// its neighbours and not by the block) is part of the key. A block that renders
// differently because of where it sits simply misses its candidate and is
// written the serializer's way — the safe direction, and the only one that
// cannot invent bytes.
//
// A chunk is consumed when it is used, so two identical paragraphs take two
// different chunks, in order, and never the same one twice.
//
// WHAT LIES BETWEEN TWO BLOCKS IS KEPT TOO, and so are chunks that are several
// blocks (galley#52). Both are where the per-chunk rule above cannot vouch for
// the bytes on its own: a paragraph's one newline before a fence, and a line the
// parse splits into a note and a paragraph ("{>>n<<}{>>m<<}\" then "word"),
// mean what they mean only next to their neighbours. So that richer output is
// taken only when the whole of it parses to exactly what the plain one does;
// otherwise the plain one, which joins one-block chunks with a blank line, is
// written as before.
func SerializeOnto(d docmodel.Doc, prev []byte) []byte {
	blocks := d.Blocks
	head := ""
	if len(blocks) > 0 && blocks[0].Kind == docmodel.FrontMatter {
		// Front matter is already verbatim in Text and Serialize writes it
		// back unchanged, so it has nothing to preserve and is not a candidate.
		head = renderFrontMatter(blocks[0])
		blocks = blocks[1:]
	}

	rendered := renderedBlocks(blocks)
	texts := make([]string, len(rendered))
	for i, r := range rendered {
		texts[i] = r.text
	}
	plain := finish(head, onto(texts, candidates(prev, false), false))
	rich := finish(head, onto(texts, candidates(prev, true), true))
	if string(rich) == string(plain) || !sameParse(rich, plain) {
		return plain
	}
	return rich
}

// finish puts the front matter and the final newline on a body, as Serialize
// does.
func finish(head, out string) []byte {
	if out == "" {
		if head != "" {
			return []byte(head)
		}
		return []byte("\n")
	}
	if head != "" {
		return []byte(head + "\n" + out + "\n")
	}
	return []byte(frontMatterHazard(out) + "\n")
}

// onto lays prev's chunks over the rendered blocks: a chunk is used, in
// document order, at the first place whose blocks render as its reparse does.
// Plain uses one-block chunks only and joins everything with a blank line;
// rich also uses chunks of several blocks and joins two chunks that were
// neighbours in prev with what was between them there.
func onto(texts []string, chunks []chunk, rich bool) string {
	type piece struct {
		text  string
		chunk int // index into chunks, or -1 for the serializer's own
	}
	from := make([]int, len(texts)) // the chunk covering each block, or -1
	for i := range from {
		from[i] = -1
	}
	for c, ch := range chunks {
		n := len(ch.keys)
		if n == 0 || (n > 1 && !rich) {
			continue
		}
	place:
		for i := 0; i+n <= len(texts); i++ {
			for k := 0; k < n; k++ {
				if from[i+k] != -1 || texts[i+k] != ch.keys[k] {
					continue place
				}
			}
			for k := 0; k < n; k++ {
				from[i+k] = c
			}
			break
		}
	}
	var pieces []piece
	for i := 0; i < len(texts); {
		c := from[i]
		if c == -1 {
			pieces = append(pieces, piece{texts[i], -1})
			i++
			continue
		}
		pieces = append(pieces, piece{chunks[c].body, c})
		i += len(chunks[c].keys)
	}
	var b strings.Builder
	for i, p := range pieces {
		if i > 0 {
			q := pieces[i-1]
			if rich && q.chunk != -1 && p.chunk == q.chunk+1 {
				b.WriteString(chunks[q.chunk].sep)
			} else {
				b.WriteString("\n\n")
			}
		}
		b.WriteString(p.text)
	}
	return b.String()
}

// sameParse reports whether a and b parse to the same document and lift the
// same comments out of it.
func sameParse(a, b []byte) bool {
	da, ca, err := Parse(a)
	if err != nil {
		return false
	}
	db, cb, err := Parse(b)
	if err != nil {
		return false
	}
	return docmodel.Equal(da, db) && reflect.DeepEqual(ca, cb)
}

// chunk is the source of one top-level block of prev (or of a few, when the
// parse splits it): body is its bytes without their trailing newlines, sep is
// those newlines, and keys are the renderings of its reparse, which is what a
// run of the document's blocks must render as for body to stand in for them.
// keys is empty for a chunk that cannot be a candidate.
type chunk struct {
	body, sep string
	keys      []string
}

// candidates cuts prev into its chunks, with the rendering of each chunk's
// own reparse as its keys, in document order. fences is chunkStarts' own, and
// only the rich output asks for it.
//
// The key is the rendering of the chunk's own reparse, so a lookup answers
// exactly one question: "is there a piece of the old file that means the same
// thing as these blocks". Everything a chunk carries beyond that meaning — the
// author's wrapping, their bullet character, their emphasis marker, a
// {>>note<<} the parse lifts out — is what SerializeOnto is putting back.
//
// A chunk whose reparse is not exactly one block is only a candidate for the
// rich output, which is checked whole: it is either a line the parse splits
// (note lines) or a chunk whose boundaries this function got wrong (see
// chunkStarts on the nodes it cannot place), and a wrong boundary must cost a
// re-render and never a wrong write.
func candidates(prev []byte, fences bool) []chunk {
	_, rest := splitFrontMatter(prev)
	var out []chunk
	for _, src := range chunkStarts(rest, fences) {
		body := strings.TrimRight(src, "\n")
		c := chunk{body: body, sep: src[len(body):]}
		doc, comments, err := Parse([]byte(src))
		// A refusal cannot be a candidate, and neither can a chunk whose
		// parse LIFTS something out of it: the whole document's parse lifted
		// the same note out of the model, and writing the chunk back verbatim
		// would put the marker back in the file. A lifted note is not
		// imported as a comment, so it leaves the file at the next save; that
		// is decided by the parse, not here.
		if err == nil && len(comments) == 0 {
			for _, r := range renderedBlocks(doc.Blocks) {
				c.keys = append(c.keys, r.text)
			}
		}
		out = append(out, c)
	}
	return out
}

// chunkStarts cuts src into the source text of each top-level block.
//
// A block runs from the start of the LINE its first content byte falls on to
// the start of the line the next block begins at. Snapping to the line start is
// what picks up a container's own prefix — a blockquote's ">" and a list
// marker sit on the same line as the content whose segment goldmark reports —
// and running to the next block's line is what picks up a setext heading's
// "===" underline, which is part of the heading's source and not part of any
// node's reported segments.
//
// A NODE WITH NO SEGMENTS ANYWHERE UNDER IT CANNOT BE PLACED, and a thematic
// break is one. Rather than guess, it is merged into the chunk before it: the
// merged chunk then reparses to two blocks, fails candidates' one-block test,
// and both blocks are written the serializer's way. The feature degrades to
// "these two blocks are not preserved" instead of to a wrong boundary.
//
// fences starts a fenced code block at its opening line (see firstSegment).
// Only the rich output asks for it, because only the rich output is checked
// whole: an unclosed fence's chunk means what it means only at the end of the
// file, and a plain output could put a new block after it (galley#52).
func chunkStarts(src []byte, fences bool) []string {
	root := parseTree(src)
	var starts []int
	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		pos, ok := firstSegment(src, n, fences)
		if !ok {
			continue // merged into the previous chunk; see the doc comment.
		}
		starts = append(starts, lineStart(src, pos))
	}
	out := make([]string, 0, len(starts))
	for i, s := range starts {
		end := len(src)
		if i+1 < len(starts) {
			end = starts[i+1]
		}
		if s > end {
			continue
		}
		out = append(out, string(src[s:end]))
	}
	return out
}

// firstSegment reports the offset of the first source byte under n, which is
// the leftmost start over every segment any descendant reports.
func firstSegment(src []byte, n ast.Node, fences bool) (int, bool) {
	best, ok := 0, false
	var walk func(ast.Node)
	walk = func(x ast.Node) {
		// BLOCKS ONLY. Lines() PANICS on an inline node ("can not call with
		// inline nodes"), and an inline's offsets would say nothing this
		// function needs anyway — a block's own segments already start at its
		// first content byte.
		if x.Type() != ast.TypeBlock {
			return
		}
		// A FENCE STARTS AT ITS OPENING LINE, which none of its segments are
		// on: Lines() is the code inside, which starts on the line after it.
		// Started at the code, the opening fence went to the chunk before
		// and neither chunk reparsed to its block, so an edit anywhere
		// respelled the fence (galley#52). The info string, when there is
		// one, is on the opening line; otherwise the opening line is the one
		// before the first line of code. A fence with neither has nothing to
		// place it by, and is merged into the chunk before, as below.
		if f, isFence := x.(*ast.FencedCodeBlock); isFence && fences {
			if f.Info != nil {
				if s := f.Info.Segment.Start; !ok || s < best {
					best, ok = s, true
				}
			} else if l := f.Lines(); l.Len() > 0 {
				if at := lineStart(src, l.At(0).Start); at > 0 {
					if s := lineStart(src, at-1); !ok || s < best {
						best, ok = s, true
					}
				}
			}
		}
		if l := x.Lines(); l != nil {
			for i := 0; i < l.Len(); i++ {
				if s := l.At(i).Start; !ok || s < best {
					best, ok = s, true
				}
			}
		}
		for c := x.FirstChild(); c != nil; c = c.NextSibling() {
			walk(c)
		}
	}
	walk(n)
	return best, ok
}

// lineStart returns the offset of the start of the line containing pos.
func lineStart(src []byte, pos int) int {
	if pos > len(src) {
		pos = len(src)
	}
	i := strings.LastIndexByte(string(src[:pos]), '\n')
	return i + 1
}
