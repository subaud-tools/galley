package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/subaud-tools/tools-common/setupbundle"
)

// This fixture never downloads a tool, runs a hook or applies a service.
func TestSetupRegistrationConvergesWithPublicKempt(t *testing.T) {
	kempt := os.Getenv("KEMPT_TEST_BIN")
	if kempt == "" {
		t.Skip("set KEMPT_TEST_BIN to released kempt >= 0.13.0")
	}
	home, source := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	for _, key := range []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"} {
		t.Setenv(key, filepath.Join(home, key))
	}
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	dest := filepath.Join(source, "setup.tar.gz")
	var out bytes.Buffer
	if err := setupCommand().Run([]string{"--version", "1.2.3", "--out", dest}, &out, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := setupbundle.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	write := func(path string, body []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest := filepath.Join(source, "kempt.toml")
	for _, line := range strings.Split(string(bundle.Manifest), "\n") {
		if strings.HasPrefix(line, "[") && line != "[kempt]" && line != "[[packages.integration.json-merge]]" && line != "[[packages.integration.managed-file]]" {
			t.Fatalf("refusing non-configuration fixture: %s", line)
		}
	}
	// Managed files require a verified download binding; this standalone fixture
	// exercises only registration convergence, never a download or installation.
	registrations, _, _ := strings.Cut(string(bundle.Manifest), "\n[[packages.integration.managed-file]]")
	write(manifest, []byte(registrations))
	settings := filepath.Join(home, ".claude/settings.json")
	channels := filepath.Join(home, ".pi/agent/channels.json")
	write(settings, []byte(`{"extraKnownMarketplaces":{"galley":{"source":"retired"},"private":{"source":"keep"}},"enabledPlugins":{"galley@galley":true,"private@private":true},"private":{"keep":true}}`))
	write(channels, []byte(`{"channelServers":{"private":{"command":"private"}},"packages":["private"]}`))
	expected := map[string]any{
		"extraKnownMarketplaces": map[string]any{"private": map[string]any{"source": "keep"}, "subaud-tools": map[string]any{"source": map[string]any{"source": "github", "repo": "subaud-tools/plugins"}, "autoUpdate": true}},
		"enabledPlugins":         map[string]any{"private@private": true, "galley@subaud-tools": true},
		"private":                map[string]any{"keep": true},
	}
	var expectedChannels map[string]any
	if err := json.Unmarshal([]byte(`{"channelServers":{"private":{"command":"private"},"galley":{"command":"galley","args":["channel", "--scope", "."]}},"packages":["private"]}`), &expectedChannels); err != nil {
		t.Fatal(err)
	}
	var previous []byte
	for range 2 {
		cmd := exec.Command(kempt, "apply", "-manifest", manifest, "-yes")
		if result, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("isolated kempt: %v: %s", err, result)
		}
		for path, want := range map[string]map[string]any{settings: expected, channels: expectedChannels} {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s: got %#v, want %#v", path, got, want)
			}
		}
		current, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		if previous != nil && !bytes.Equal(current, previous) {
			t.Fatal("repeat changed settings")
		}
		previous = current
	}
}
