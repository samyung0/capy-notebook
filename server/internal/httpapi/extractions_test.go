package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

func TestCheckExtractionRequestHoldsTheRunCaps(t *testing.T) {
	pages := func(n int) []int {
		out := make([]int, n)
		for i := range out {
			out[i] = i + 1
		}
		return out
	}
	ok := apimodel.CreateExtractionReq{
		Paper:         []apimodel.ExtractionPaperFile{{FileID: "p", Pages: pages(30)}, {FileID: "q", Pages: pages(10)}},
		AnswerFileIDs: []string{"s1", "s2"},
	}
	if err := checkExtractionRequest(ok); err != nil {
		t.Fatalf("40 pages in 4 files refused: %v", err)
	}
	for name, req := range map[string]apimodel.CreateExtractionReq{
		"41 pages": {Paper: []apimodel.ExtractionPaperFile{{FileID: "p", Pages: pages(fieldlimits.ExtractionPages + 1)}}},
		"11 files": {
			Paper:         []apimodel.ExtractionPaperFile{{FileID: "p", Pages: []int{1}}},
			AnswerFileIDs: []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"},
		},
		"page 0":          {Paper: []apimodel.ExtractionPaperFile{{FileID: "p", Pages: []int{0}}}},
		"page twice":      {Paper: []apimodel.ExtractionPaperFile{{FileID: "p", Pages: []int{2, 2}}}},
		"paper as answer": {Paper: []apimodel.ExtractionPaperFile{{FileID: "p", Pages: []int{1}}}, AnswerFileIDs: []string{"p"}},
	} {
		if err := checkExtractionRequest(req); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestInternalCheckQuestionAnswersWithTheRefusal(t *testing.T) {
	check := func(question string) string {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/internal/questions/check", strings.NewReader(`{"question":`+question+`}`))
		(&api{}).internalCheckQuestion(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		var body struct{ Problem string }
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Problem
	}
	valid := `{"id":"q","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[0]},"marks":1,"solution":[]}]}`
	if problem := check(valid); problem != "" {
		t.Fatalf("valid question refused: %s", problem)
	}
	open := `{"id":"q","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p","blocks":[{"type":"text","text":"Show"}],"answer":{"type":"open","accepted":[],"hints":[]},"marks":3,"markscheme":[{"text":"1M","marks":1}],"solution":[]}]}`
	if problem := check(open); !strings.Contains(problem, "marking items must add up") {
		t.Fatalf("problem = %q", problem)
	}
}

func TestPipelineExtractionErrorKeepsTheRefusal(t *testing.T) {
	mapped := pipelineExtractionError(&pipeline.Error{Path: "/extract", Status: http.StatusBadRequest,
		Body: []byte(`{"code":"page_out_of_range","message":"paper.pdf has 16 pages; page 17 is past its end."}`)})
	var model *huma.ErrorModel
	if !errors.As(mapped, &model) || model.Status != http.StatusBadRequest || model.Errors[0].Message != "page_out_of_range" || !strings.Contains(model.Detail, "page 17") {
		t.Fatalf("mapped = %#v", mapped)
	}
	if pipelineExtractionError(&pipeline.Error{Path: "/extract", Status: http.StatusServiceUnavailable, Body: []byte(`{"code":"provider_busy","message":"busy"}`)}) != nil {
		t.Fatal("a busy answer is not a refusal")
	}
}
