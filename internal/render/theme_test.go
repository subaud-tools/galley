package render

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subaud-tools/tools-common/mermaidkit"
)

// configHome points the theme folder at a temp dir and returns it.
func configHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("GALLEY_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", tmp)
	return tmp
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeTheme(t *testing.T, home, name, themeJSON string) string {
	t.Helper()
	dir := filepath.Join(home, "galley", "themes", name)
	writeFile(t, filepath.Join(dir, "theme.json"), themeJSON)
	writeFile(t, filepath.Join(dir, "logo-light.svg"), "<svg>light</svg>")
	writeFile(t, filepath.Join(dir, "logo-dark.svg"), "<svg>dark</svg>")
	return dir
}

func TestThemeForFindsConfigUpward(t *testing.T) {
	home := configHome(t)
	writeTheme(t, home, "acme", `{"label":"Acme"}`)
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, ".galley", "config.json"), `{"theme":"acme"}`)
	doc := filepath.Join(repo, "docs", "sub", "a.md")
	writeFile(t, doc, "# A\n")
	got, err := ThemeFor(doc)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "acme" {
		t.Fatalf("Name = %q, want acme", got.Name)
	}
}

func TestThemeForWithoutConfigIsBase(t *testing.T) {
	configHome(t)
	doc := filepath.Join(t.TempDir(), "a.md")
	writeFile(t, doc, "# A\n")
	got, err := ThemeFor(doc)
	if err != nil {
		t.Fatal(err)
	}
	base := mermaidkit.BaseTheme()
	if got.Name != base.Name || got.Light != base.Light {
		t.Fatalf("got %q %+v, want base %q %+v", got.Name, got.Light, base.Name, base.Light)
	}
}

func TestLoadThemeUnknownNameErrors(t *testing.T) {
	home := configHome(t)
	_, err := LoadTheme("nope")
	if err == nil {
		t.Fatal("want an error")
	}
	dir := filepath.Join(home, "galley", "themes", "nope")
	if !strings.Contains(err.Error(), `theme "nope"`) || !strings.Contains(err.Error(), dir) {
		t.Fatalf("err = %v, want it to name the theme and %s", err, dir)
	}
}

// A theme name is a folder name in the themes directory and nothing else: a
// project config cannot point galley at a folder outside it.
func TestThemeNameCannotLeaveTheThemesFolder(t *testing.T) {
	home := configHome(t)
	// A loadable theme.json where "../x" would land if it were joined as
	// given, so an unchecked name loads instead of failing by accident.
	writeFile(t, filepath.Join(home, "galley", "x", "theme.json"), `{"label":"outside"}`)
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, ".galley", "config.json"), `{"theme":"../x"}`)
	doc := filepath.Join(repo, "a.md")
	writeFile(t, doc, "# A\n")
	_, err := ThemeFor(doc)
	if err == nil || !strings.Contains(err.Error(), `theme "../x"`) {
		t.Fatalf("err = %v, want an error naming the theme", err)
	}
}
