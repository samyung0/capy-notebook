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
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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
	if err := st.LoadPlanLimits(ctx); err != nil {
		t.Fatal(err)
	}
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

// A run's questions lose only their cropped figures, and the report moves
// their questions to figuresLeftOut.
func TestFiguresLeftOutOfAQuiz(t *testing.T) {
	question := `[{"id":"q8","stem":[{"type":"text","text":"In the figure"},` +
		`{"type":"image","image":{"assetId":"figure:q8-1"},"width":40,"height":30},` +
		`{"type":"image","image":{"assetId":"asset_upload"},"width":4,"height":3}],` +
		`"layout":"paper","labels":"letters","parts":[{"id":"p","blocks":[{"type":"text","text":"Find x."}],` +
		`"answer":{"type":"short","accepted":["3"]},"marks":1,"solution":[]}]}]`
	bare, ok := withoutFigures(json.RawMessage(question))
	if !ok || strings.Contains(string(bare), "figure:") || !strings.Contains(string(bare), "asset_upload") {
		t.Fatalf("bare = %s (%v)", bare, ok)
	}
	var report store.ExtractionReport
	moved := figuresLeftOut(json.RawMessage(`{"figures":["8","9"],"figuresLeftOut":["3"]}`))
	if err := json.Unmarshal(moved, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Figures) != 0 || strings.Join(report.FiguresLeftOut, ",") != "3,8,9" {
		t.Fatalf("report = %+v", report)
	}
}

