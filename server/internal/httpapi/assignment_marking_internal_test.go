package httpapi

import (
	"context"
	"sync"
	"testing"
)

// A panic in a marking run must stay inside it, because nothing above its goroutine
// catches one and the whole server would stop. No store or pipeline here, so each of
// these panics without its recover, which fails the test.
func TestMarkingKeepsAPanicInsideTheRun(t *testing.T) {
	(&api{}).markAnswers(context.Background(), "a1", "")
}

func TestMarkingPanicFreesThePayersLock(t *testing.T) {
	var lock sync.Mutex
	if err := (&api{}).markAttemptInTurn(context.Background(), &lock, "a1", "at1"); err == nil {
		t.Fatal("the panic didn't become that attempt's failure")
	}
	if !lock.TryLock() {
		t.Fatal("the payer's lock stayed held")
	}
}

func TestGradingPanicIsThatPartsFailure(t *testing.T) {
	part := openPart{markscheme: []string{"Point"}, itemMarks: []float64{1}}
	if _, err := (&api{}).gradePartSafely(context.Background(), resolvedLLM{}, "s", part); err == nil {
		t.Fatal("the panic didn't become that part's failure")
	}
}
