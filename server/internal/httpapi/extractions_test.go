package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
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

// A finished run's figures become the quiz's own editor assets, charged to
// the starter like images it uploads (M16), and the quiz's image blocks point
// at them. Needs Postgres (CI).
func TestFinishedExtractionStoresItsFiguresAsTheQuizsAssets(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	mem := blob.NewMemory()
	a := &api{s: st, blob: mem}
	run, err := st.CreateExtraction(ctx, "ws_e2e_private", "u_editor", "Figures "+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	var crop bytes.Buffer
	if err := jpeg.Encode(&crop, image.NewGray(image.Rect(0, 0, 40, 30)), nil); err != nil {
		t.Fatal(err)
	}
	question := `[{"id":"q8","stem":[{"type":"text","text":"In the figure, ABC is a triangle."},` +
		`{"type":"image","image":{"assetId":"figure:q8-1"},"width":40,"height":30,"description":"Triangle ABC"}],` +
		`"layout":"paper","labels":"letters","parts":[{"id":"p","blocks":[{"type":"text","text":"Find x."}],` +
		`"answer":{"type":"short","accepted":["3"]},"marks":1,"solution":[]}]}]`
	ended := a.finishExtraction(ctx, run, "u_editor", "E2E Private Workspace", extractionEvent{
		Type: "done", Questions: json.RawMessage(question), Report: json.RawMessage(`{}`),
		Figures: []agentFigure{{ID: "q8-1", Image: crop.Bytes()}},
	})
	if ended.Status != store.ExtractionDone || ended.QuizID == nil {
		t.Fatalf("run = %+v", ended)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, *ended.QuizID)
	})
	assetID := store.ChatAssetID(run.ID, "extraction/figure/q8-1")
	asset, err := st.GetEditorAsset(ctx, assetID)
	if err != nil || asset.MaterialID != *ended.QuizID || asset.UserID != "u_editor" || asset.SizeBytes != int64(crop.Len()) {
		t.Fatalf("asset = %+v (%v)", asset, err)
	}
	quiz, err := st.GetMaterial(ctx, *ended.QuizID)
	if err != nil || !strings.Contains(quiz.Content, assetID) || strings.Contains(quiz.Content, "figure:q8-1") {
		t.Fatalf("quiz content does not point at %s (%v)", assetID, err)
	}
	if listing, err := mem.ListObjects(ctx, "editor-assets/"+assetID+"/", "", 10); err != nil || len(listing.Keys) != 1 {
		t.Fatalf("stored objects = %+v (%v)", listing, err)
	}
}
