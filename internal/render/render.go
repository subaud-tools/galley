// Package render turns a markdown document into one self-contained, branded
// HTML page: the file Share's Download HTML and Share HTML hand over and the
// preview tab shows. The page itself is tools-common's mermaidkit.Render;
// this package removes first what galley's page must not show (review
// instructions and highlights, front matter) and finds the theme a project
// chooses. It knows nothing about the server; internal/serve calls it with
// the document and the embedded mermaid.js.
package render

import (
	"github.com/subaud-tools/galley/internal/docmodel"
	"github.com/subaud-tools/galley/internal/markdown"
	"github.com/subaud-tools/galley/internal/suggest"
	"github.com/subaud-tools/tools-common/mermaidkit"
)

// mermaidGlobal is the name web/package.json's build:mermaid gives the
// bundle (--global-name), which the page reads to draw diagrams.
const mermaidGlobal = "galleyMermaid"

// ImageTypes is the figures galley shows from beside a document: extension
// to Content-Type. The editor serves these as siblings, and the render embeds
// them, so the two show the same images.
var ImageTypes = mermaidkit.ImageTypes

// Render turns a markdown document into one self-contained HTML page in the
// theme's look. Review instructions and highlights are removed first, front
// matter is not shown, and mermaid.js is inlined only when a diagram needs it.
// An image by relative path is read from docDir and embedded.
func Render(md []byte, t mermaidkit.Theme, mermaidJS []byte, docDir string) ([]byte, error) {
	d, _, err := markdown.Parse(md)
	if err != nil {
		return nil, err
	}
	d = suggest.ClearInstructions(d)
	d.Blocks = dropFrontMatter(d.Blocks)
	return mermaidkit.Render(markdown.Serialize(d), t, mermaidkit.Bundle{JS: mermaidJS, Global: mermaidGlobal}, docDir)
}

func dropFrontMatter(blocks []docmodel.Block) []docmodel.Block {
	out := blocks[:0:0]
	for _, b := range blocks {
		if b.Kind != docmodel.FrontMatter {
			out = append(out, b)
		}
	}
	return out
}
