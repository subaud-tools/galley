package render

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/mermaidkit"
)

// themesDir is where themes live: ~/.config/galley/themes (XDG-aware).
func themesDir() string { return filepath.Join(tools.ConfigDir("galley"), "themes") }

// LoadTheme reads the theme folder of that name, filling anything it leaves
// out from the base theme.
func LoadTheme(name string) (mermaidkit.Theme, error) {
	if !plainName(name) {
		return mermaidkit.Theme{}, fmt.Errorf("theme %q: a theme is named by its folder in %s, not a path", name, themesDir())
	}
	return mermaidkit.ReadTheme(name, filepath.Join(themesDir(), name))
}

// plainName reports whether n names an entry directly inside a folder: not
// empty, not "." or "..", and without a path separator — so a theme name
// cannot reach outside the themes folder it is joined onto.
func plainName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, `/\`)
}

// ThemeFor is the theme the document's project chooses: the nearest
// .galley/config.json from the document's folder upward, or the base theme
// when there is none.
func ThemeFor(docPath string) (mermaidkit.Theme, error) {
	abs, err := filepath.Abs(docPath)
	if err != nil {
		return mermaidkit.Theme{}, err
	}
	for dir := filepath.Dir(abs); ; dir = filepath.Dir(dir) {
		cfg := filepath.Join(dir, ".galley", "config.json")
		raw, err := os.ReadFile(cfg)
		if err == nil {
			var c struct {
				Theme string `json:"theme"`
			}
			if err := json.Unmarshal(raw, &c); err != nil {
				return mermaidkit.Theme{}, fmt.Errorf("%s: %w", cfg, err)
			}
			if c.Theme == "" {
				return mermaidkit.BaseTheme(), nil
			}
			return LoadTheme(c.Theme)
		}
		if parent := filepath.Dir(dir); parent == dir {
			return mermaidkit.BaseTheme(), nil
		}
	}
}
