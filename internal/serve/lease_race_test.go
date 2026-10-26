package serve

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"sync"
	"testing"
)

// THE LEASE IS SHARED STATE AND reviseMu ONLY EVER GUARDED THE POINTER TO IT.
//
// importDraft took reviseMu, copied `s.handoffLease` — a *handoffLease — and
// let the lock go, then read Baseline and LastImported off the pointee and, at
// the end, handed the same pointer to writeLease, which json.Marshals it. Every
// one of those reads ran with no lock held, while any other caller was writing
// LastImported through the same pointer under the lock. A mutex that guards the
// handle and not the thing it points at guards nothing.
//
// The window's own watcher ticks importDraft every 300ms, so a second caller is
// not hypothetical: it is the product. CI caught it as a race inside
// TestSeveralSavesThroughTheExchangeAreOneRound, whose four saves simply gave a
// tick somewhere to land — which is why this test drives the collision directly
// rather than waiting for the scheduler to be unlucky in front of a reviewer.
func TestTheLeaseIsReadUnderMu(t *testing.T) {
	dir := t.TempDir()
	s := newEditServer(t, dir, "doc.md", "# Title\n\nAlpha beta gamma delta.\n")
	defer func() { _ = s.Close() }()
	s.OnRevise = "true"
	press(t, s, "{}")

	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := range 20 {
				_ = os.WriteFile(s.MdPath, fmt.Appendf(nil, "# Title\n\nBody %d-%d.\n", n, j), 0o644)
				_, _ = s.importDraft()
			}
		}(i)
	}
	wg.Wait()
}

// A LEASE WRITE NEVER OUTLIVES THE WINDOW. The hook holds a message write
// between its snapshot and its write while the window closes: the close must
// wait for the write, not the write land after the close, or a restart reopens
// a revision that already finished.
func TestALeaseWriteRacingACloseLeavesNoLease(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	closed, waiting := make(chan struct{}), make(chan struct{})
	s.testLeaseWait = func() { close(waiting) }
	s.testLeaseWrite = func() {
		s.testLeaseWrite = nil
		go func() { s.closeHandoff(); close(closed) }()
		select {
		case <-closed:
		case <-waiting:
		}
	}
	if rec := postAckRec(t, s, "working", "reading"); rec.Code != http.StatusNoContent {
		t.Fatalf("working ack: %d %s", rec.Code, rec.Body.String())
	}
	<-closed
	if _, err := os.Stat(s.leasePath()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("lease after the close: %v, want none on disk", err)
	}
}

// AND TWO WRITES LAND IN THE ORDER THEY WERE TAKEN. The first write is held
// after its snapshot while a second ack moves the message on: the disk must end
// on the second, never on the first written over it.
func TestTwoLeaseWritesLeaveTheNewerState(t *testing.T) {
	s, _ := messageDoc(t)
	s.openResponseWindow(1, "fp", false)
	second, waiting := make(chan struct{}), make(chan struct{})
	s.testLeaseWait = func() { close(waiting) }
	s.testLeaseWrite = func() {
		s.testLeaseWrite = nil
		go func() {
			_ = postAckRec(t, s, "working", "second")
			close(second)
		}()
		select {
		case <-second:
		case <-waiting:
		}
	}
	if rec := postAckRec(t, s, "working", "first"); rec.Code != http.StatusNoContent {
		t.Fatalf("first ack: %d %s", rec.Code, rec.Body.String())
	}
	<-second
	if got, _ := leaseOnDisk(t, s)["line"].(string); got != "second" {
		t.Fatalf("lease line %q, want the newer %q", got, "second")
	}
}
