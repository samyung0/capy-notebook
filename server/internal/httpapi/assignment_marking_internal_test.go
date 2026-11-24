package httpapi

import (
	"context"
	"fmt"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
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

// A marking call carries up to four parts and 24 images (Epo 2026-11-23): a
// part that would pass 24 starts the next call.
func TestGradingBatchesFillToTwentyFourImages(t *testing.T) {
	drawn := func(question string) openPart {
		figures := make([]map[string]any, 6)
		for i := range figures {
			figures[i] = map[string]any{"assetId": fmt.Sprintf("%s-figure-%d", question, i)}
		}
		return openPart{figures: figures, image: []byte{1}, drawing: question, sample: sampleOwner{assetID: question + "-sample"}}
	}
	parts := map[string]openPart{
		"a": drawn("a"), "b": drawn("b"), "c": drawn("c"), "d": drawn("d"),
		"e": {answer: "x"}, "f": {answer: "y"}, "g": {answer: "z"}, "h": {answer: "w"}, "i": {answer: "v"},
	}
	got := packBatches([]string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}, parts)
	want := [][]string{{"a", "b", "c"}, {"d", "e", "f", "g"}, {"h", "i"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("batches = %v, want %v", got, want)
	}
}

// An image a call's parts share is sent and counted once (Epo 2026-11-23):
// parts answering in one canvas name one drawing, and a question's figures
// are named by their assets, so four parts of 7 images each, all shared,
// fit one call with 7, where 28 would have split it.
func TestGradingBatchesCountASharedImageOnce(t *testing.T) {
	figures := []map[string]any{}
	for i := range 6 {
		figures = append(figures, map[string]any{"assetId": fmt.Sprintf("stem-%d", i)})
	}
	shared := openPart{figures: figures, image: []byte{1}, drawing: "s1"}
	parts := map[string]openPart{"s1": shared, "s2": shared, "s3": shared, "s4": shared}
	if got := packBatches([]string{"s1", "s2", "s3", "s4"}, parts); fmt.Sprint(got) != "[[s1 s2 s3 s4]]" {
		t.Fatalf("batches = %v, want one", got)
	}
	// Their own drawings are images of their own: 6 shared figures and 4
	// drawings make 10, still one call.
	for i, id := range []string{"s1", "s2", "s3", "s4"} {
		own := shared
		own.drawing = id
		parts[id] = own
		if names := partImages(own); len(names) != 7 || names[6] != "drawing:"+id {
			t.Fatalf("part %d names %v", i, names)
		}
	}
	if got := packBatches([]string{"s1", "s2", "s3", "s4"}, parts); fmt.Sprint(got) != "[[s1 s2 s3 s4]]" {
		t.Fatalf("batches = %v, want one", got)
	}
}

// The parts answering in one canvas are marked in one call (Epo 2026-11-24):
// next to each other at the first one's place, each question's first parts
// still before any second.
func TestMarkingOrderKeepsACanvasTogether(t *testing.T) {
	answers := []store.AnswerToMark{
		{QuestionID: "q1", PartID: "a", DrawingPart: "a"},
		{QuestionID: "q1", PartID: "b", DrawingPart: "b"},
		{QuestionID: "q1", PartID: "c", DrawingPart: "a"},
		{QuestionID: "q2", PartID: "x"},
		{QuestionID: "q2", PartID: "y"},
	}
	if got := markingOrder(answers); fmt.Sprint(got) != "[a c x b y]" {
		t.Fatalf("order = %v", got)
	}
}

// A canvas's parts that would not fit the call being filled start the next
// one; only a group bigger than a call splits.
func TestGradingBatchesKeepACanvasTogether(t *testing.T) {
	shared := func(drawing string) openPart { return openPart{image: []byte{1}, drawing: drawing} }
	parts := map[string]openPart{
		"p": {answer: "x"}, "q": {answer: "y"}, "r": {answer: "z"},
		"s1": shared("s1"), "s2": shared("s1"),
	}
	if got := packBatches([]string{"p", "q", "r", "s1", "s2"}, parts); fmt.Sprint(got) != "[[p q r] [s1 s2]]" {
		t.Fatalf("batches = %v", got)
	}
	// Five parts in one canvas: four, then the fifth with what follows.
	for _, id := range []string{"s3", "s4", "s5"} {
		parts[id] = shared("s1")
	}
	if got := packBatches([]string{"p", "s1", "s2", "s3", "s4", "s5", "q"}, parts); fmt.Sprint(got) != "[[p s1 s2 s3] [s4 s5 q]]" {
		t.Fatalf("batches = %v", got)
	}
	// By images too: two parts sharing 13 figures and a drawing, each with a
	// sample of its own, need 16, which a call holding 9 cannot take, though
	// the first part's 15 alone would fit it.
	figures := func(prefix string, n int) []map[string]any {
		out := make([]map[string]any, n)
		for i := range out {
			out[i] = map[string]any{"assetId": fmt.Sprintf("%s-%d", prefix, i)}
		}
		return out
	}
	heavy := func(sample string) openPart {
		return openPart{image: []byte{1}, drawing: "h1", figures: figures("h", 13), sample: sampleOwner{assetID: sample}}
	}
	parts = map[string]openPart{"f": {figures: figures("f", 9)}, "h1": heavy("h1-sample"), "h2": heavy("h2-sample")}
	if got := packBatches([]string{"f", "h1", "h2"}, parts); fmt.Sprint(got) != "[[f] [h1 h2]]" {
		t.Fatalf("batches = %v", got)
	}
}

// A canvas's parts go with working when any of them has it, so the working
// split keeps them in one call.
func TestSplitWorkingKeepsACanvasTogether(t *testing.T) {
	parts := map[string]openPart{
		"s1": {image: []byte{1}, drawing: "s1", question: "Draw the graph"},
		"s2": {image: []byte{1}, drawing: "s1", question: `Find $x$`},
		"o":  {question: "Explain", answer: "x"},
	}
	thinking, plain := splitWorking([]string{"s1", "s2", "o"}, parts)
	if fmt.Sprint(thinking) != "[s1 s2]" || fmt.Sprint(plain) != "[o]" {
		t.Fatalf("thinking %v, plain %v", thinking, plain)
	}
}
