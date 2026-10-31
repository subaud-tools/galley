package serve

import (
	"net/http"
	"path"
	"strings"
)

// preview.go serves the LIVE page and its assets to the split-pane preview
// iframe. Where serveSibling (editassets.go) exists so a markdown figure
// resolves, this exists so a page under review renders as itself: the reviewer
// sees page.html with its stylesheets, scripts, fonts and images, re-fetched
// after every projection.
//
// It reuses serveSibling's containment WHOLESALE, because the threat is the
// same: the page's directory is also, very often, a source tree, and the port
// is a fixed default any web page in the user's browser can reach. So:
//
//   - GET AND HEAD ONLY. A 404 for anything else, not a 405 — a refusal and
//     an absence are byte-identical, so the route never confirms it exists.
//   - INSIDE THE PAGE'S DIRECTORY, enforced by the KERNEL. Every read goes
//     through EditServer.pageRoot, an *os.Root opened once at construction
//     (see NewEditPage). os.Root re-resolves each component at open time, so
//     traversal and symlink escape are refused without string arithmetic.
//   - THE FILE ITSELF IS NOT A SYMLINK — Lstat, then Open through the root,
//     both checked for a regular file, exactly as serveSibling does.
//   - AN EXTENSION ALLOWLIST, not a denylist — previewTypes. A page legitimately
//     references more kinds of file than a figure does (css, js, fonts, source
//     maps), so the allowlist is wider than assetTypes, but it is still an
//     allowlist: an unknown extension is a 404, never served as an arbitrary
//     type.
//
// This route is only live in page mode; in markdown mode s.pageRoot is nil and
// every request here is a 404 like any other absence.

// previewTypes is the allowlist for the preview: extension -> Content-Type. It
// is wider than assetTypes because a page references its own stylesheets,
// scripts, fonts and source maps, not only figures. Keys are lower-case; the
// lookup folds the request's extension to match. An unknown extension is a 404
// — this never serves an arbitrary type.
var previewTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".avif":  "image/avif",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".map":   "application/json",
}

// servePreview answers a request for the live page or one of its assets, or
// 404s. It mirrors serveSibling's containment exactly, over pageRoot instead of
// root, with the wider previewTypes allowlist.
func (s *EditServer) servePreview(w http.ResponseWriter, r *http.Request) {
	// Only live in page mode. Markdown mode has no page to preview: pageRoot is
	// nil and this is a plain absence.
	if !s.pageMode || s.pageRoot == nil {
		http.NotFound(w, r)
		return
	}
	// HEAD is allowed for free via http.ServeContent; everything else is a 404,
	// not a 405 — see serveSibling.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}

	name, ok := previewName(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	ctype, ok := previewTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		http.NotFound(w, r)
		return
	}

	// Lstat, not Stat: the extension above names the file the URL asked for, and
	// a symlink is a file whose name and bytes disagree. It also has to be a
	// regular file. See serveSibling.
	fi, err := s.pageRoot.Lstat(name)
	if err != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	// Open through the root as well rather than trusting the Lstat: os.Root
	// re-resolves every component in the kernel at open time.
	f, err := s.pageRoot.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The browser refuses to embed any preview response from another origin,
	// which closes the existence/timing oracle over the page's directory exactly
	// as serveSibling does. same-origin does NOT block the same-origin iframe
	// that loads the preview, so the reviewer's view is unaffected.
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	// An SVG can carry <script>, and navigated to directly it would run in
	// galley's origin — reaching the mutating endpoints with the browser's
	// cookie. The sandbox loads it into an opaque origin instead. SVG ONLY:
	// on .html this would break the page's own scripts inside the iframe.
	if ctype == "image/svg+xml" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	}
	// The live page changes with every projection; a cached asset is one that
	// silently stops matching the document.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

// previewName strips the /_galley/preview/ prefix and returns the root-relative
// name os.Root takes, or reports that the request names none. Empty (a request
// for the prefix itself) defaults to index.html. Containment is the kernel's
// job — this is spelling only, exactly as siblingName is: path.Clean folds away
// "." and any ".." the URL carried, and the result is checked for an empty
// segment or a Windows separator os.Root's slash-based resolution would miss.
func previewName(urlPath string) (string, bool) {
	rel := strings.TrimPrefix(urlPath, "/_galley/preview/")
	if rel == "" {
		rel = "index.html"
	}
	clean := path.Clean("/" + rel)
	name := strings.TrimPrefix(clean, "/")
	if name == "" || name == "." {
		return "", false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == "" || seg == ".." || strings.Contains(seg, `\`) {
			return "", false
		}
	}
	return name, true
}
