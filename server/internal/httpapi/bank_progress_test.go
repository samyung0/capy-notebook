package httpapi_test

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// insertBankQuestions adds closed bank questions to topic t, in order.
func insertBankQuestions(t *testing.T, pool *pgxpool.Pool, ids ...string) {
	t.Helper()
	for i, id := range ids {
		q := `{"id":"` + id + `","stem":[{"type":"text","text":"Passage ` + id + `"}],"parts":[{"id":"` + id + `p","blocks":[{"type":"text","text":"Which?"}],"answer":{"type":"mcq","options":["A","B"],"correct":[0]},"marks":1,"solution":[{"type":"text","text":"A."}]}],"layout":"paper","labels":"letters"}`
		if _, err := pool.Exec(context.Background(), `INSERT INTO questions(id,topic_id,position,content,run)VALUES($1,'t',$2,$3,'test')`, id, i+1, q); err != nil {
			t.Fatal(err)
		}
	}
}

// Learners reveal one checked question's key, record checked answers and read
// back their latest scores and topic progress; a prompt edit or a retraction
// takes a question out, and retracted questions leave every bank list, read,
// reveal and copy.
func TestBankProgressAndRetraction(t *testing.T) {
	var pool *pgxpool.Pool
	h, st, _, _ := openInternalHTTPWith(t, nil, func(st *store.Store, c *httpapi.Config) {
		var bankDSN string
		bankDSN, pool = openTestBank(t, st, testdb.URL(t))
		insertBankQuestions(t, pool, "bp1", "bp2", "bp3", "bp4")
		c.Bank = bank.New(bankDSN, "", "https://bank.example/assets", bankDSN)
		t.Cleanup(c.Bank.Close)
	})
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM bank_progress WHERE question_id LIKE 'bp%'`)
	})
	const learner = "u_viewer"
	answer := func(id string, score float64) int {
		t.Helper()
		return doReq(t, h, http.MethodPost, "/api/bank/questions/"+id+"/answers", learner, map[string]any{"score": score}).Code
	}
	marks := func(user string) map[string]float64 {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, "/api/bank/topics/t/marks", user, nil)
		var out struct{ Marks map[string]float64 }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 {
			t.Fatalf("marks: %d %s", rec.Code, rec.Body.String())
		}
		return out.Marks
	}
	progress := func(user string) []bank.TopicProgress {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, "/api/bank/progress", user, nil)
		var out struct{ Topics []bank.TopicProgress }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 {
			t.Fatalf("progress: %d %s", rec.Code, rec.Body.String())
		}
		return out.Topics
	}

	// The key of one question, as the reveal route or a read returns it.
	key := func(user, method, path string, body any) (int, map[string]any) {
		t.Helper()
		rec := doReq(t, h, method, path, user, body)
		var out struct{ Question map[string]any }
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out.Question == nil {
			return rec.Code, nil
		}
		part := out.Question["parts"].([]any)[0].(map[string]any)
		return rec.Code, map[string]any{"correct": part["answer"].(map[string]any)["correct"], "solution": part["solution"]}
	}
	checked := map[string]any{"answers": map[string]any{"bp1p": []int{1}}}
	if code, got := key(learner, http.MethodPost, "/api/bank/questions/bp1/reveal", checked); code != 200 || got["correct"] == nil || got["solution"] == nil {
		t.Fatalf("reveal = %d %v", code, got)
	}
	if code, _ := key("", http.MethodPost, "/api/bank/questions/bp1/reveal", checked); code != 401 {
		t.Fatalf("signed-out reveal = %d", code)
	}
	for _, id := range []string{"bp1", "bp2"} {
		if code, got := key(learner, http.MethodGet, "/api/bank/questions/"+id, nil); code != 200 || got["correct"] != nil || got["solution"] != nil {
			t.Fatalf("read %s after a reveal = %d %v", id, code, got)
		}
	}
	if code := doReq(t, h, http.MethodPost, "/api/bank/questions/bp1/answers", "", map[string]any{"score": 1}).Code; code != 401 {
		t.Fatalf("signed-out answer = %d", code)
	}
	if code := answer("bp1", 1.5); code != 422 {
		t.Fatalf("score above 1 = %d", code)
	}
	if got := progress(learner); len(got) != 0 {
		t.Fatalf("progress before answering = %v", got)
	}
	// In order, so bp3 is the latest answer and Continue wraps past bp4's gap.
	for _, a := range []struct {
		id    string
		score float64
	}{{"bp1", 0}, {"bp2", 1}, {"bp3", 0.5}} {
		if code := answer(a.id, a.score); code != 204 {
			t.Fatalf("answer %s = %d", a.id, code)
		}
	}
	if got := marks(learner); !maps.Equal(got, map[string]float64{"bp1": 0, "bp2": 1, "bp3": 0.5}) {
		t.Fatalf("marks = %v", got)
	}
	if got := marks("u_editor"); len(got) != 0 {
		t.Fatalf("another learner's marks = %v", got)
	}
	if got := progress(learner); len(got) != 1 || got[0].TopicID != "t" || got[0].TopicLabel != "Topic" || got[0].ExamID != "e" ||
		got[0].Total != 4 || got[0].Answered != 3 || got[0].Correct != 1 || got[0].NextQuestionID == nil || *got[0].NextQuestionID != "bp4" {
		t.Fatalf("progress = %+v", got)
	}
	if code := doReq(t, h, http.MethodGet, "/api/bank/progress", "", nil).Code; code != 401 {
		t.Fatalf("signed-out progress = %d", code)
	}

	if code := doReq(t, h, http.MethodGet, "/api/bank/topics/missing/marks", learner, nil).Code; code != 404 {
		t.Fatalf("unknown topic marks = %d", code)
	}

	// A new prompt makes bp2 a new question; retracting bp1 removes it.
	if _, err := pool.Exec(ctx, `UPDATE questions SET content=jsonb_set(content,'{parts,0,blocks,0,text}','"Which one?"') WHERE id='bp2';
		UPDATE questions SET retracted_at=now() WHERE id='bp1'`); err != nil {
		t.Fatal(err)
	}
	if got := marks(learner); !maps.Equal(got, map[string]float64{"bp3": 0.5}) {
		t.Fatalf("marks after edit and retraction = %v", got)
	}
	// bp2 counts as unanswered again; after the latest answer (bp3) comes bp4.
	if got := progress(learner); len(got) != 1 || got[0].Total != 3 || got[0].Answered != 1 || got[0].Correct != 0 || *got[0].NextQuestionID != "bp4" {
		t.Fatalf("progress after edit and retraction = %+v", got)
	}
	for _, id := range []string{"bp2", "bp4"} {
		if code := answer(id, 1); code != 204 {
			t.Fatalf("answer %s = %d", id, code)
		}
	}
	if got := progress(learner); len(got) != 1 || got[0].Answered != 3 || got[0].Correct != 2 || got[0].NextQuestionID != nil {
		t.Fatalf("progress with every question answered = %+v", got)
	}
	if code := answer("bp1", 1); code != 404 {
		t.Fatalf("answer a retracted question = %d", code)
	}
	if code, _ := key(learner, http.MethodPost, "/api/bank/questions/bp1/reveal", checked); code != 404 {
		t.Fatalf("reveal a retracted question = %d", code)
	}

	list := doReq(t, h, http.MethodGet, "/api/bank/topics/t/questions", learner, nil)
	var rows struct{ Questions []bank.Row }
	if err := json.Unmarshal(list.Body.Bytes(), &rows); err != nil || len(rows.Questions) != 3 || rows.Questions[0].ID != "bp2" ||
		!slices.Equal(rows.Questions[0].AnswerTypes, []string{"mcq"}) {
		t.Fatalf("list: %d %s", list.Code, list.Body.String())
	}
	syllabus := doReq(t, h, http.MethodGet, "/api/bank/syllabus", learner, nil)
	var tree bank.Syllabus
	if err := json.Unmarshal(syllabus.Body.Bytes(), &tree); err != nil || tree.Exams[0].Subjects[0].Topics[0].Total != 3 {
		t.Fatalf("syllabus: %d %s", syllabus.Code, syllabus.Body.String())
	}
	for _, path := range []string{"/api/bank/questions/bp1", "/api/bank/questions?ids=bp2,bp1"} {
		if code := doReq(t, h, http.MethodGet, path, learner, nil).Code; code != 404 {
			t.Fatalf("%s = %d", path, code)
		}
	}
	internal := func(path string, body map[string]any) (int, map[string]any) {
		t.Helper()
		rec := doInternal(t, h, http.MethodPost, path, pipeSecret, body)
		out := map[string]any{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	if code, page := internal("/api/internal/bank/list", map[string]any{"userId": "u_editor", "topicId": "t"}); code != 200 || page["total"].(float64) != 3 {
		t.Fatalf("internal page: %d %v", code, page)
	}
	if code, _ := internal("/api/internal/bank/read", map[string]any{"userId": "u_editor", "questionId": "bp1"}); code != 404 {
		t.Fatalf("internal read of a retracted question = %d", code)
	}
	if code, _ := internal("/api/internal/bank/copy", map[string]any{"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": "m", "toolCallId": "c", "questionIds": []string{"bp1"}, "title": "T"}); code != 404 {
		t.Fatalf("internal copy of a retracted question = %d", code)
	}
	if code := doReq(t, h, http.MethodPost, "/api/bank/copy", "u_editor", map[string]any{
		"questionIds": []string{"bp1"}, "workspaceId": "ws_e2e_private", "quizName": "T"}).Code; code != 404 {
		t.Fatalf("copy of a retracted question = %d", code)
	}
}

// A frozen account records its own bank progress, as in workspace review, but
// copies nothing into a workspace.
func TestFrozenAccountRecordsBankAnswers(t *testing.T) {
	f := overQuotaFixture(t, 20)
	frozen := f.material.CreatedBy
	bankDSN, pool := openTestBank(t, f.store, testdb.URL(t))
	insertBankQuestions(t, pool, "fz1")
	bankStore := bank.New(bankDSN, "", "https://bank.example/assets", bankDSN)
	t.Cleanup(bankStore.Close)
	h := httpapi.New(f.store, blob.NewMemory(), nil, nil, "docling", httpapi.Config{AuthDisabled: true, DevUserID: frozen, Bank: bankStore})
	// Before the fixture drops the user, whose foreign key does not cascade.
	t.Cleanup(func() {
		_, _ = f.store.Pool().Exec(context.Background(), `DELETE FROM bank_progress WHERE user_id=$1`, frozen)
	})
	if rec := doReq(t, h, http.MethodPost, "/api/bank/questions/fz1/answers", "", map[string]any{"score": 0}); rec.Code != 204 {
		t.Fatalf("frozen answer = %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, "/api/bank/copy", "", map[string]any{
		"questionIds": []string{"fz1"}, "workspaceId": f.workspaceID, "quizName": "Frozen"}); rec.Code != 403 {
		t.Fatalf("frozen copy = %d %s", rec.Code, rec.Body.String())
	}
}
