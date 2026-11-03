package ledger

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// openTestIndex opens an index in a temp dir, closed at the end of the test.
func openTestIndex(t *testing.T) *Index {
	t.Helper()
	t.Setenv("GALLEY_LEDGER_DIR", t.TempDir())
	x, err := OpenIndex()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = x.Close() })
	return x
}

// decide appends one record and returns the log's path.
func decide(t *testing.T, doc string, rec Record) string {
	t.Helper()
	if err := Log(doc, rec); err != nil {
		t.Fatal(err)
	}
	path, err := LogPath(doc)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

// TestAppendSyncQuery is the round trip the whole design rests on: a decision
// written to the log, ingested, and read back out of the index unchanged.
func TestAppendSyncQuery(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	at := time.Date(2026, 8, 15, 9, 30, 0, 123456789, time.UTC)
	log := decide(t, doc, Record{
		At: at, Kind: KindDeclined, Author: AuthorAgent, Review: "doc-7f3a",
		Old: "brown", New: "red", Reason: "house style", Quote: "the brown fox", Context: "…jumped…",
	})

	res, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 || res.Skipped != 0 || res.Torn {
		t.Fatalf("sync = %+v, want one clean record", res)
	}

	got, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 indexed decision, got %d", len(got))
	}
	if !got[0].At.Equal(at) {
		t.Errorf("at = %s, want %s", got[0].At, at)
	}
	if got[0].Kind != KindDeclined || got[0].Reason != "house style" ||
		got[0].Doc != "doc.md" || got[0].Review != "doc-7f3a" {
		t.Errorf("record did not round trip: %+v", got[0])
	}
}

func TestInstructionRoundTripsThroughLogAndIndex(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	at := time.Date(2026, 8, 17, 2, 30, 0, 123456789, time.UTC)
	log := decide(t, doc, Record{
		At: at, Kind: KindInstruction, Author: AuthorReviewer, Review: "doc-7f3a",
		Round: 4, Text: "Spell this out for a reader.", Quote: "retryBudget", Context: "The retryBudget controls retries.",
	})
	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}

	got, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 indexed instruction, got %d", len(got))
	}
	if got[0].Kind != KindInstruction || got[0].Round != 4 ||
		got[0].Text != "Spell this out for a reader." || got[0].Quote != "retryBudget" {
		t.Fatalf("instruction did not round trip: %+v", got[0])
	}
	if n, err := x.CountDecisions(); err != nil {
		t.Fatal(err)
	} else if n != 0 {
		t.Fatalf("CountDecisions = %d, want 0 — an instruction records an ask, not a decision", n)
	}
	instructions, err := x.Instructions("doc.md", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(instructions) != 1 || instructions[0].Text != "Spell this out for a reader." {
		t.Fatalf("Instructions(doc.md, 4) = %+v", instructions)
	}
	if other, err := x.Instructions("doc.md", 3); err != nil {
		t.Fatal(err)
	} else if len(other) != 0 {
		t.Fatalf("Instructions(doc.md, 3) = %+v, want none", other)
	}
}

// TestSyncIsIncrementalAndIdempotent: appending more and syncing again reads
// only the new bytes, and syncing an unchanged log adds nothing at all.
func TestSyncIsIncrementalAndIdempotent(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	var log string
	for i := 0; i < 3; i++ {
		log = decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: fmt.Sprintf("first-%d", i)})
	}
	first, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if first.Added != 3 {
		t.Fatalf("added %d, want 3", first.Added)
	}

	// Sync again with nothing new: no work, no duplicates.
	again, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if again.Added != 0 {
		t.Fatalf("a no-op sync added %d records", again.Added)
	}
	if again.Bytes != first.Bytes {
		t.Fatalf("the offset moved on a no-op sync: %d -> %d", first.Bytes, again.Bytes)
	}

	for i := 0; i < 2; i++ {
		decide(t, doc, Record{Kind: KindEdited, Author: AuthorReviewer, Quote: fmt.Sprintf("second-%d", i)})
	}
	third, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if third.Added != 2 {
		t.Fatalf("added %d on the incremental pass, want the 2 new ones", third.Added)
	}
	if third.Bytes <= first.Bytes {
		t.Fatalf("the offset did not advance: %d -> %d", first.Bytes, third.Bytes)
	}

	n, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("index holds %d decisions, want 5 — an incremental sync duplicated rows", n)
	}
}

