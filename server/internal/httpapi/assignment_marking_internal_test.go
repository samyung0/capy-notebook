package httpapi

import (
	"context"
	"testing"
)

// A panic in a marking run must stay inside it, because nothing above its goroutine
// catches one and the whole server would stop. No store or pipeline here, so each of
// these panics without its recover, which fails the test.
func TestMarkingKeepsAPanicInsideTheRun(t *testing.T) {
	(&api{}).markAnswers(context.Background(), "a1", "", markingRequest{}, func() {})
}

func TestMarkingPanicFreesThePayersSlot(t *testing.T) {
	slots := make(chan struct{}, 1)
	if err := (&api{}).markAttemptInTurn(context.Background(), slots, "a1", "at1", markingRequest{}); err == nil {
		t.Fatal("the panic didn't become that attempt's failure")
	}
	if len(slots) != 0 {
		t.Fatal("the payer's slot stayed taken")
	}
}

func TestGradingPanicIsThatPartsFailure(t *testing.T) {
	part := openPart{markscheme: []string{"Point"}, itemMarks: []float64{1}}
	if _, err := (&api{}).gradePartSafely(context.Background(), resolvedLLM{}, "s", part, nil); err == nil {
		t.Fatal("the panic didn't become that part's failure")
	}
}
