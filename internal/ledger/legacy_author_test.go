package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// legacyLine is a decision as galley wrote it before the reviewer's author
// value became "user": the literal bytes, because the log is committed and
// append-only, so every repository that used galley holds lines like it.
const legacyLine = `{"v":1,"at":"2026-08-15T09:30:00Z","doc":"doc.md","review":"r","kind":"instruction","author":"court","old":"","new":"","reason":"","quote":"q","context":"","round":1,"text":"say more"}`

// TestALegacyReviewerAuthorReadsAsTheUser: a log line naming the reviewer the
// old way is the user's decision, in the index's author column and in every
// record read back out of it.
func TestALegacyReviewerAuthorReadsAsTheUser(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)
	path, err := LogPath(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(legacyLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Sync(path); err != nil {
		t.Fatal(err)
	}

	got, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Author != AuthorReviewer {
		t.Fatalf("decisions = %+v, want one authored %q", got, AuthorReviewer)
	}
	asks, err := x.Instructions("doc.md", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(asks) != 1 || asks[0].Author != AuthorReviewer {
		t.Fatalf("instructions = %+v, want one authored %q", asks, AuthorReviewer)
	}
	var col string
	if err := x.db.QueryRow(`SELECT author FROM decisions`).Scan(&col); err != nil {
		t.Fatal(err)
	}
	if col != AuthorReviewer {
		t.Fatalf("author column = %q, want %q", col, AuthorReviewer)
	}
}

// TestTheLegacyAuthorKeepsItsDigest: the digest is the dedupe key across
// worktrees, and a row indexed by an older build carries the digest of the
// line as written. Re-reading the same line elsewhere must find the same
// digest, or one decision counts twice.
func TestTheLegacyAuthorKeepsItsDigest(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)
	path, err := LogPath(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(legacyLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Sync(path); err != nil {
		t.Fatal(err)
	}
	var want Record
	if err := json.Unmarshal([]byte(legacyLine), &want); err != nil {
		t.Fatal(err)
	}
	var digest string
	if err := x.db.QueryRow(`SELECT digest FROM decisions`).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if digest != want.Digest() {
		t.Fatalf("digest = %s, want the digest of the line as written, %s", digest, want.Digest())
	}
}

// TestMigrateRewritesALegacyAuthorColumn: an index an older build filled holds
// the old value in its author column; opening it rewrites those rows once.
func TestMigrateRewritesALegacyAuthorColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.db")
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i, step := range migrations[:3] {
		tx, err := raw.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := step(ctx, tx); err != nil {
			t.Fatalf("step %d: %v", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`INSERT INTO decisions
		(source, line, v, at, at_unix, doc, review, kind, author, old, "new", reason, quote, context, raw, digest, round, text)
		VALUES ('/log.jsonl',1,1,'x',0,'doc.md','r','instruction','court','','','','q','',?,'d1',1,'say more')`, legacyLine); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	x, err := OpenIndexAt(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = x.Close() }()
	var col string
	if err := x.db.QueryRow(`SELECT author FROM decisions`).Scan(&col); err != nil {
		t.Fatal(err)
	}
	if col != AuthorReviewer {
		t.Fatalf("author column = %q after migration, want %q", col, AuthorReviewer)
	}
}