// TestTornFinalLineIsTolerated is the crash-mid-append case. A line with no
// newline on it is NOT ingested and its bytes are NOT consumed, so when the
// appender finishes it (or a later one completes the file) it is read whole.
func TestTornFinalLineIsTolerated(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	log := decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "whole"})

	// Half a record, exactly as a process dying mid-write would leave it.
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"v":1,"at":"2026-08-15T09:30:00Z","doc":"doc.md","kind":"decl`); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	res, err := x.Sync(log)
	if err != nil {
		t.Fatalf("a torn line must not be an error: %v", err)
	}
	if !res.Torn {
		t.Error("the torn line was not reported")
	}
	if res.Added != 1 {
		t.Fatalf("added %d, want the one complete record", res.Added)
	}

	// Finish the line the way the next append would, and the record arrives.
	f, err = os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`ined","author":"agent","old":"","new":"","reason":"late","quote":"","context":""}` + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	res, err = x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if res.Torn {
		t.Error("still reporting a torn line after the write completed")
	}
	if res.Added != 1 {
		t.Fatalf("added %d, want the completed record", res.Added)
	}
	got, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	// Order is by decision INSTANT, not by arrival — the hand-written line
	// carries an `at` from earlier in the day, so it sorts first.
	var late bool
	for _, rec := range got {
		if rec.Reason == "late" {
			late = true
		}
	}
	if len(got) != 2 || !late {
		t.Fatalf("the finished line did not arrive: %+v", got)
	}
}

// TestCompleteButMalformedLineIsSteppedOver: a whole line that will never
// parse must not stall the offset behind it forever.
func TestCompleteButMalformedLineIsSteppedOver(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	log := decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "before"})
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("this is not json at all\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "after"})

	res, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != 1 {
		t.Errorf("skipped %d, want the one bad line", res.Skipped)
	}
	if res.Added != 2 {
		t.Errorf("added %d, want both good records — the bad line stalled the offset", res.Added)
	}
}

// TestRebuildReproducesTheIndex is the SPEC'S PROOF that the index is derived.
// Wipe it, re-read every log from byte zero, and the rows must come back
// identical. If they do not, something in the index is truth rather than
// memory.
func TestRebuildReproducesTheIndex(t *testing.T) {
	_, docA := repo(t)
	_, docB := repo(t)
	x := openTestIndex(t)

	logA := decide(t, docA, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "a1"})
	decide(t, docA, Record{Kind: KindDeclined, Author: AuthorAgent, Reason: "too clever", Quote: "a2"})
	logB := decide(t, docB, Record{Kind: KindEdited, Author: AuthorReviewer, Quote: "b1"})

	if _, err := x.SyncAll(logA, logB); err != nil {
		t.Fatal(err)
	}
	before, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	statsBefore, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 3 {
		t.Fatalf("want 3 decisions across two repos, got %d", len(before))
	}

	res, err := x.Rebuild()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 {
		t.Fatalf("rebuild touched %d sources, want both", len(res))
	}
	for _, r := range res {
		if r.Bytes == 0 {
			t.Errorf("%s was not re-read from zero", r.Path)
		}
	}

	after, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("rebuild did not reproduce the index:\n before %+v\n after  %+v", before, after)
	}
	statsAfter, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(statsBefore, statsAfter) {
		t.Fatalf("rebuild changed the answers:\n before %+v\n after  %+v", statsBefore, statsAfter)
	}
}

// TestSyncResetsWhenTheLogShrinks: a branch switch or a revert can leave a log
// shorter than the bytes already ingested. Those rows are about bytes that no
// longer exist, so the source is dropped and re-read.
func TestSyncResetsWhenTheLogShrinks(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	var log string
	for i := 0; i < 4; i++ {
		log = decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: fmt.Sprintf("q%d", i)})
	}
	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}

	// Rewrite the log with a single, different record — the other branch's.
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	if err := Append(log, Record{Kind: KindEntrusted, Author: AuthorAgent, Quote: "other-branch"}); err != nil {
		t.Fatal(err)
	}

	res, err := x.Sync(log)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Reset {
		t.Error("the shrunk log was not reported as a reset")
	}
	got, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Quote != "other-branch" {
		t.Fatalf("stale rows survived a shrunk log: %+v", got)
	}
}

