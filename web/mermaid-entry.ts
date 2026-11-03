// The mermaid bundle's entry, shared by every family page tool that draws
// diagrams: copied from tools-common (localweb/page/build/) by the tool's
// build and checked against the version it pins, so edit it there.
//
// It is built as its own bundle, not folded into the page's: mermaid is
// several megabytes, so a page fetches it only on its first diagram, and a
// page without one never pays. Each tool builds it with
//   esbuild mermaid-entry.ts --bundle --minify --format=iife --target=es2019
//     --charset=utf8 --global-name=<tool>Mermaid --outfile=<its assets>/mermaid.js
// and the default export is what --global-name hands to window.<tool>Mermaid,
// the name mermaidkit.Bundle.Global (check.Bundle.Global) carries on the server.
//
// DOMPurify is exported beside it for mermaidkit/check: mermaid sanitizes
// labels with it, and outside a browser it is a stub the checker fills with
// pass-through methods. It resolves to the copy mermaid depends on, so it is
// mermaid's own instance and needs no dependency of the tool's.
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

export default mermaid;
export { DOMPurify };