// The report names parts saved with no answer, and says nothing of them when
// there are none; a question with no key travels as an open part whose one marking item says so, which the
// quiz's validator takes.
func TestAReportNamesMissingAnswers(t *testing.T) {
	var report store.ExtractionReport
	raw := `{"recorded":["1","2"],"answersMissing":["2(a)"],"windows":1}`
	if err := json.Unmarshal([]byte(raw), &report); err != nil {
		t.Fatal(err)
	}
	if strings.Join(report.AnswersMissing, ",") != "2(a)" {
		t.Fatalf("report = %+v", report)
	}
	empty, err := json.Marshal(store.ExtractionReport{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "answersMissing") {
		t.Fatalf("empty report = %s", empty)
	}
}

// A run's questions split in printed order: the ones QuizDocument takes, and for
// the rest the room's node after the question printed before it.
func TestAnIncompleteQuestionIsKeptForTheRoom(t *testing.T) {
	question := func(id, answer string) string {
		return `{"id":"` + id + `","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p` + id + `",` +
			`"blocks":[{"type":"text","text":"Pick."}],"answer":` + answer + `,"marks":1,"solution":[]}]}`
	}
	keyed := `{"type":"mcq","options":["a","b"],"correct":[1]}`
	none := `{"type":"mcq","options":["a","b"],"correct":[]}`
	raw := "[" + question("q1", none) + "," + question("q2", keyed) + "," + question("q3", none) + "]"
	complete, incomplete, err := materialdoc.SplitIncomplete(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := materialdoc.QuizDocument(complete, nil); err != nil {
		t.Fatalf("complete questions refused: %v", err)
	}
	var kept []map[string]any
	if err := json.Unmarshal(complete, &kept); err != nil || len(kept) != 1 || kept[0]["id"] != "q2" {
		t.Fatalf("complete = %s (%v)", complete, err)
	}
	if len(incomplete) != 2 || incomplete[0].After != "" || incomplete[1].After != "q2" ||
		incomplete[0].Node["type"] != "quiz_question" || incomplete[1].Node["id"] != "q3" {
		t.Fatalf("incomplete = %+v", incomplete)
	}
}

// A quiz whose questions all lack answers still saves: an empty quiz, its
// questions sent to the authority in printed order, and the report keeps naming
// the parts. If the authority refuses, they are named as questions with no copy.
// Needs Postgres (CI).
func TestAQuizWithNoAnswersSavesAndGoesToTheRoom(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.LoadPlanLimits(ctx); err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Target   store.DocumentTarget `json:"target"`
		Commands []struct {
			Type        string          `json:"type"`
			ParentType  string          `json:"parentType"`
			AfterNodeID *string         `json:"afterNodeId"`
			Node        json.RawMessage `json:"node"`
		} `json:"commands"`
	}
	refuse := false
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if refuse {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"operationId":"op","kind":"edit_document","toolVersion":1,"outcome":"succeeded"}`))
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	a := &api{s: st, blob: blob.NewMemory()}
	questions := `[{"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p1",` +
		`"blocks":[{"type":"text","text":"Pick."}],"answer":{"type":"mcq","options":["a","b"],"correct":[]},"marks":1,"solution":[]}]},` +
		`{"id":"q2","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p2",` +
		`"blocks":[{"type":"text","text":"Name."}],"answer":{"type":"short","accepted":[]},"marks":1,"solution":[]}]}]`
	finish := func(title string) store.Extraction {
		run, err := st.CreateExtraction(ctx, "ws_e2e_private", "u_editor", title+" "+uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		ended := a.finishExtraction(ctx, run, "u_editor", "E2E Private Workspace", extractionEvent{
			Type: "done", Questions: json.RawMessage(questions),
			Report: json.RawMessage(`{"missing":["3"],"answersMissing":["1","2"]}`),
		})
		if ended.Status != store.ExtractionDone || ended.QuizID == nil {
			code, message := "", ""
			if ended.ErrorCode != nil {
				code = *ended.ErrorCode
			}
			if ended.Error != nil {
				message = *ended.Error
			}
			t.Fatalf("run ended %s: %s: %s", ended.Status, code, message)
		}
		t.Cleanup(func() {
			_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, *ended.QuizID)
		})
		return ended
	}
	ended := finish("No answers")
	if sent.Target.ID != *ended.QuizID || len(sent.Commands) != 2 || sent.Commands[0].Type != "insert_child" ||
		sent.Commands[0].ParentType != "quiz" || sent.Commands[0].AfterNodeID != nil ||
		sent.Commands[1].AfterNodeID == nil || *sent.Commands[1].AfterNodeID != "q1" {
		t.Fatalf("sent = %+v", sent)
	}
	if strings.Join(ended.Report.AnswersMissing, ",") != "1,2" {
		t.Fatalf("report = %+v", ended.Report)
	}
	refuse = true
	left := finish("Left out")
	if strings.Join(left.Report.Missing, ",") != "3,1,2" || len(left.Report.AnswersMissing) != 0 {
		t.Fatalf("report = %+v", left.Report)
	}
}

// A starter whose storage has room for the quiz but not its figures gets
// the quiz without them, its figures named in the report and no asset
// stored (Epo 2026-11-04). Needs Postgres (CI).
func TestAFullStarterGetsTheQuizWithoutItsFigures(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.LoadPlanLimits(ctx); err != nil {
		t.Fatal(err)
	}
	user := "u_extract_full_" + uuid.NewString()[:8]
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Full',$2)`, user, user+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user) })
	ws, err := st.CreateWorkspace(ctx, user, store.WorkspaceCreate{Name: "Quiz", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws.ID) })
	usage, err := st.StorageUsage(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	// Room for the quiz (a few KB), not for a 300 KB figure.
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1,$2)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
		user, usage.LimitBytes-100_000); err != nil {
		t.Fatal(err)
	}
	mem := blob.NewMemory()
	a := &api{s: st, blob: mem}
	run, err := st.CreateExtraction(ctx, ws.ID, user, "Full "+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	var crop bytes.Buffer
	if err := jpeg.Encode(&crop, image.NewGray(image.Rect(0, 0, 40, 30)), nil); err != nil {
		t.Fatal(err)
	}
	padded := append(crop.Bytes(), bytes.Repeat([]byte{7}, 300_000)...)
	question := `[{"id":"q8","stem":[{"type":"text","text":"In the figure, ABC is a triangle."},` +
		`{"type":"image","image":{"assetId":"figure:q8-1"},"width":40,"height":30}],` +
		`"layout":"paper","labels":"letters","parts":[{"id":"p","blocks":[{"type":"text","text":"Find x."}],` +
		`"answer":{"type":"short","accepted":["3"]},"marks":1,"solution":[]}]}]`
	ended := a.finishExtraction(ctx, run, user, "Quiz", extractionEvent{
		Type: "done", Questions: json.RawMessage(question),
		Report:  json.RawMessage(`{"figures":["8"],"figuresLeftOut":[]}`),
		Figures: []agentFigure{{ID: "q8-1", Image: padded}},
	})
	if ended.Status != store.ExtractionDone || ended.QuizID == nil || ended.Report == nil ||
		strings.Join(ended.Report.FiguresLeftOut, ",") != "8" || len(ended.Report.Figures) != 0 {
		t.Fatalf("run = %+v report = %+v", ended, ended.Report)
	}
	quiz, err := st.GetMaterial(ctx, *ended.QuizID)
	if err != nil || strings.Contains(quiz.Content, "asset_") || !strings.Contains(quiz.Content, "ABC is a triangle") {
		t.Fatalf("quiz content = %.200s (%v)", quiz.Content, err)
	}
	if _, err := st.GetEditorAsset(ctx, store.ChatAssetID(run.ID, "extraction/figure/q8-1")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("figure asset = %v, want none", err)
	}
	if listing, err := mem.ListObjects(ctx, "editor-assets/", "", 10); err != nil || len(listing.Keys) != 0 {
		t.Fatalf("stored objects = %+v (%v)", listing, err)
	}
}