// TestSyncOnAMissingLogIsNotAnError: a repo where nothing has been decided
// has no decisions file, and `sync` over a laptop's worth of repos must not
// fail on the first one that is quiet.
func TestSyncOnAMissingLogIsNotAnError(t *testing.T) {
	x := openTestIndex(t)
	res, err := x.Sync(filepath.Join(t.TempDir(), ".galley", "decisions.jsonl"))
	if err != nil {
		t.Fatalf("a missing log must not be an error: %v", err)
	}
	if !res.Missing || res.Added != 0 {
		t.Fatalf("res = %+v, want a quiet miss", res)
	}
	// It is still REMEMBERED: a repo that has not decided anything yet will,
	// and `sync` with no arguments has to find it again.
	srcs, err := x.Sources()
	if err != nil {
		t.Fatal(err)
	}
	if len(srcs) != 1 {
		t.Fatalf("want the source remembered, got %+v", srcs)
	}
}

// TestStatsAnswersTheQuestionsTheLogCannot. Nine decisions, hand-counted.
func TestStatsAnswersTheQuestionsTheLogCannot(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	var log string
	add := func(kind Kind, author, reason string) {
		log = decide(t, doc, Record{Kind: kind, Author: author, Reason: reason})
	}
	add(KindApproved, AuthorAgent, "")
	add(KindApproved, AuthorAgent, "")
	add(KindEntrusted, AuthorAgent, "")
	add(KindDeclined, AuthorAgent, "too clever")
	add(KindDeclined, AuthorAgent, "too clever")
	add(KindDeclined, AuthorAgent, "out of scope")
	add(KindDeclined, AuthorAgent, "") // no reason given: excluded from the list
	add(KindHand, AuthorAgent, "")     // a proposal REWRITTEN: hand is always the agent's
	// The reviewer's own prose, which is not a proposal and is not spelled
	// `hand` — a hand record authored to the reviewer is a shape no call site
	// can produce, and a fixture that builds one teaches the wrong row.
	add(KindEdited, AuthorReviewer, "")

	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	s, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}

	if s.Total != 9 {
		t.Errorf("total = %d, want 9", s.Total)
	}
	kinds := map[string]int{}
	for _, kc := range s.ByKind {
		kinds[kc.Kind] = kc.Count
	}
	want := map[string]int{"approved": 2, "entrusted": 1, "declined": 4, "hand": 1, "edited": 1}
	if !reflect.DeepEqual(kinds, want) {
		t.Errorf("byKind = %v, want %v", kinds, want)
	}

	if len(s.DeclineReasons) != 2 {
		t.Fatalf("declineReasons = %+v, want two — a blank note is not a reason", s.DeclineReasons)
	}
	if s.DeclineReasons[0].Reason != "too clever" || s.DeclineReasons[0].Count != 2 {
		t.Errorf("top decline reason = %+v", s.DeclineReasons[0])
	}

	// Agent-authored only: 8 records, of which 3 landed as proposed, 4 were
	// declined, 1 was rewritten by hand. The reviewer's own hand edit is not
	// an agent proposal and must not be in the denominator.
	if s.Agent.Total != 8 || s.Agent.Accepted != 3 || s.Agent.Declined != 4 || s.Agent.Rewritten != 1 {
		t.Errorf("agent = %+v, want 3 accepted / 4 declined / 1 rewritten of 8", s.Agent)
	}
	if got := fmt.Sprintf("%.3f", s.Agent.AcceptRate); got != "0.375" {
		t.Errorf("acceptRate = %s, want 0.375", got)
	}
}

// TestStatsOnAnEmptyIndexIsZeroesRatherThanAnError: SUM over zero rows is
// NULL in SQLite, which is the sort of thing that turns a fresh install's
// first command into a scan error.
func TestStatsOnAnEmptyIndexIsZeroesRatherThanAnError(t *testing.T) {
	x := openTestIndex(t)
	s, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 0 || s.Agent.Total != 0 || s.Agent.AcceptRate != 0 {
		t.Fatalf("stats = %+v, want zeroes", s)
	}
	if s.ByKind == nil || s.DeclineReasons == nil {
		t.Error("the empty lists must marshal as [] rather than null")
	}
}

