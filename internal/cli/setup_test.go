package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subaud-tools/galley/skills"
	"github.com/subaud-tools/tools-common/setupbundle"
	commonskills "github.com/subaud-tools/tools-common/skills"
)

func TestSetupBundleIsBuildOnlyAndShipsInstalledSkill(t *testing.T) {
	home := t.TempDir()
	for _, key := range []string{"HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"} {
		t.Setenv(key, home)
	}
	for _, key := range []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"} {
		t.Setenv(key, "")
	}
	dest := filepath.Join(t.TempDir(), "galley_setup.tar.gz")
	var out, errw bytes.Buffer
	args := []string{"setup-bundle", "--version", "1.2.3-rc.4", "--out", dest}
	if code := dispatch(args, &out, &errw); code != 0 {
		t.Fatalf("setup-bundle exit %d: %s %s", code, &out, &errw)
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("build touched user state: %v %v", entries, err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := setupbundle.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Tool != "galley" || bundle.Version != "1.2.3-rc.4" {
		t.Fatalf("identity: %s %s", bundle.Tool, bundle.Version)
	}
	body, err := skills.FS.ReadFile("reviewing-a-document/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Files) != 1 || !bytes.Equal(bundle.Files["reviewing-a-document/SKILL.md"], body) {
		t.Fatal("archive must contain only the embedded skill")
	}
	manifest := string(bundle.Manifest)
	if !strings.Contains(manifest, "packages.integration.") || strings.Contains(manifest, "packages.galley.") {
		t.Fatal("bundle must bind exclusively through packages.integration")
	}
	for _, forbidden := range []string{".download]", ".service]", "packages =", "/Users/"} {
		if strings.Contains(manifest, forbidden) {
			t.Fatalf("unexpected %s in manifest", forbidden)
		}
	}
	for agent, target := range commonskills.UserTargets() {
		if !strings.Contains(manifest, target+"/reviewing-a-document/SKILL.md") {
			t.Fatalf("missing %s target", agent)
		}
	}
	args = []string{"skills", "install", "--agent", "claude-code"}
	if code := dispatch(args, &out, &errw); code != 0 {
		t.Fatalf("skills exit %d: %s %s", code, &out, &errw)
	}
	installed, err := os.ReadFile(filepath.Join(home, ".claude/skills/reviewing-a-document/SKILL.md"))
	if err != nil || !bytes.Equal(installed, bundle.Files["reviewing-a-document/SKILL.md"]) {
		t.Fatalf("installed and bundled skill differ: %v", err)
	}
}
