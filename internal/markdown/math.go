package markdown

import (
	"bytes"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// DISPLAY MATH IS THE FRONT MATTER ARGUMENT A SECOND TIME: galley does not have
// to understand the construct, only know where it ends.
//
// `$$` on its own line, some TeX, `$$` on its own line is a plain PARAGRAPH to
// CommonMark, and the converter turns a soft line break into a space — which is
// deliberate for prose and destroys this. Measured on the tracked build, one
// `galley suggest` over a file holding it and nothing else touched:
//
//	$$                        $$ E = mc^2 $$
//	E = mc^2            ->
//	$$
//
// Every renderer that draws the block wants the delimiters on their own lines,
// so the reflow is not a cosmetic difference: it stops being math.
//
// IT IS MODELLED RATHER THAN REFUSED, and the discriminator is whose language
// the CONTENT is in. Front matter is YAML, a fence is code, and this is TeX —
// none of them are markdown, so there is no prose inside to review, no mark to
// hang on it and nothing galley could be right or wrong about. What galley
// needs is what a scanner can give: where the block ends and exactly which
// bytes it occupies. The three dialects refused alongside this one (definition
// lists, `:::` directives, `> [!NOTE]` callouts) all hold ORDINARY MARKDOWN
// PROSE, and carrying that verbatim would make the author's own sentences
// unreviewable — a second silent harm rather than a fix. See parse.go's
// refusals.
//
// A BLOCK PARSER RATHER THAN A PRE-SCAN, which is where this differs from front
// matter. Front matter is at byte 0 by definition, so a scanner over the raw
// file is exact. Display math can be anywhere — inside a list item, inside a
// blockquote — where the raw bytes carry a container prefix that is not the
// block's. goldmark's reader has already stripped that prefix by the time a
// block parser sees a line, which is the same reason a fenced code block is
// parsed rather than scanned.

var kindMathBlock = ast.NewNodeKind("GalleyMathBlock")

// mathBlockNode is the AST node the parser below produces. Its Lines hold the
// WHOLE block including both `$$` delimiters, for front matter's reason: they
// are the author's bytes, they are what makes the block recognisable when it is
// read back, and holding them makes Serialize a copy rather than a
// reconstruction — there is no second spelling of "$$" for the two sides to
// disagree about.
type mathBlockNode struct {
	ast.BaseBlock
	// open is the source offset of the opening delimiter's first "$", and
	// closed is set when Continue meets the closing one. Close reads both:
	// see there.
	open   int
	closed bool
}

func (n *mathBlockNode) Kind() ast.NodeKind { return kindMathBlock }

// IsRaw is what keeps the inline parser out of the TeX. Without it goldmark
// would walk the block's lines looking for emphasis, and `x_1 * y` would come
// back with a `<em>` in it.
func (n *mathBlockNode) IsRaw() bool { return true }

func (n *mathBlockNode) Dump(src []byte, level int) {
	ast.DumpHelper(n, src, level, nil, nil)
}

// mathFence reports whether line, with its indentation already skipped, is a
// delimiter: exactly `$$` and nothing else but trailing space.
//
// EXACTLY `$$`, which is what makes this safe to let interrupt a paragraph.
// `$$5 and change` and `$$x$$` are not delimiters, so ordinary prose carrying a
// doubled dollar is untouched; only a line that is the delimiter and nothing
// else opens or closes a block.
func mathFence(line []byte) bool {
	trimmed := bytes.TrimRight(line, " \t\r\n")
	return bytes.Equal(trimmed, []byte("$$"))
}

type mathBlockParser struct{}

func (mathBlockParser) Trigger() []byte { return []byte{'$'} }

func (mathBlockParser) Open(_ ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, seg := reader.PeekLine()
	pos := pc.BlockOffset()
	if pos < 0 || !mathFence(line[pos:]) {
		return nil, parser.NoChildren
	}
	open := delimiterSegment(seg, pos)
	if refused, _ := pc.Get(mathRefusedKey).(map[int]bool); refused[open.Start] {
		// An opener a previous pass found unclosed. It is text this time.
		return nil, parser.NoChildren
	}
	node := &mathBlockNode{open: open.Start}
	node.Lines().Append(open)
	return node, parser.NoChildren
}

func (mathBlockParser) Continue(node ast.Node, reader text.Reader, _ parser.Context) parser.State {
	line, seg := reader.PeekLine()
	w, pos := util.IndentWidth(line, reader.LineOffset())
	if w < 4 && mathFence(line[pos:]) {
		node.Lines().Append(delimiterSegment(seg, pos))
		node.(*mathBlockNode).closed = true
		reader.AdvanceToEOL()
		return parser.Close
	}
	node.Lines().Append(seg)
	return parser.Continue | parser.NoChildren
}

// delimiterSegment is the source segment of a delimiter line, from its first
// "$" to the end of the line.
//
// pos indexes the line PeekLine returned, and that line is NOT the source: when
// a container has taken part of a tab (">\t$$" — the ">" consumes one column
// of the tab's three), the rest comes back as seg.Padding spaces in front of
// the bytes. So the source offset is pos less the padding, which is goldmark's
// own arithmetic (atx_heading.go, fcode_block.go), and the padding itself is
// dropped: it sits before the "$", and a delimiter is the "$$" and what follows.
// Using pos as a source offset put the start Padding bytes late — past the end
// of an unterminated last line, which panicked, and into the wrong bytes
// everywhere else, which lost the "$$" from the file.
func delimiterSegment(seg text.Segment, pos int) text.Segment {
	return text.NewSegment(seg.Start+pos-seg.Padding, seg.Stop)
}

// Close is where an UNTERMINATED block is found out.
//
// `$$` with no closing delimiter is not display math, it is text whose line
// happens to be two dollars: front matter's own third rule, which refuses a
// block that never closes so that a leading `---` stays the thematic break it
// is. Whether a block is closed is only known once its container or the file
// has ended it, and by then every line after the opener has been taken as TeX.
// So this records the opener, and parseTree reads the document again with that
// opener refused: the lines come back exactly as goldmark reads them without
// this parser.
//
// This used to call a block closed once it held two lines, and replace a
// one-line block with a paragraph here. That kept a bare `$$` at the end of a
// file, and nothing else: `$$` ended by EOF or by its container two or more
// lines later kept everything after it as raw TeX, so "$$\nfoo *x*\n\n# h\n"
// read as one math block and the emphasis and the heading were gone
// (galley#61). Rebuilding the lines into one paragraph here would be wrong for
// the same document, which holds a paragraph AND a heading: only a second read
// knows what the lines are.
func (mathBlockParser) Close(node ast.Node, _ text.Reader, pc parser.Context) {
	n := node.(*mathBlockNode)
	if n.closed {
		return
	}
	if unclosed, ok := pc.Get(mathUnclosedKey).(*[]int); ok {
		*unclosed = append(*unclosed, n.open)
	}
}

// mathRefusedKey and mathUnclosedKey carry parseTree's two sets through the
// parser context: the openers this pass reads as text, and the ones it found
// unclosed.
var (
	mathRefusedKey  = parser.NewContextKey()
	mathUnclosedKey = parser.NewContextKey()
)

// parseTree is the package's one block parse, used by Parse and by the
// preserving writer's chunking so the two agree about where blocks are.
//
// It reads the document again for as long as a pass finds an unclosed `$$`,
// each time with every unclosed opener so far refused. Refusing an opener only
// changes what comes AFTER it, so each pass refuses at least one new opener and
// the passes end within the number of `$$` lines; a document with none is read
// once.
func parseTree(src []byte) ast.Node {
	refused := map[int]bool{}
	for {
		var unclosed []int
		pc := parser.NewContext()
		pc.Set(mathRefusedKey, refused)
		pc.Set(mathUnclosedKey, &unclosed)
		root := md.Parser().Parse(text.NewReader(src), parser.WithContext(pc))
		if len(unclosed) == 0 {
			return root
		}
		for _, at := range unclosed {
			refused[at] = true
		}
	}
}

// A `$$` line ENDS the paragraph above it rather than continuing it. Saying no
// here would leave the exact shape this file exists for — prose, then display
// math flush under it — reflowing into one line, which is the bug rather than a
// smaller version of it. The delimiter test is exact (`mathFence`), so nothing
// that reads as prose can trigger it.
func (mathBlockParser) CanInterruptParagraph() bool { return true }

// An indented line is code, not a delimiter — the same answer the fenced code
// parser gives, for the same reason.
func (mathBlockParser) CanAcceptIndentedLine() bool { return false }

// mathBlockOption registers the parser on the package's one goldmark instance.
// The priority puts it after the fenced code block (700) and before the
// blockquote (800): a `$$` inside a fence is code, and a `$$` inside a quote is
// that quote's math.
func mathBlockOption() parser.Option {
	return parser.WithBlockParsers(util.Prioritized(mathBlockParser{}, 750))
}