// TestMigrateIsIdempotentAndVersioned: opening the same database twice applies
// the schema once and leaves the version where it belongs.
func TestMigrateIsIdempotentAndVersioned(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.db")
	_, doc := repo(t)
	log := decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "kept"})

	for i := 0; i < 2; i++ {
		x, err := OpenIndexAt(path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		v, err := x.SchemaVersion()
		if err != nil {
			t.Fatal(err)
		}
		if v != schemaVersion {
			t.Fatalf("open %d: schema v%d, want v%d", i, v, schemaVersion)
		}
		if _, err := x.Sync(log); err != nil {
			t.Fatal(err)
		}
		n, err := x.Count()
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("open %d: %d decisions, want the one — reopening re-ingested", i, n)
		}
		if err := x.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// TestIndexFromTheFutureRefusesRatherThanGuessing. An older galley meeting a
// newer schema must say so; a silent downgrade would write rows the newer
// build cannot read.
func TestIndexFromTheFutureRefusesRatherThanGuessing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.db")
	x, err := OpenIndexAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion+7)); err != nil {
		t.Fatal(err)
	}
	if err := x.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenIndexAt(path); err == nil {
		t.Fatal("want a refusal for an index newer than this build")
	}
}

// TestOpenIndexFailsSoft: the index half of the invariant. An unwritable home
// returns an error rather than panicking, and the decision it could not index
// is still in the log.
func TestOpenIndexFailsSoft(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: a read-only directory is not read-only")
	}
	base := t.TempDir()
	if err := os.Chmod(base, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(base, 0o700) })
	t.Setenv("GALLEY_LEDGER_DIR", filepath.Join(base, "nope"))
	if _, err := OpenIndex(); err == nil {
		t.Fatal("want an error when the index directory cannot be created")
	}
}

// TestUnionMergedDuplicateDoesNotDoubleCount is the gap the user found by asking
// how the .gitattributes behaves ACROSS repos.
//
// `merge=union` resolves an append-only file by keeping BOTH sides' lines,
// which is right for concurrent appends and means a cherry-pick, a rebase
// replay, or a merge of two branches that each recorded the same decision
// leaves that record in the log TWICE at different line numbers. Position
// uniqueness cannot see that — the duplicates are at different positions —
// so every count stats reports inflates, which is precisely the number the
// ledger exists to make trustworthy.
func TestUnionMergedDuplicateDoesNotDoubleCount(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	log := decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "a"})
	decide(t, doc, Record{Kind: KindDeclined, Author: AuthorAgent, Reason: "no", Quote: "b"})
	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	before, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	statsBefore, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if before != 2 {
		t.Fatalf("want 2 decisions, got %d", before)
	}

	// What a union merge leaves behind: the other branch's copy of a line
	// this branch already has, byte for byte, at a new position.
	raw, err := os.ReadFile(log) //nolint:gosec // test fixture path
	if err != nil {
		t.Fatal(err)
	}
	first := raw[:bytesIndexNewline(raw)+1]
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(first); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	after, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("a union-merged duplicate added %d row(s): %d -> %d", after-before, before, after)
	}
	statsAfter, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(statsBefore, statsAfter) {
		t.Fatalf("a duplicated line moved the numbers:\n before %+v\n after  %+v", statsBefore, statsAfter)
	}

	// And a rebuild from byte zero, which reads the duplicate as an ordinary
	// line rather than as new bytes past an offset, must agree.
	if _, err := x.Rebuild(); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if rebuilt != before {
		t.Fatalf("rebuild counted the duplicate: %d, want %d", rebuilt, before)
	}
	statsRebuilt, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(statsBefore, statsRebuilt) {
		t.Fatalf("rebuild moved the numbers:\n before %+v\n after  %+v", statsBefore, statsRebuilt)
	}
}

// TestDigestIsNotTooCoarse: the dedupe must key on the WHOLE record. Two
// decisions differing only in old/new are two decisions.
func TestDigestIsNotTooCoarse(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	at := time.Date(2026, 8, 15, 9, 30, 0, 0, time.UTC)
	base := Record{At: at, Kind: KindHand, Author: AuthorAgent, Review: "r", Quote: "q", Context: "c"}

	a := base
	a.Old, a.New = "could", "should"
	b := base
	b.Old, b.New = "would", "should"
	log := decide(t, doc, a)
	decide(t, doc, b)

	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	n, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("%d rows, want 2 — the digest collapsed two distinct decisions", n)
	}

	// Same shape one field over: only `reason` differs.
	c := base
	c.Kind, c.Reason = KindDeclined, "too clever"
	d := base
	d.Kind, d.Reason = KindDeclined, "out of scope"
	decide(t, doc, c)
	decide(t, doc, d)
	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	n, err = x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Fatalf("%d rows, want 4 — the digest ignores reason", n)
	}
}

func bytesIndexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

// TestMigrateV1AddsTheDigestAndDropsDuplicates builds the exact v1 schema by
// hand — the current Open would create a v2 one, so there is no other way to
// reach this code — puts a duplicate in it, and takes it through the upgrade.
//
// A migration path nobody has ever run is a migration path nobody knows works.
func TestMigrateV1AddsTheDigestAndDropsDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.db")
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
CREATE TABLE decisions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source TEXT NOT NULL, line INTEGER NOT NULL,
	v INTEGER NOT NULL, at TEXT NOT NULL, at_unix INTEGER NOT NULL,
	doc TEXT NOT NULL, review TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL,
	old TEXT NOT NULL, "new" TEXT NOT NULL, reason TEXT NOT NULL,
	quote TEXT NOT NULL, context TEXT NOT NULL, raw TEXT NOT NULL,
	UNIQUE (source, line));
CREATE TABLE sources (
	path TEXT PRIMARY KEY, ingested_bytes INTEGER NOT NULL DEFAULT 0,
	ingested_lines INTEGER NOT NULL DEFAULT 0, last_sync TEXT NOT NULL DEFAULT '');
PRAGMA user_version = 1;`); err != nil {
		t.Fatal(err)
	}

	kept := `{"v":1,"at":"2026-08-15T09:30:00Z","doc":"doc.md","review":"r","kind":"approved","author":"agent","old":"","new":"","reason":"","quote":"q","context":""}`
	other := `{"v":1,"at":"2026-08-15T09:31:00Z","doc":"doc.md","review":"r","kind":"declined","author":"agent","old":"","new":"","reason":"no","quote":"q","context":""}`
	junk := `not json, and a v1 index could hold one`
	// Lines 1 and 3 are the SAME decision at two positions: what a union merge
	// leaves, indexed under a schema that could not see it.
	for i, line := range []string{kept, other, kept, junk} {
		if _, err := raw.Exec(`INSERT INTO decisions
			(source, line, v, at, at_unix, doc, review, kind, author, old, "new", reason, quote, context, raw)
			VALUES ('/log.jsonl',?,1,'x',0,'doc.md','r','k','agent','','','','','',?)`, i+1, line); err != nil {
			t.Fatal(err)
		}
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	// Twice: the upgrade must be idempotent, like every other open.
	for i := 0; i < 2; i++ {
		x, err := OpenIndexAt(path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		v, err := x.SchemaVersion()
		if err != nil {
			t.Fatal(err)
		}
		if v != schemaVersion {
			t.Fatalf("open %d: schema v%d, want v%d", i, v, schemaVersion)
		}
		n, err := x.Count()
		if err != nil {
			t.Fatal(err)
		}
		// kept + other + junk: the second copy of `kept` is gone, and the
		// unparseable row survives because a row we could not have deduped on
		// ingest is not one to delete on migration.
		if n != 3 {
			t.Fatalf("open %d: %d rows, want 3 — the v1 duplicate was not dropped", i, n)
		}
		var dupes int
		if err := x.db.QueryRow(`SELECT COUNT(*) FROM (
			SELECT 1 FROM decisions WHERE digest <> '' GROUP BY source, digest HAVING COUNT(*) > 1)`).
			Scan(&dupes); err != nil {
			t.Fatal(err)
		}
		if dupes != 0 {
			t.Fatalf("open %d: %d content duplicates survived", i, dupes)
		}
		if err := x.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// TestDigestIsInjectiveAcrossFieldBoundaries: the fields are length-prefixed
// rather than delimiter-joined, so text moving from one field to the next
// cannot hash alike. A delimiter can occur inside a reviewer's decline note.
func TestDigestIsInjectiveAcrossFieldBoundaries(t *testing.T) {
	at := time.Date(2026, 8, 15, 9, 30, 0, 0, time.UTC)
	a := Record{V: 1, At: at, Kind: KindDeclined, Author: AuthorAgent, Old: "ab", New: "c"}
	b := Record{V: 1, At: at, Kind: KindDeclined, Author: AuthorAgent, Old: "a", New: "bc"}
	if a.Digest() == b.Digest() {
		t.Fatal("the digest is not injective across field boundaries")
	}
	// And it is stable: the same record hashes the same way twice, and a
	// non-UTC instant hashes as its UTC self (the log normalizes on append).
	c := a
	c.At = at.In(time.FixedZone("elsewhere", 3600))
	if a.Digest() != c.Digest() {
		t.Fatal("the digest depends on the timestamp's zone")
	}
}

// TestCountingIsPerDecisionNotPerSource is the worktree case, and it is not
// hypothetical: the user works in git worktrees constantly, so the SAME committed
// log sits at many source paths on one machine. A decision recorded once and
// cloned into five checkouts is one decision, and the ledger must never report
// five.
func TestCountingIsPerDecisionNotPerSource(t *testing.T) {
	x := openTestIndex(t)

	// One repo's log, and a second checkout of the same repo: byte-identical
	// content at a different path.
	_, docA := repo(t)
	logA := decide(t, docA, Record{
		At:   time.Date(2026, 8, 15, 9, 0, 0, 0, time.UTC),
		Kind: KindApproved, Author: AuthorAgent, Quote: "shared",
	})
	decide(t, docA, Record{
		At:   time.Date(2026, 8, 15, 9, 1, 0, 0, time.UTC),
		Kind: KindDeclined, Author: AuthorAgent, Reason: "too clever", Quote: "shared2",
	})
	decide(t, docA, Record{
		At:   time.Date(2026, 8, 15, 9, 2, 0, 0, time.UTC),
		Kind: KindHand, Author: AuthorAgent, Quote: "shared3",
	})

	worktree := t.TempDir()
	logB := filepath.Join(worktree, ".galley", "decisions.jsonl")
	if err := os.MkdirAll(filepath.Dir(logB), 0o755); err != nil {
		t.Fatal(err)
	}
	sharedBytes, err := os.ReadFile(logA) //nolint:gosec // test fixture path
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logB, sharedBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := x.SyncAll(logA); err != nil {
		t.Fatal(err)
	}
	one, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := x.SyncAll(logB); err != nil {
		t.Fatal(err)
	}
	two, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}

	// STORAGE IS PER SOURCE: both files really did contain those lines.
	rows, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if rows != 6 {
		t.Fatalf("%d rows, want 6 — the per-source record is the honest one and must be kept", rows)
	}

	// COUNTING IS PER DECISION: every aggregate must be unmoved.
	if two.Sources != 2 {
		t.Errorf("sources = %d, want 2 — the source count IS per source", two.Sources)
	}
	one.Sources = two.Sources // the one field that legitimately differs
	if !reflect.DeepEqual(one, two) {
		t.Fatalf("a second checkout moved the numbers:\n one  %+v\n two  %+v", one, two)
	}
	if two.Total != 3 {
		t.Errorf("total = %d, want 3 decisions", two.Total)
	}
	if two.Agent.Total != 3 || two.Agent.Accepted != 1 || two.Agent.Declined != 1 || two.Agent.Rewritten != 1 {
		t.Errorf("agent = %+v, want 1/1/1 of 3", two.Agent)
	}
	if len(two.DeclineReasons) != 1 || two.DeclineReasons[0].Count != 1 {
		t.Errorf("declineReasons = %+v, want one reason counted once", two.DeclineReasons)
	}
	for _, kc := range two.ByKind {
		if kc.Count != 1 {
			t.Errorf("kind %s counted %d times, want 1", kc.Kind, kc.Count)
		}
	}

	// The listing is a listing of DECISIONS too.
	list, err := x.Decisions(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("Decisions returned %d, want 3", len(list))
	}
}

// TestUnparseableRowsAreNotCollapsed: a row with no digest has no identity to
// collapse ON, so each one counts individually. Collapsing them together would
// be the dedupe inventing an equality it cannot support.
func TestUnparseableRowsAreNotCollapsed(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	log := decide(t, doc, Record{Kind: KindApproved, Author: AuthorAgent, Quote: "real"})
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	// Two DIFFERENT unparseable lines. Both are stepped over at ingest, so
	// neither reaches a row — this asserts the counting rule directly on rows
	// that a v1 index could hold.
	if _, err := f.WriteString("garbage one\ngarbage two\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}

	// Insert the digestless rows the way a migrated v1 index would carry them.
	for i, raw := range []string{"garbage one", "garbage two"} {
		if _, err := x.db.Exec(`INSERT INTO decisions
			(source, line, digest, v, at, at_unix, doc, review, kind, author, old, "new", reason, quote, context, raw)
			VALUES (?,?,'',1,'x',0,'doc.md','r','approved','agent','','','','','',?)`,
			log, 900+i, raw); err != nil {
			t.Fatal(err)
		}
	}

	s, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 3 {
		t.Fatalf("total = %d, want 3 — two digestless rows must count individually, not collapse", s.Total)
	}
}

// THE AGENT ROLLUP IS ABOUT PROPOSALS, and the wiring gave the log kinds that
// are not one. A thread resolved, a review's verdict and a reopen all carry an
// author, and counting them in "what became of the agent's proposals" would
// make the denominator answer a different question from the numerator — an
// accept rate that falls because someone settled a conversation.
//
// It also asserts the fifth proposal fate: `rejected`, the record-free discard
// of a proposal, which is neither accepted nor declined nor rewritten and had
// nowhere to go before the call sites could produce one.
func TestAgentRollupCountsProposalsOnly(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	at := time.Date(2026, 8, 15, 9, 0, 0, 0, time.UTC)
	var log string
	add := func(kind Kind, author string) {
		at = at.Add(time.Second)
		log = decide(t, doc, Record{At: at, Kind: kind, Author: author, Quote: string(kind)})
	}
	add(KindApproved, AuthorAgent)
	add(KindEntrusted, AuthorAgent)
	add(KindDeclined, AuthorAgent)
	add(KindHand, AuthorAgent)
	add(KindRejected, AuthorAgent)
	// Not proposals. Each carries the agent as the author of the thing being
	// decided, which is exactly how they would pollute the rollup.
	add(KindResolved, AuthorAgent)
	add(KindDeleted, AuthorAgent)
	add(KindVerdictApproved, AuthorAgent)
	add(KindReopened, AuthorAgent)

	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	s, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if s.Agent.Total != 5 {
		t.Fatalf("agent total = %d, want 5 — only the proposal kinds belong in the rollup (%+v)", s.Agent.Total, s.Agent)
	}
	if s.Agent.Accepted != 2 || s.Agent.Declined != 1 || s.Agent.Rewritten != 1 || s.Agent.Rejected != 1 {
		t.Fatalf("agent fate %+v, want 2 accepted / 1 declined / 1 rewritten / 1 rejected", s.Agent)
	}
	if s.Agent.Accepted+s.Agent.Declined+s.Agent.Rewritten+s.Agent.Rejected != s.Agent.Total {
		t.Fatalf("the buckets do not add up to the total: %+v", s.Agent)
	}
	// ByKind is a plain GROUP BY and must report every kind the wiring can
	// write, including the ones the rollup excludes.
	if len(s.ByKind) != 9 {
		t.Fatalf("byKind has %d entries, want 9: %+v", len(s.ByKind), s.ByKind)
	}
}

// A REOPEN IS NOT A DECISION, AND THE ONLY CONSUMER THAT COUNTS DECISIONS IS
// GALLEY'S OWN. Giving reopen its own word was justified in the ledger's doc
// comment by exactly one sentence — "so a consumer counting DECISIONS can leave
// it out" — and for one release the store's own counters did not: `Stats.Total`
// and `CountDecisions` applied no kind filter at all, and `galley ledger stats`
// printed the sum as "N decisions".
//
// So the exclusion is real here, and it is asserted from both ends: the number
// that says "decisions" excludes it, and the by-kind tally — which is a record
// of what is in the log, not a count of decisions — still reports it. A reopen
// that vanished from `byKind` would be a reason lost, and the reason is why the
// row exists.
func TestAReopenIsRecordedAndIsNotCounted(t *testing.T) {
	_, doc := repo(t)
	x := openTestIndex(t)

	at := time.Date(2026, 8, 15, 9, 0, 0, 0, time.UTC)
	var log string
	add := func(kind Kind, reason string) {
		at = at.Add(time.Second)
		log = decide(t, doc, Record{At: at, Kind: kind, Author: AuthorAgent, Reason: reason})
	}
	add(KindApproved, "")
	add(KindVerdictApproved, "")
	add(KindReopened, "the entrusted work is done")

	if _, err := x.Sync(log); err != nil {
		t.Fatal(err)
	}
	n, err := x.CountDecisions()
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("CountDecisions = %d, want 2 — a reopen decides nothing", n)
	}
	rows, err := x.Count()
	if err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Errorf("Count = %d, want 3 — storage counts every row, including the reopen", rows)
	}

	s, err := x.Stats(5)
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 2 {
		t.Errorf("stats total = %d, want 2 decisions", s.Total)
	}
	if s.NotDecisions != 1 {
		t.Errorf("notDecisions = %d, want the reopen counted where it belongs", s.NotDecisions)
	}
	found := false
	for _, kc := range s.ByKind {
		if kc.Kind == string(KindReopened) {
			found = kc.Count == 1
		}
	}
	if !found {
		t.Errorf("byKind lost the reopen: %+v — the row exists for its reason", s.ByKind)
	}
	// AND THE PRINTED DATE RANGE IS THE RANGE OF THOSE DECISIONS. `galley
	// ledger stats` prints "first → last" under the headline, and the headline
	// says how many DECISIONS there are — so a row that headline excludes must
	// not be able to set either end. The reopen above is the newest row in the
	// log by a second; MIN/MAX over every row named it as the last decision.
	// (Docs is the deliberate exemption on this filter and says so in place;
	// this one was silent, which is what made it worth a test rather than a
	// comment.)
	last := at.UTC().Format(time.RFC3339)
	if s.Last == last {
		t.Errorf("last = %s, which is the REOPEN's instant — the range under a "+
			"headline that counts decisions is naming a row it does not count", s.Last)
	}
	if s.First == "" || s.Last == "" {
		t.Fatalf("range = %q → %q, want the two decisions' own instants", s.First, s.Last)
	}
}

