package serve

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// browser is what a page under review holds: the cookie and its own origin, and
// never the token. It answers each request's status and body.
type browser struct {
	r      *running
	cookie *http.Cookie
}

func signIn(t *testing.T, r *running) *browser {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(r.base + "/?t=" + r.token)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if strings.Contains(resp.Header.Get("Location"), r.token) {
		t.Fatalf("the sign-in redirect carries the token: %q", resp.Header.Get("Location"))
	}
	cookies := resp.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("signing in set %d cookies", len(cookies))
	}
	if !cookies[0].HttpOnly {
		t.Fatalf("a page can read the cookie %s: it is not HttpOnly", cookies[0].Name)
	}
	return &browser{r: r, cookie: cookies[0]}
}

func (b *browser) do(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, b.r.base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(b.cookie)
	req.Header.Set("Origin", b.r.base)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(raw)
}

// A page under review must not be able to hand the server a command: it holds
// the cookie, so the cookie alone can't open a document.
func TestCookieCannotOpenADocumentWithACommand(t *testing.T) {
	r := agentServer(t)
	b := signIn(t, r)
	dir := t.TempDir()
	doc := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n")
	marker := filepath.Join(dir, "ran")

	body := `{"path":` + strconv.Quote(doc) + `,"on_revise":` + strconv.Quote("touch "+marker) + `}`
	code, said := b.do(t, http.MethodPost, "/api/docs", body)
	if code != http.StatusForbidden {
		t.Errorf("a cookie-only open answered %d, want 403", code)
	}
	if strings.Count(strings.TrimSpace(said), "\n") != 0 {
		t.Errorf("the refusal is not one line: %q", said)
	}
	for _, id := range r.ids(t) {
		b.do(t, http.MethodPost, "/api/docs/"+id+"/_galley/revise", "{}")
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Error("the page's command ran")
	}
	if ids := r.ids(t); len(ids) != 0 {
		t.Errorf("the document opened: %v", ids)
	}
}

// One GET, which an <img> in a markdown document can make, must not claim every
// unowned review.
func TestCookieCannotClaimReviewsWithAWait(t *testing.T) {
	r := agentServer(t)
	b := signIn(t, r)
	a := r.open(t, writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n"), DocOptions{})

	code, _ := b.do(t, http.MethodGet, "/api/agent/wait?"+url.Values{"session": {"z"}, "root": {"/"}, "timeout": {"1"}}.Encode(), "")
	if code != http.StatusForbidden {
		t.Errorf("a cookie-only wait answered %d, want 403", code)
	}
	if owner := r.ownerOf(t, a.ID); owner != "" {
		t.Errorf("the wait claimed the review for %q", owner)
	}
}

// Every other control route takes the header too, and a request with the header
// still gets through.
func TestControlRoutesRefuseTheCookieAndTakeTheHeader(t *testing.T) {
	r := agentServer(t)
	b := signIn(t, r)
	a := r.open(t, writeTestFile(t, filepath.Join(t.TempDir(), "a.md"), "# A\n\nHi.\n"), DocOptions{})
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/docs", ""},
		{http.MethodDelete, "/api/docs/" + a.ID, ""},
		{http.MethodGet, "/api/agent/status?session=z", ""},
		{http.MethodPost, "/api/agent/report", `{"session":"z","event":"delivered"}`},
	} {
		if code, _ := b.do(t, tc.method, tc.path, tc.body); code != http.StatusForbidden {
			t.Errorf("%s %s with the cookie answered %d, want 403", tc.method, tc.path, code)
		}
	}
	if code := r.call(t, http.MethodGet, "/api/agent/status?session=z", nil, nil); code != http.StatusOK {
		t.Errorf("status with the header answered %d", code)
	}
	if code := r.call(t, http.MethodDelete, "/api/docs/"+a.ID, nil, nil); code != http.StatusNoContent {
		t.Errorf("a close with the header answered %d", code)
	}
}

// The header rule rests on this: a same-origin page can read the shell's DOM and
// every route its cookie reaches, and none of them may hold the token.
func TestTheTokenIsNowhereAPageCanRead(t *testing.T) {
	r := agentServer(t)
	b := signIn(t, r)
	dir := t.TempDir()
	page := writeTestFile(t, filepath.Join(dir, "page.html"), "<!doctype html><html><body><h1>T</h1><p>Hi.</p></body></html>\n")
	md := writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n")
	for _, a := range []OpenAnswer{r.open(t, page, DocOptions{}), r.open(t, md, DocOptions{})} {
		base := "/api/docs/" + a.ID
		for _, route := range []string{
			"/", "/_galley/pending", "/_galley/revise", "/_galley/rev", "/_galley/saved", "/_galley/pages",
			"/_galley/versions", "/_galley/preview/", "/_galley/render", "/_galley/download/md",
			"/_galley/share/html", "/_galley/share/md", "/_galley/editor.js",
		} {
			if _, said := b.do(t, http.MethodGet, base+route, ""); strings.Contains(said, r.token) {
				t.Errorf("%s holds the token", route)
			}
		}
		if code, said := b.do(t, http.MethodGet, base+"/", ""); code != http.StatusOK || strings.Contains(said, r.token) {
			t.Errorf("the shell answered %d, or holds the token", code)
		}
	}
	if _, said := b.do(t, http.MethodGet, "/api/poll", ""); strings.Contains(said, r.token) {
		t.Error("/api/poll holds the token")
	}
}

// A session with no channel takes nothing: the claim is for a session that can
// hear the document.
func TestClaimNeedsALiveSession(t *testing.T) {
	r := agentServer(t)
	dir := t.TempDir()
	a := r.open(t, writeTestFile(t, filepath.Join(dir, "a.md"), "# A\n\nHi.\n"), DocOptions{})
	if _, code := r.agentWait(t, "z", dir, 1); code != http.StatusNoContent {
		t.Fatalf("the wait answered %d", code)
	}
	if owner := r.ownerOf(t, a.ID); owner != "" {
		t.Fatalf("a session with no channel claimed the review as %q", owner)
	}
}
