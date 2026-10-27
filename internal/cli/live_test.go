package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The live directory is where every galley build on the machine meets: an
// editor started by an older galley and a channel from a newer one must find
// each other there, so its place is $GALLEY_LIVE_DIR, else ~/.galley/live —
// not tools-common's state dir.
func TestTheLiveDirIsGalleysOwn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GALLEY_LIVE_DIR", "")
	if got, want := live().Dir, filepath.Join(home, ".galley", "live"); got != want {
		t.Fatalf("live dir = %q, want %q", got, want)
	}
	dir := filepath.Join(t.TempDir(), "elsewhere")
	t.Setenv("GALLEY_LIVE_DIR", dir)
	if got := live().Dir; got != dir {
		t.Fatalf("live dir = %q, want $GALLEY_LIVE_DIR %q", got, dir)
	}
}

// An advert written by galley 0.19.0's registry, byte for byte, is found and
// claimed: same file name, same keys, the claim lock beside it.
func TestAnAdvertFromTheOldRegistryIsFoundAndClaimed(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GALLEY_LIVE_DIR", dir)
	doc := filepath.Join(t.TempDir(), "doc.md")
	raw := `{
  "v": 1,
  "url": "http://127.0.0.1:9811/",
  "room": "doc-0123456789abcdef",
  "page": "` + doc + `",
  "pid": ` + strconv.Itoa(os.Getpid()) + `
}
`
	if err := os.WriteFile(filepath.Join(dir, "doc-0123456789abcdef.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := live().List()
	if err != nil || len(entries) != 1 || entries[0].Page != doc || entries[0].Owner != "" {
		t.Fatalf("List = %+v, %v; want the one unowned advert for %s", entries, err, doc)
	}
	ok, err := live().Claim("doc-0123456789abcdef", "session-new")
	if err != nil || !ok {
		t.Fatalf("Claim = %v, %v; want claimed", ok, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "doc-0123456789abcdef.lock")); err != nil {
		t.Fatalf("no sibling claim lock: %v", err)
	}
	entries, _ = live().List()
	if len(entries) != 1 || entries[0].Owner != "session-new" {
		t.Fatalf("after Claim, List = %+v; want owner session-new", entries)
	}
}
