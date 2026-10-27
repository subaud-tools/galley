package markdown

import (
	"bytes"
	"strings"
	"unicode"
)

// escape.go holds the backslash-escape logic shared by Parse (which must
// unescape) and Serialize (which must escape). The same CommonMark
// ASCII-punctuation set governs both directions; letting them drift apart
// is exactly what caused the escaping bug this file fixes: Serialize
// unconditionally escaped characters that Parse never learned to unescape,
// so every Serialize(Parse(...)) cycle left a backslash behind for the
// next cycle to escape again, growing without bound.

// isEscapableASCIIPunct reports whether r is one of CommonMark's ASCII
// punctuation characters — the only characters a backslash may escape.
// https://spec.commonmark.org/0.31.2/#backslash-escapes
func isEscapableASCIIPunct(r rune) bool {
	switch r {
	case '!', '"', '#', '$', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
		':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~':
		return true
	}
	return false
}

// unescape reverses backslash-escapes of CommonMark's ASCII punctuation.
// goldmark's block scanner recognizes an escape well enough to stop the
// escaped character from being read as markup, but it never strips the
// backslash from the Text node's raw source bytes (parser.parseBlock just
// advances over both bytes unchanged) — Parse must do that itself, or a
// round-tripped escape keeps its backslash for Serialize to escape again.
func unescape(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' && i+1 < len(s) && isEscapableASCIIPunct(rune(s[i+1])) {
			b.WriteByte(s[i+1])
			i++
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// needsEscapeAt reports whether r[i] must be backslash-escaped for Parse to
// read it back as literal text rather than markup: '<' only where it would
// open raw HTML or an autolink, '!' only where it would turn a following
// link into an image, '*' and '_' only where
// CommonMark's flanking rule would let them open or close emphasis (with
// the intraword exception for '_', so "snake_case_name" round-trips
// without a single backslash in it), ']' only where it would close an inline
// link or a link reference definition, '`' always (it unconditionally opens a
// code span, no flanking rule saves it), and '\' only where the character
// after it is itself escapable — "back\slash" needs no escaping at all,
// since a backslash before a non-punctuation character already round-trips
// as two literal characters.
//
// r is the full planned output for a block (see render_inline.go), not
// just one Inline's text: fix round 2 found that deciding this per-Inline
// missed cases where the delimiter of an ADJACENT Inline — or an entirely
// separate plain-text Inline sitting right next to this one — supplies the
// character that makes this one read as markup. A lone '*' immediately
// before a Bold run's own "**" fuses into "***" on emission; a "[x]" whose
// ']' is followed by an unrelated Inline's literal "(y)" reads back as a
// real link. Neither is visible from inside a single Inline's rune slice.
//
// Everything in that list is a judgement about an inline neighbourhood. ctx
// carries the three things that are NOT visible from the runes around i:
// where its line begins, whether it is a heading's content, and whether it
// sits inside a link or image label. Block structure is decided from a
// line's edges before any inline parsing happens at all, and a label's
// brackets are decided by the construct that encloses it.
func needsEscapeAt(r []rune, i int, ctx escapeCtx) bool {
	if blockEscape(r, i, ctx) || closesHeading(r, i, ctx.heading) {
		return true
	}
	if ctx.labelAt(i) && (r[i] == '[' || r[i] == ']') {
		// Inside "[...]" a bracket closes the label rather than being text,
		// so both are escaped here whether or not they would be markup out
		// in the open.
		return true
	}
	switch r[i] {
	case '\\':
		return i+1 < len(r) && isEscapableASCIIPunct(r[i+1])
	case '`':
		return true
	case '*':
		return flanking(r, i)
	case '_':
		return flanking(r, i) && !intraword(r, i)
	case ']':
		return closesLink(r, i) || closesLinkReference(r, i, ctx)
	case '<':
		return opensAngleMarkup(r, i)
	case '!':
		return opensImage(r, i, ctx)
	}
	return false
}

// opensImage reports whether the '!' at r[i] turns the link that follows it
// into an IMAGE. That matters because an image's label is not inline
// content: Parse rejects an image whose alt text holds anything but plain
// text, so "!" + a link containing emphasis is a document that will not
// load — which is how FuzzRoundTrip found it, from "!**[0]()**".
//
// The escape only belongs on the "!" when the "[" after it is a DELIMITER
// this renderer emitted for a Link mark. Where the "[" is the author's own
// text, the pair is already broken by closesLink escaping the "](" that
// would have closed the image, and a second backslash would be noise.
//
// A delimiter "[" needs no further test: this renderer never writes one
// except as a link opener it will close with "](...)". An earlier version
// asked a forward scan whether that "[" opened a link, and FuzzRoundTrip
// showed why that was wrong — the scan stopped at a content bracket the
// same pass was about to escape and answered "not a link" for a link. The
// plan does not know its own escaping yet; it does know which runes it
// emitted.
func opensImage(r []rune, i int, ctx escapeCtx) bool {
	return i+1 < len(r) && r[i+1] == '[' && !ctx.contentAt(i+1)
}

// escapeCtx is what the escaping pass knows that the runes alone do not.
type escapeCtx struct {
	// lineStart is the index in r where i's output line begins, or -1 when
	// i sits on a line whose start is not r's own (a heading's inlines
	// follow a "# " prefix, so nothing in them can lead a line).
	lineStart int
	// heading is true when r is an ATX heading's content, which has a rule
	// at the other END of the line — see closesHeading.
	heading bool
	// escapable and labels mirror the planned runes. escapable[j] reports
	// whether r[j] is inline-text content this pass may escape rather than
	// a delimiter the renderer emitted; labels[j] reports whether it sits
	// inside a link's or image's square brackets.
	//
	// Both exist because escaping is not decided rune by rune in isolation:
	// whether r[i] needs a backslash can depend on whether a rune ELSEWHERE
	// is going to get one. FuzzRoundTrip found that twice, and both times
	// the fix was to ask what the plan emitted rather than to re-derive it
	// from the runes.
	escapable []bool
	labels    []bool
}

func (c escapeCtx) contentAt(i int) bool {
	return i >= 0 && i < len(c.escapable) && c.escapable[i]
}

func (c escapeCtx) labelAt(i int) bool {
	return i >= 0 && i < len(c.labels) && c.labels[i]
}

// isSpaceOrEdge reports whether position i in r is whitespace or lies off
// the end of the run. CommonMark's flanking rule treats the start and end
// of a line the same as whitespace, and this is where that happens.
//
// It takes an INDEX rather than a rune on purpose. The obvious spelling is
// a sentinel rune returned for an out-of-range index, and the obvious
// sentinel is rune 0 — which is NUL, a character text can actually contain.
// That collision made a "*" sitting next to a NUL look like a "*" at the
// start of a line: not flanking, so not escaped, so read back as emphasis.
// FuzzRoundTrip found it as an input whose serialization OSCILLATED between
// two spellings forever. There is no rune that is safe to invent, so this
// asks about the position instead.
func isSpaceOrEdge(r []rune, i int) bool {
	return i < 0 || i >= len(r) || unicode.IsSpace(r[i])
}

func isWordCharAt(r []rune, i int) bool {
	return i >= 0 && i < len(r) && isWordChar(r[i])
}

func isWordChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// flanking reports whether the delimiter at r[i] sits where CommonMark's
// flanking rule would let it participate in emphasis: not surrounded by
// whitespace (or a run boundary) on both sides at once. "5 * 3 = 15" is
// not flanking (space on both sides); "*foo" or "foo*" is.
func flanking(r []rune, i int) bool {
	return !isSpaceOrEdge(r, i-1) || !isSpaceOrEdge(r, i+1)
}

// intraword reports whether the delimiter at r[i] is flanked by word
// characters on both sides — CommonMark's exception that keeps '_' inside
// "snake_case_name" from opening emphasis even though it is flanking.
func intraword(r []rune, i int) bool {
	return isWordCharAt(r, i-1) && isWordCharAt(r, i+1)
}

// opensAngleMarkup reports whether the '<' at r[i] would start one of the
// constructs Parse REFUSES: an inline raw HTML tag, an HTML comment or
// declaration, or an autolink. Left bare, such a "<" does not corrupt the
// document quietly — it stops the file from loading at all, which
// made it the most urgent of Task 4's known classes: it is the only one that
// fails LOUDLY, and the only place to close it is this layer.
//
// Two halves, because "<" opens two different kinds of thing. A tag or
// declaration is "<" followed by a letter, "/", "!" or "?", and it may
// contain spaces. An autolink may contain neither a space nor a "<", but it
// may START with anything at all — "<0@0>" is an email autolink beginning
// with a digit, which is what the fuzzer found and what the first half
// alone misses.
//
// The union over-escapes: "<y" with no ">" after it is not markup and gets
// a backslash it does not need. That is the direction to err in. An
// unnecessary "\<" reparses to exactly "<" and is stable, while a missing
// one is a file that will not open. And the shape that actually appears in
// prose — a less-than sign with a space after it — matches neither half and
// is left alone.
func opensAngleMarkup(r []rune, i int) bool {
	if i+1 < len(r) {
		switch c := r[i+1]; {
		case c == '/', c == '!', c == '?', isASCIILetter(c):
			return true
		}
	}
	marker := false
	for j := i + 1; j < len(r); j++ {
		switch {
		case r[j] == '>':
			// An autolink is either a URI, which needs a scheme and so a
			// ":", or an email, which needs an "@". Without one of those
			// "<}>" is not an autolink and the backslash would be noise —
			// and noise here is real, since a nested CriticMarkup soup can
			// produce a lot of "<...>" that means nothing.
			return marker
		case r[j] == ':', r[j] == '@':
			marker = true
		case r[j] == '<', unicode.IsSpace(r[j]):
			return false
		}
	}
	return false
}

func isASCIILetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

// closesLink reports whether the ']' at r[i] would CLOSE an inline link or
// image: the "](" that markdown looks for after an opening bracket.
//
// Escaping the closer rather than the opener is what makes this decision
// answerable at all. The opener cannot be judged on its own: a link label
// nests, so whether a "[" is closed by a given "]" depends on how many
// brackets between them are themselves escaped — and those escapes depend
// on the same question one level down. FuzzRoundTrip walked straight into
// that circle twice ("0![[]]()", then "![*0*0[\]()"), each fix moving the
// problem rather than solving it.
//
// The closer has no such loop. "](" is two adjacent characters, neither of
// which any other rule escapes, so the test is local and settles in one
// pass. And escaping it is sufficient: with no unescaped "](" left in the
// text, the only ones remaining are the delimiters this renderer emitted
// for real links, and markdown pairs each of those with the "[" that
// immediately precedes its own content — the nearest unmatched opener —
// never with a bracket further back in the author's text.
func closesLink(r []rune, i int) bool {
	return i+1 < len(r) && r[i+1] == '('
}

// closesLinkReference reports whether the ']' at r[i] would close a LINK
// REFERENCE DEFINITION's label — "[label]: destination" — which is a BLOCK,
// and one of the constructs Parse refuses rather than mangles. A paragraph
// whose text happens to read that way therefore stops the file loading.
//
// This escapes the closer for the same reason closesLink does, and the
// history is worth keeping: the first version escaped the OPENING "[" when
// a "]:" followed it on the same line, and the fuzzer walked it through
// three separate holes. A label may span lines, so the line bound was
// wrong. A "]" the closer-rule was about to escape stopped the scan early.
// And worst, escaping one "[" could turn a LATER "[" into a valid opener,
// because an escaped bracket no longer invalidates the label — one rule
// changing its own answer.
//
// From the closer the question is simple and settles in one pass: a
// definition's label must BEGIN A LINE, so walk back to the nearest "[" the
// renderer did not neutralize and ask whether that one leads a line. If it
// does not, no definition can form here — an earlier line-leading "[" would
// have this unescaped "[" inside its label, which is not allowed either.
func closesLinkReference(r []rune, i int, ctx escapeCtx) bool {
	if i+1 >= len(r) || r[i+1] != ':' || ctx.lineStart < 0 {
		// lineStart < 0 means this is a heading's content, where no block
		// construct can begin at all.
		return false
	}
	for p := i - 1; p >= 0; p-- {
		if ctx.labelAt(p) || r[p] != '[' {
			continue
		}
		return p == 0 || r[p-1] == '\n'
	}
	return false
}

// --- line-leading block structure ---------------------------------------
//
// Everything below answers one question the inline rules above cannot even
// see: markdown decides a line's BLOCK structure from its first characters,
// before any inline parsing runs. So "-" is ordinary text in the middle of
// a line and a whole bullet list at the start of one, and a serializer that
// writes a paragraph's text back bare can silently turn it into a list.
//
// That was the single biggest round-trip gap Task 4's probe found — 68 of its
// 88 newly-reachable failures: Parse("\\-") yields a paragraph whose
// text is "-", Serialize wrote "-", and the next Parse read a bullet list.
// The paragraph is gone — not corrupted at the character level, but changed
// in shape, which is worse, because the text still looks right.
//
// The rules are deliberately EXACT rather than generous. Escaping is a
// visible diff in the author's file, so a rule that fires where markdown
// would not have made block structure anyway is a defect of its own:
// "####### x" is seven hashes, one past ATX's limit, and must stay bare.

// blockEscape reports whether r[i] must be escaped to stop its line from
// being read as block structure. lineStart < 0 means i's line does not
// begin inside r, so no block construct can start here at all.
func blockEscape(r []rune, i int, ctx escapeCtx) bool {
	lineStart := ctx.lineStart
	if lineStart < 0 || i < lineStart {
		return false
	}
	end := lineEndFrom(r, lineStart)
	if i >= end {
		return false
	}
	// An ordered list's marker is its digits plus a "." or ")", and a
	// backslash before a digit is not an escape at all (CommonMark escapes
	// only ASCII punctuation) — so the delimiter is the only character that
	// can carry the escape, and it is the only one considered off the line
	// start.
	if i > lineStart {
		return opensOrderedList(r, i, lineStart, end)
	}
	if lineStart > 0 && opensTableDelimiter(r, lineStart, end) {
		return true
	}
	switch r[i] {
	case '$':
		return opensMath(r, lineStart, end)
	case ':':
		return opensRefusedDialect(r, lineStart, end)
	case '>':
		// A blockquote marker needs nothing after it.
		return true
	case '-':
		return opensBullet(r, i, end) || opensThematicBreak(r, i, end) || opensSetextRule(r, i, end)
	case '+':
		return opensBullet(r, i, end)
	case '*':
		return opensBullet(r, i, end) || opensThematicBreak(r, i, end)
	case '_':
		return opensThematicBreak(r, i, end)
	case '=':
		return opensSetextRule(r, i, end)
	case '~':
		return opensCodeFence(r, i, end)
	case '#':
		return opensATXHeading(r, i, end)
	case '[':
		return opensUnescapableReference(r, i, ctx)
	}
	return false
}

// opensUnescapableReference reports whether the '[' leading this line opens
// a LINK REFERENCE DEFINITION whose closing "]:" this pass cannot escape.
//
// closesLinkReference handles the ordinary case, and handles it from the
// closer precisely so the decision does not become circular. But a "]"
// inside a CODE SPAN is not escapable at all — markdown gives no way to
// escape code-span content — and block structure is decided before any
// inline parsing, so the scanner sees that "]:" and never knows it was
// meant to be code. FuzzRoundTrip found it as "[](`]:`", a paragraph that
// came back as a definition and stopped the file loading.
//
// Where the closer can take the escape this stays out of the way, which is
// what keeps the two rules from arguing. And it cannot loop with
// closesLinkReference: both only ever ADD a backslash, never withdraw one,
// and neither reads the other's output — only the plan's own flags.
func opensUnescapableReference(r []rune, i int, ctx escapeCtx) bool {
	for j := i + 1; j < len(r); j++ {
		if ctx.labelAt(j) {
			continue
		}
		switch r[j] {
		case ']':
			if ctx.contentAt(j) && (closesLink(r, j) || closesLinkReference(r, j, ctx)) {
				// This one is about to be escaped, so it closes nothing.
				continue
			}
			return j+1 < len(r) && r[j+1] == ':'
		case '[':
			// NOT a disqualification, even though an unescaped bracket
			// inside the label would be one. This same rule may be about to
			// escape that bracket — it leads a line too — and then it stops
			// disqualifying anything, which is the loop that let
			// FuzzRoundTrip through twice. Skipping it escapes both
			// brackets where only one was strictly needed, and an extra
			// backslash is the cheap direction: it can never fail to
			// prevent a definition, only prevent one that was not coming.
			continue
		}
	}
	return false
}

// opensMath reports whether the line from start is a display-math delimiter,
// asking math.go's own predicate. A paragraph whose line is a bare "$$" pairs
// with a "$$" below it on the next read and becomes TeX, taking the blocks
// between with it (galley#61, from "\\$$\n$$\n0)\n$$"). Escaping the first
// "$" is enough: "\\$$" is not a delimiter.
//
// A bare "$$" with no partner reads back as text anyway, so the backslash is
// sometimes one it did not need; whether a partner exists is a question about
// the rest of the file, and a missing backslash is a block that changes kind.
func opensMath(r []rune, start, end int) bool {
	return mathFence([]byte(string(r[start:end])))
}

// opensRefusedDialect reports whether the line from start reads as one of
// the line-break dialects Parse refuses, asking dialects.go's own predicates:
// a ":::" directive on any line, and a ": " definition on any line but the
// block's first. Without the escape, Serialize writes a file galley then
// refuses to open (galley#48: "\\:::" was written ":::", and a soft break
// after a hard break put ": 0" at the start of a line).
func opensRefusedDialect(r []rune, start, end int) bool {
	line := []byte(string(r[start:end]))
	return bytes.HasPrefix(line, []byte(":::")) || (start > 0 && definitionMarker(line))
}

// opensTableDelimiter reports whether the line from i is a GFM table's
// DELIMITER ROW — the "---|---" under a header. A paragraph that grows one by
// accident silently becomes a TABLE: the delimiter row's meaning depends on
// the line above it, so a hard break followed by "-|" turns the text above
// into a one-column header. Phase 1e made tables real, which makes this rule
// matter more rather than less — before, the file simply refused to load,
// which at least said something. FuzzRoundTrip found it as "0", a hard break,
// and "-|".
//
// A delimiter row is a line of nothing but "-", ":", "|" and whitespace,
// with at least one "-" — measured against goldmark, which accepts ":-:"
// with no pipe at all and rejects ":|" for having no dash.
//
// It is only checked away from the block's FIRST line. A table needs a
// header row above its delimiter, and the first line of a block has no line
// above it — so "-|" standing alone stays exactly as the author wrote it,
// and only a line following a hard break needs the escape.
func opensTableDelimiter(r []rune, start, end int) bool {
	dash := false
	for j := start; j < end; j++ {
		switch r[j] {
		case '-':
			dash = true
		case ':', '|', ' ', '\t', '\r', '\v', '\f':
			// Whitespace of any kind. A lone carriage return is a line
			// ending to goldmark's scanner, so "-\r|" is a delimiter row
			// exactly as "- |" is — the third crasher in this task to come
			// down to that one fact.
		default:
			return false
		}
	}
	return dash
}

func lineEndFrom(r []rune, start int) int {
	for j := start; j < len(r); j++ {
		if r[j] == '\n' {
			return j
		}
	}
	return len(r)
}

func isSpaceOrTab(r rune) bool {
	return r == ' ' || r == '\t'
}

// isHeadingSpace is the whitespace an ATX heading's opening and closing
// sequences accept, which is NOT the same set the list markers accept — a
// lone carriage return counts here and nowhere else.
//
// That asymmetry is measured against goldmark rather than reasoned from the
// spec, because it is a property of the scanner we actually parse with: a
// lone CR ends a line for it, so "#\rx" is a heading and "# a\r#" closes,
// while "-\rx" is not a bullet. A vertical tab or form feed does neither.
// FuzzRoundTrip found the CR case as a heading eroding one "#" per save.
func isHeadingSpace(r rune) bool {
	return isSpaceOrTab(r) || r == '\r'
}

// endsMarker reports whether a block marker occupying the runes before j is
// terminated the way markdown requires: by a space or tab, or by the end of
// the line. "#x" is not a heading and "-x" is not a bullet, but "-" alone
// is a bullet with an empty item.
func endsMarker(r []rune, j, end int) bool {
	return j >= end || isSpaceOrTab(r[j])
}

// runLength counts the run of c starting at i, stopping at end.
func runLength(r []rune, i, end int, c rune) int {
	n := 0
	for i+n < end && r[i+n] == c {
		n++
	}
	return n
}

// opensBullet reports whether r[i] is a bullet-list marker: one of "-+*"
// followed by a space, a tab, or the end of the line.
func opensBullet(r []rune, i, end int) bool {
	return endsMarker(r, i+1, end)
}

// opensATXHeading reports whether r[i] starts an ATX heading: one to six
// '#' followed by a space, a tab, or the end of the line. Seven is not a
// heading, and must not be escaped.
func opensATXHeading(r []rune, i, end int) bool {
	n := runLength(r, i, end, '#')
	return n <= 6 && (i+n >= end || isHeadingSpace(r[i+n]))
}

// opensThematicBreak reports whether the line from i is a thematic break:
// three or more of the same character from "-_*", with nothing else on the
// line but spaces and tabs. The spaced form matters — "_ _ _" is a
// thematic break, and none of its underscores is flanking, so the inline
// rules above leave every one of them bare.
//
// A lone carriage return is whitespace here too, as it is in a heading:
// goldmark's isThematicBreak skips util.IsSpace, which counts it, so
// "--\r-" is a rule. FuzzRoundTrip found it as a paragraph holding that text
// that came back as a rule.
func opensThematicBreak(r []rune, i, end int) bool {
	c, n := r[i], 0
	for j := i; j < end; j++ {
		switch {
		case r[j] == c:
			n++
		case isHeadingSpace(r[j]):
		default:
			return false
		}
	}
	return n >= 3
}

// opensSetextRule reports whether the line from i is a run of '=' or '-'
// with only trailing spaces after it. Such a line underlines the paragraph
// line ABOVE it into a setext heading, so unlike every other rule here it
// is about a line that is not the first of its block: within a tight list
// item, renderBlocksTight joins a paragraph to the next block with a single
// newline and no blank line between them.
func opensSetextRule(r []rune, i, end int) bool {
	c := r[i]
	j := i + runLength(r, i, end, c)
	for ; j < end; j++ {
		if !isSpaceOrTab(r[j]) {
			return false
		}
	}
	return true
}

// opensCodeFence reports whether r[i] starts a tilde code fence: three or
// more '~'. The backtick fence needs no rule of its own — needsEscapeAt
// escapes every '`' unconditionally, since one alone opens a code span.
func opensCodeFence(r []rune, i, end int) bool {
	return runLength(r, i, end, '~') >= 3
}

// opensOrderedList reports whether the "." or ")" at r[i] closes an
// ordered-list marker that started at lineStart: one to nine digits, then
// this delimiter, then a space, a tab, or the end of the line. Ten digits
// is past CommonMark's limit and is ordinary text.
func opensOrderedList(r []rune, i, lineStart, end int) bool {
	if r[i] != '.' && r[i] != ')' {
		return false
	}
	if n := i - lineStart; n < 1 || n > 9 {
		return false
	}
	for j := lineStart; j < i; j++ {
		if r[j] < '0' || r[j] > '9' {
			return false
		}
	}
	return endsMarker(r, i+1, end)
}

// closesHeading reports whether the '#' at r[i] would be read as an ATX
// heading's CLOSING SEQUENCE rather than as content. Markdown lets a
// heading be written "# text #", and strips that trailing run — so a
// heading whose text genuinely ends in '#' loses one on every save, which
// is the slowest and nastiest shape a round-trip bug can take: no single
// save looks wrong.
//
// CommonMark's conditions are exact, and being exact matters in both
// directions here. The run must be preceded by a space or tab, or be the
// whole content — "a#" is already content, and escaping it would be noise
// — and it may be followed only by whitespace, so "### x" leading a
// heading is content too. Escaping the FIRST '#' of the run is enough to
// stop the entire run from closing.
//
// A heading is one line by construction, so the end of the plan is the end
// of the line.
func closesHeading(r []rune, i int, heading bool) bool {
	if !heading || r[i] != '#' {
		return false
	}
	if i > 0 && !isHeadingSpace(r[i-1]) {
		return false
	}
	j := i + runLength(r, i, len(r), '#')
	for ; j < len(r); j++ {
		if !isHeadingSpace(r[j]) {
			return false
		}
	}
	return true
}
