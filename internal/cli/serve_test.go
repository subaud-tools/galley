package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/galley/internal/serve"
)

// `galley serve` runs pageserve's server in this process until --stop.
func TestServeRunsUntilStopped(t *testing.T) {
	t.Setenv("GALLEY_HOME", t.TempDir())
	t.Setenv("GALLEY_LIVE_DIR", t.TempDir())

	done := make(chan int, 1)
	go func() {
		_, _, code := galleyCLI(t, "serve")
		done <- code
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := serve.Running(); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("galley serve never wrote its entry")
		}
		time.Sleep(10 * time.Millisecond)
	}
	out, _, code := galleyCLI(t, "serve", "--stop")
	if code != 0 || !strings.Contains(out, "stopped") {
		t.Fatalf("serve --stop: exit %d: %s", code, out)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("galley serve exited %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("galley serve did not stop")
	}
}
