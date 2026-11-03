package docmodel

import "testing"

func TestConstructionAndFieldAccess(t *testing.T) {
	doc := Doc{
		Blocks: []Block{
			{
				Kind:    Heading,
				Attrs:   map[string]string{"level": "1"},
				Inlines: []Inline{{Text: "Title"}},
			},
			{
				Kind: CodeBlock,
				Attrs: map[string]string{
					"language": "go",
				},
				Text: "package main\n",
			},
			{
				Kind: Image,
				Attrs: map[string]string{
					"src": "diagram.png",
					"alt": "a diagram",
				},
			},
		},
	}

	if len(doc.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d", len(doc.Blocks))
	}
	if doc.Blocks[0].Kind != Heading || doc.Blocks[0].Attrs["level"] != "1" {
		t.Fatalf("heading block wrong: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != CodeBlock || doc.Blocks[1].Text != "package main\n" {
		t.Fatalf("code block wrong: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Attrs["src"] != "diagram.png" || doc.Blocks[2].Attrs["alt"] != "a diagram" {
		t.Fatalf("image block wrong: %+v", doc.Blocks[2])
	}
}

func TestInlineHas(t *testing.T) {
	in := Inline{
		Text: "hello",
		Marks: []Mark{
			{Kind: Bold},
			{Kind: Link, Attrs: map[string]string{"href": "https://example.com"}},
		},
	}

	if !in.Has(Bold) {
		t.Fatal("want Has(Bold) true")
	}
	if !in.Has(Link) {
		t.Fatal("want Has(Link) true")
	}
	if in.Has(Italic) {
		t.Fatal("want Has(Italic) false")
	}
	if in.Has(Code) {
		t.Fatal("want Has(Code) false on an Inline with no marks at all matching")
	}
}

func TestInlineHasOnEmptyMarks(t *testing.T) {
	in := Inline{Text: "plain"}
	if in.Has(Bold) {
		t.Fatal("want Has false when Marks is nil")
	}
}

func TestInlineAttr(t *testing.T) {
	in := Inline{
		Text: "click here",
		Marks: []Mark{
			{Kind: Link, Attrs: map[string]string{"href": "https://example.com"}},
			{Kind: Ins, Attrs: map[string]string{"author": "user", "at": "2026-08-02T10:00:00Z"}},
		},
	}

	if got := in.Attr(Link, "href"); got != "https://example.com" {
		t.Fatalf("want href https://example.com, got %q", got)
	}
	if got := in.Attr(Ins, "author"); got != "user" {
		t.Fatalf("want author user, got %q", got)
	}
	if got := in.Attr(Ins, "at"); got != "2026-08-02T10:00:00Z" {
		t.Fatalf("want at 2026-08-02T10:00:00Z, got %q", got)
	}
	// mark not present at all
	if got := in.Attr(Bold, "anything"); got != "" {
		t.Fatalf("want empty string for absent mark, got %q", got)
	}
	// mark present but key not set
	if got := in.Attr(Link, "title"); got != "" {
		t.Fatalf("want empty string for absent key, got %q", got)
	}
}

func TestEqualIdenticalDocs(t *testing.T) {
	a := Doc{Blocks: []Block{
		{Kind: Paragraph, Inlines: []Inline{{Text: "hi", Marks: []Mark{{Kind: Bold}}}}},
	}}
	b := Doc{Blocks: []Block{
		{Kind: Paragraph, Inlines: []Inline{{Text: "hi", Marks: []Mark{{Kind: Bold}}}}},
	}}
	if !Equal(a, b) {
		t.Fatal("want identical docs equal")
	}
}

func TestEqualNilVsEmptyNormalized(t *testing.T) {
	// A doc built by hand with nil slices/maps must compare equal to a doc
	// with the same semantic content but explicit empty slices/maps — this
	// is how a parsed doc (which may produce empty maps/slices) compares
	// against a hand-built doc (which tends to leave them nil).
	nilDoc := Doc{
		Blocks: []Block{
			{
				Kind: Paragraph,
				Inlines: []Inline{
					{Text: "hi", Marks: nil},
				},
				Children: nil,
			},
		},
	}
	emptyDoc := Doc{
		Blocks: []Block{
			{
				Kind:  Paragraph,
				Attrs: map[string]string{},
				Inlines: []Inline{
					{Text: "hi", Marks: []Mark{}},
				},
				Children: []Block{},
			},
		},
	}
	if !Equal(nilDoc, emptyDoc) {
		t.Fatal("want nil and empty slices/maps to compare equal")
	}
}

func TestEqualDiffersOnMarkAttrs(t *testing.T) {
	a := Doc{Blocks: []Block{
		{Kind: Paragraph, Inlines: []Inline{
			{Text: "hi", Marks: []Mark{{Kind: Ins, Attrs: map[string]string{"author": "user"}}}},
		}},
	}}
	b := Doc{Blocks: []Block{
		{Kind: Paragraph, Inlines: []Inline{
			{Text: "hi", Marks: []Mark{{Kind: Ins, Attrs: map[string]string{"author": "agent"}}}},
		}},
	}}
	if Equal(a, b) {
		t.Fatal("want docs with differing mark attrs to compare unequal")
	}
}

func TestEqualDiffersOnBlockKind(t *testing.T) {
	a := Doc{Blocks: []Block{{Kind: Paragraph}}}
	b := Doc{Blocks: []Block{{Kind: Heading}}}
	if Equal(a, b) {
		t.Fatal("want docs with differing block kinds to compare unequal")
	}
}

func TestEqualDiffersOnChildOrder(t *testing.T) {
	a := Doc{Blocks: []Block{
		{Kind: BulletList, Children: []Block{
			{Kind: ListItem, Children: []Block{{Kind: Paragraph, Inlines: []Inline{{Text: "one"}}}}},
			{Kind: ListItem, Children: []Block{{Kind: Paragraph, Inlines: []Inline{{Text: "two"}}}}},
		}},
	}}
	b := Doc{Blocks: []Block{
		{Kind: BulletList, Children: []Block{
			{Kind: ListItem, Children: []Block{{Kind: Paragraph, Inlines: []Inline{{Text: "two"}}}}},
			{Kind: ListItem, Children: []Block{{Kind: Paragraph, Inlines: []Inline{{Text: "one"}}}}},
		}},
	}}
	if Equal(a, b) {
		t.Fatal("want docs with reordered children to compare unequal")
	}
}

// TestWalkVisitsNestedListItemsInOrderWithPaths builds:
//
//	[0] paragraph "top"
//	[1] bulletList
//	    [1,0] listItem
//	        [1,0,0] paragraph "a"
//	    [1,1] listItem
//	        [1,1,0] paragraph "b"
//	        [1,1,1] bulletList
//	            [1,1,1,0] listItem
//	                [1,1,1,0,0] paragraph "nested"
//
// and asserts Walk visits every block depth-first, in document order, with
// the path matching the block's position in the tree.
func TestWalkVisitsNestedListItemsInOrderWithPaths(t *testing.T) {
	doc := Doc{
		Blocks: []Block{
			{Kind: Paragraph, Inlines: []Inline{{Text: "top"}}},
			{
				Kind: BulletList,
				Children: []Block{
					{
						Kind: ListItem,
						Children: []Block{
							{Kind: Paragraph, Inlines: []Inline{{Text: "a"}}},
						},
					},
					{
						Kind: ListItem,
						Children: []Block{
							{Kind: Paragraph, Inlines: []Inline{{Text: "b"}}},
							{
								Kind: BulletList,
								Children: []Block{
									{
										Kind: ListItem,
										Children: []Block{
											{Kind: Paragraph, Inlines: []Inline{{Text: "nested"}}},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	}

	type visit struct {
		path string
		kind BlockKind
		text string
	}
	pathKey := func(path []int) string {
		s := ""
		for i, p := range path {
			if i > 0 {
				s += ","
			}
			s += string(rune('0' + p))
		}
		return s
	}

	var got []visit
	Walk(doc, func(path []int, b *Block) {
		text := ""
		if len(b.Inlines) > 0 {
			text = b.Inlines[0].Text
		}
		// copy path since the slice may be reused across calls
		p := append([]int(nil), path...)
		got = append(got, visit{path: pathKey(p), kind: b.Kind, text: text})
	})

	want := []visit{
		{path: "0", kind: Paragraph, text: "top"},
		{path: "1", kind: BulletList},
		{path: "1,0", kind: ListItem},
		{path: "1,0,0", kind: Paragraph, text: "a"},
		{path: "1,1", kind: ListItem},
		{path: "1,1,0", kind: Paragraph, text: "b"},
		{path: "1,1,1", kind: BulletList},
		{path: "1,1,1,0", kind: ListItem},
		{path: "1,1,1,0,0", kind: Paragraph, text: "nested"},
	}

	if len(got) != len(want) {
		t.Fatalf("want %d visits, got %d: %+v", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("visit %d: want %+v, got %+v\nfull got: %+v", i, want[i], got[i], got)
		}
	}
}

func TestWalkAllowsMutationThroughPointer(t *testing.T) {
	doc := Doc{Blocks: []Block{{Kind: Paragraph, Inlines: []Inline{{Text: "before"}}}}}
	Walk(doc, func(_ []int, b *Block) {
		if b.Kind == Paragraph {
			b.Attrs = map[string]string{"touched": "yes"}
		}
	})
	if doc.Blocks[0].Attrs["touched"] != "yes" {
		t.Fatalf("want mutation through *Block to reach the original doc, got %+v", doc.Blocks[0])
	}
}
