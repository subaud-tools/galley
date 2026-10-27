package markdown

import (
	"bytes"
	"fmt"

	"github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
)

// THREE DIALECTS THAT ARE ONE PARAGRAPH TO COMMONMARK, AND ARE REFUSED RATHER
// THAN REFLOWED.
//
// A soft line break becomes a space (parse.go's KindText case). That is
// DELIBERATE for prose — a hard-wrapped paragraph reflows, and the README says
// so — and it destroys a construct whose meaning is carried by the line breaks.
// Four dialects were measured doing exactly that on the tracked build, with one
// `galley suggest` and no keystroke:
//
//	Apple                             Apple : A fruit that grows on trees.
//	: A fruit that grows on trees.
//
//	:::note                           :::note This is a body. It has two lines. :::
//	This is a body.
//	It has two lines.
//	:::
//
//	> [!NOTE]                         > [!NOTE] Useful information.
//	> Useful information.
//
//	$$                                $$ E = mc^2 $$
//	E = mc^2
//	$$
//
// The fourth is MODELLED — see math.go — and these three are REFUSED, and the
// discriminator between the two answers is whose language the content is in.
// TeX is not markdown: there is no prose inside display math to review, no mark
// to hang on it and nothing galley could be right or wrong about, so carrying
// the bytes verbatim costs the reviewer nothing. These three hold ORDINARY
// MARKDOWN PROSE — a definition, an admonition's body, a callout's sentence —
// and carrying THAT verbatim would make the author's own sentences literal
// text: unsuggestable, unhighlightable, invisible to `suggest.List`, drawn as a
// preformatted blob. That is a second silent harm wearing the first one's
// clothes. A refusal names the construct and the line, the way footnotes and
// raw HTML are named, and destroys nothing.
//
// EVERY TEST HERE IS EXACT, because a false refusal is a document that will not
// open. A definition list needs a line beginning ":" and a space; a directive
// needs a line beginning ":::"; a callout needs the blockquote's FIRST line to
// be a bare "[!WORD]". Ordinary prose does not spell any of those.

// refuseDialect reports a paragraph written in one of the three line-break
// dialects, or nil.
//
// It is asked of every Paragraph and TextBlock, before any inline is converted,
// because the evidence is the SOURCE LINES and those are gone the moment the
// soft breaks become spaces.
func (p *converter) refuseDialect(n ast.Node, inQuote bool) error {
	lines := n.Lines()
	if lines.Len() == 0 || n.Kind() == extast.KindTableCell {
		// A TABLE CELL is asked through paragraph() too, and none of the three
		// can be spelled inside one: a cell is one line of a row, so it has no
		// second line for a definition, and its own pipes surround what would
		// be a directive's ":::" or a callout's "[!NOTE]". Refusing it made an
		// author's table with "| ::: |" a file galley would not open, and
		// Serialize writes exactly that for a cell holding ":::" (galley#61).
		return nil
	}
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		line := skipIndent(seg.Value(p.src))
		switch {
		// A DIRECTIVE, on any line of the paragraph. Both ":::note" and its
		// closing bare ":::" are caught, and either is enough: the opener is
		// what a reader recognises and the closer is what a document with the
		// opener above a blank line still carries.
		case bytes.HasPrefix(line, []byte(":::")):
			return p.dialect("::: directive block", seg.Start)
		// A DEFINITION LIST, on any line but the first: the term comes first
		// and the definition under it. ":" alone is not enough — a line may
		// legitimately open with a colon — so the marker is ":" followed by a
		// space or a tab, which is what pandoc and PHP Markdown Extra both
		// spell it as.
		case i > 0 && definitionMarker(line):
			return p.dialect("definition list", seg.Start)
		// A GITHUB CALLOUT, whose marker must be the FIRST line of the FIRST
		// paragraph of a blockquote — that is where GitHub reads it, and a
		// "[!NOTE]" anywhere else is ordinary bracketed text.
		case i == 0 && inQuote && calloutMarker(line):
			return p.dialect("> [!NOTE] callout", seg.Start)
		}
	}
	return nil
}

// dialect is unsupported's sibling for a construct whose evidence is a LINE
// rather than a node. A paragraph's own Pos() is its first line, and the
// dialect that made it unrepresentable is usually on the second.
func (p *converter) dialect(kind string, at int) error {
	return fmt.Errorf("markdown: %s not supported (line %d)", kind, p.line(at))
}

// skipIndent drops up to three leading spaces — the CommonMark allowance
// before a construct stops being a construct and becomes indented code.
func skipIndent(line []byte) []byte {
	for i := 0; i < 3 && i < len(line); i++ {
		if line[i] != ' ' {
			return line[i:]
		}
	}
	if len(line) >= 3 {
		return line[3:]
	}
	return bytes.TrimLeft(line, " ")
}

// definitionMarker reports a pandoc/PHP-Markdown-Extra definition line: ":"
// followed by a space or a tab, and something after it.
func definitionMarker(line []byte) bool {
	if len(line) < 2 || line[0] != ':' {
		return false
	}
	if line[1] != ' ' && line[1] != '\t' {
		return false
	}
	return len(bytes.TrimSpace(line[1:])) > 0
}

// calloutMarker reports a bare "[!WORD]" line — GitHub's alert marker. The
// whole line, because "[!NOTE] and then some prose" is not one.
func calloutMarker(line []byte) bool {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) < 4 || trimmed[0] != '[' || trimmed[1] != '!' || trimmed[len(trimmed)-1] != ']' {
		return false
	}
	word := trimmed[2 : len(trimmed)-1]
	if len(word) == 0 {
		return false
	}
	for _, c := range word {
		if c < 'A' || c > 'Z' {
			return false
		}
	}
	return true
}