// Every kind is a distinct word. A duplicate would silently merge two acts in
// every aggregate that groups by it, and the vocabulary is now long enough that
// a copy-paste is a real way to make one.
func TestKindsAreDistinct(t *testing.T) {
	seen := map[Kind]bool{}
	for _, k := range AllKinds {
		if seen[k] {
			t.Fatalf("kind %q appears twice", k)
		}
		if k == "" {
			t.Fatal("a kind may not be empty — Append refuses one")
		}
		seen[k] = true
	}
	if len(AllKinds) < 12 {
		t.Fatalf("AllKinds has %d entries; every kind a call site writes belongs in it", len(AllKinds))
	}
}

// `author` MEANS TWO THINGS AND EVERY KIND HAS TO SAY WHICH.
//
// The field names whoever WROTE the thing being decided — except for the kinds
// that have no such party, where it names the decider (DeciderKinds, whose
// comment argues the case). That is a real overload of one column, and it was
// invisible until it was audited: the field carried no doc comment at all, and
// KindHand's said "like every other kind here", which was false of six of them.
//
// Nothing today mis-reads it — the only query that touches `author` is the
// agent rollup, and it is scoped to ProposalKinds — so the fix is not to move
// values around (there is nothing to move a verdict's author TO). The fix is
// that the split is a list, and that a new kind cannot join the vocabulary
// without being put on one side of it. This is that requirement.
func TestEveryKindSaysWhichPartyItsAuthorNames(t *testing.T) {
	decider := map[Kind]bool{}
	for _, k := range DeciderKinds {
		decider[k] = true
	}
	all := map[Kind]bool{}
	for _, k := range AllKinds {
		all[k] = true
	}
	for _, k := range DeciderKinds {
		if !all[k] {
			t.Errorf("DeciderKinds names %q, which is not a kind any call site writes", k)
		}
	}

	// THE PROPERTY: the two readings do not overlap on the population the one
	// author-reading query computes. AgentFate asks `WHERE author = agent AND
	// kind IN ProposalKinds`, which is only sound because no ProposalKind
	// records its decider — a verdict landing in that population would count
	// the reviewer's own press as one of the agent's proposals.
	for _, k := range ProposalKinds {
		if decider[k] {
			t.Errorf("%q is a ProposalKind AND a DeciderKind — AgentFate's author filter is counting the reviewer's own acts as the agent's proposals", k)
		}
	}

	// And the classification is TOTAL. A kind that is in neither list is a kind
	// whose author nobody has decided the meaning of, which is exactly how a
	// column ends up meaning two things without anybody choosing.
	decidedUpon := 0
	for _, k := range AllKinds {
		if !decider[k] {
			decidedUpon++
		}
	}
	if decidedUpon == 0 || len(DeciderKinds) == 0 {
		t.Fatalf("%d decided-upon kinds, %d decider kinds — this check says nothing unless the split has both sides",
			decidedUpon, len(DeciderKinds))
	}
}
