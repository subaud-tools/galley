package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/tools-common/pageserve"
)

// galley_open is how a session puts a document under review. Refusal and take-up
// are in channel_session_test.go, beside the wakes they decide.

// It hands back an address that signs in a browser with no cookie, opens the
// page, and a second call returns the same document.
func TestOpenReturnsASignedInAddress(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	first := r.open(doc)
	if first.Page != doc || first.Room == "" {
		t.Fatalf("incomplete result %+v", first)
	}
	entry, err := serve.Running()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first.URL, "/api/docs/") || !strings.HasSuffix(first.URL, "t="+entry.Token) {
		t.Fatalf("URL = %q", first.URL)
	}
	for _, u := range []string{first.URL, first.Preview} {
		resp, err := noCookieGet(u)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("a browser with no cookie got %d at %s", resp.StatusCode, u)
		}
	}
	if got := <-r.opened; got != first.URL {
		t.Fatalf("opened %q, want %q", got, first.URL)
	}
	if again := r.open(doc); again.URL != first.URL || again.Room != first.Room {
		t.Fatalf("second open: %+v, then %+v", first, again)
	}
	if rt, ok := serve.FindRuntime(doc); !ok || rt.Owner != "session-me" {
		t.Fatalf("the server says %+v (found %v), want owner session-me", rt, ok)
	}
}

// noCookieGet follows the sign-in redirect as a browser would, with a jar and no
// token header: what someone gets from the address alone.
func noCookieGet(u string) (*http.Response, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return (&http.Client{Jar: jar}).Get(u)
}

// A page opens only when the server says no tab is there to show the review.
func TestOpenOpensAPageOnlyWhenTheServerSaysSo(t *testing.T) {
	for _, tc := range []struct {
		tab   string
		opens bool
	}{{serve.TabOpened, true}, {serve.TabReused, false}} {
		t.Run(tc.tab, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(serve.OpenAnswer{URL: "http://x/api/docs/a/?t=1", Tab: tc.tab})
			}))
			t.Cleanup(server.Close)
			client := pageserve.NewClient(serve.Live(), nil)
			client.Find = func() (pageserve.Entry, error) { return pageserve.Entry{Base: server.URL}, nil }
			ch := pageserve.New(channelSpec(), pageserve.Identity{Session: "s"}, client)
			var opened []string
			ch.Open = func(u string) error { opened = append(opened, u); return nil }
			if _, err := open(context.Background(), ch, "doc.md"); err != nil {
				t.Fatal(err)
			}
			if got := len(opened) == 1; got != tc.opens {
				t.Fatalf("with Tab %q it opened %v", tc.tab, opened)
			}
		})
	}
}

// A review that has ended is not handed back: a fresh one takes its place.
func TestOpenStartsAFreshReviewWhenTheLastOneEnded(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n\nHello.\n")
	r := newRig(t, "session-me", dir)
	first := r.open(doc)
	if err := postApprove(baseOf(first.URL)); err != nil {
		t.Fatal(err)
	}
	second := r.open(doc)
	st, err := reviseState(baseOf(second.URL))
	if err != nil {
		t.Fatal(err)
	}
	if st.Sealed {
		t.Fatal("the fresh review is already sealed")
	}
}

// An ended review that is another live session's is left alone: reported as
// theirs, never stopped.
func TestOpenDoesNotStopAnotherSessionsEndedReview(t *testing.T) {
	dir := t.TempDir()
	doc := writeDoc(t, dir, "doc.md", "# T\n")
	startServer(t)
	theirs := newRig(t, "session-other", dir)
	opened := theirs.open(doc)
	if err := postApprove(baseOf(opened.URL)); err != nil {
		t.Fatal(err)
	}
	text, bad := newRig(t, "session-me", dir).call("galley_open", `{"doc":`+strconvQuote(doc)+`}`)
	if !bad || !strings.Contains(text, "open in session session-other") {
		t.Fatalf("answered %v %q", bad, text)
	}
	if st, err := reviseState(baseOf(opened.URL)); err != nil || !st.Sealed {
		t.Fatalf("another session's review was replaced: %+v, %v", st, err)
	}
}

// The preview address rides beside the review address for a markdown review; a
// page under review has no preview route, and is opened by its content.md.
func TestOpenOfAPageReturnsItsContentFileAndNoPreview(t *testing.T) {
	startServer(t)
	dir := t.TempDir()
	page := writeDoc(t, dir, "post.html", minimalHTML)
	r := newRig(t, "session-me", dir)
	text, bad := r.call("galley_open", `{"doc":`+strconvQuote(page)+`}`)
	if bad {
		t.Fatal(text)
	}
	if strings.Contains(text, `"preview"`) {
		t.Fatalf("a page review's open result carries a preview: %s", text)
	}
	var res openResult
	if err := json.Unmarshal([]byte(text), &res); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(res.Page, string(filepath.Separator)+"content.md") {
		t.Fatalf("Page = %q, want the content.md it serves", res.Page)
	}
	if again := r.open(page); again.Room != res.Room {
		t.Fatalf("second open: %s then %s", res.Room, again.Room)
	}
}

// A file outside the session's folder is opened like any other: the path is this
// session's explicit ask (#68). A relative one is resolved against the channel's
// working directory.
func TestOpenTakesAnyPathTheSessionNames(t *testing.T) {
	startServer(t)
	scope := t.TempDir()
	elsewhere := t.TempDir()
	r := newRig(t, "session-me", scope)
	doc := writeDoc(t, elsewhere, "doc.md", "# T\n")
	if res := r.open(doc); res.Page != doc {
		t.Fatalf("Page = %q", res.Page)
	}
	t.Chdir(elsewhere)
	writeDoc(t, elsewhere, "rel.md", "# R\n")
	res := r.open("rel.md")
	if rt, ok := serve.FindRuntime(filepath.Join(elsewhere, "rel.md")); !ok || rt.Room != res.Room {
		t.Fatalf("relative path did not resolve: %+v, %+v", res, rt)
	}
}

func TestOpenWithNoPathSaysSo(t *testing.T) {
	startServer(t)
	text, bad := newRig(t, "session-me", t.TempDir()).call("galley_open", `{}`)
	if !bad || !strings.Contains(text, "needs a document path") {
		t.Fatalf("answered %v %q", bad, text)
	}
}
