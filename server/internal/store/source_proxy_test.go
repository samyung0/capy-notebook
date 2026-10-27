package store

import (
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// Q435: the gateway waits longer for a source-changes read than the
// collaboration service's read budget, past which it answers the files it
// has not read as failed: the files it did read still reach the turn.
func TestSourceChangesOutwaitTheReadBudget(t *testing.T) {
	raw, err := os.ReadFile("../../../collaboration-rs/crates/sources/src/pending.rs")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`OFFICE_CHANGES_BUDGET: Duration = Duration::from_secs\((\d+)\);`).FindSubmatch(raw)
	if match == nil {
		t.Fatal("OFFICE_CHANGES_BUDGET not found in pending.rs")
	}
	secs, err := strconv.Atoi(string(match[1]))
	if err != nil {
		t.Fatal(err)
	}
	if got, budget := sourceAuthorityTimeouts["/internal/source-changes"], time.Duration(secs)*time.Second; got <= budget {
		t.Fatalf("source-changes waits %s, not past the read budget %s", got, budget)
	}
}
