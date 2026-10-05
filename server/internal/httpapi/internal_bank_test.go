package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The retrieval service walks and reads the bank through Go, and
// copy_questions copies questions into a quiz with a credit per question.
func TestInternalBankListsReadsAndCopiesWithCredits(t *testing.T) {
	const assets = "https://bank.example/assets"
	questions.QuizBankAssetsURL = assets
	t.Cleanup(func() { questions.QuizBankAssetsURL = "" })
	var bankStore *bank.Store
	h, st, _, _ := openInternalHTTPWith(t, nil, func(st *store.Store, c *httpapi.Config) {
		bankDSN, pool := openTestBank(t, st, testdb.URL(t))
		question := func(id, figure string) string {
			stem := `{"type":"text","text":"Passage ` + id + `"}`
			if figure != "" {
				stem += `,{"type":"image","image":{"url":"` + figure + `"},"width":400,"height":300,"description":"A figure"}`
			}
			return `{"id":"` + id + `","stem":[` + stem + `],"parts":[{"id":"` + id + `p","blocks":[{"type":"text","text":"Which?"}],"answer":{"type":"mcq","options":["A","B"],"correct":[0]},"marks":1,"solution":[{"type":"text","text":"A."}]}],"layout":"paper","labels":"letters"}`
		}
		web := `[{"kind":"web","url":"https://open.example/essay","title":"An essay","authors":["Writer"],"license":"CC BY-SA 4.0","retrievedAt":"2026-10-02"}]`
		ctx := context.Background()
		for i, row := range [][3]string{
			{"bq1", question("bq1", assets+"/figure.png"), web},
			{"bq2", question("bq2", ""), "[]"},
			{"bq3", question("bq3", ""), web},
		} {
			if _, err := pool.Exec(ctx, `INSERT INTO questions(id,topic_id,position,content,sources,run)VALUES($1,'t',$2,$3,$4,'test')`,
				row[0], i+1, row[1], row[2]); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `UPDATE questions SET content=jsonb_set(content,'{parts,0,answer}','{"type":"boolean","correct":true}') WHERE id='bq2'`); err != nil {
			t.Fatal(err)
		}
		bankStore = bank.New(bankDSN, "", assets, bankDSN)
		t.Cleanup(bankStore.Close)
		c.Bank = bankStore
	})
	post := func(path string, body map[string]any) (int, map[string]any) {
		t.Helper()
		rec := doInternal(t, h, "POST", path, pipeSecret, body)
		out := map[string]any{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	code, catalog := post("/api/internal/bank/list", map[string]any{"userId": "u_editor"})
	subjects, _ := catalog["subjects"].([]any)
	if code != 200 || len(subjects) != 1 || subjects[0].(map[string]any)["questions"].(float64) != 3 {
		t.Fatalf("catalog: %d %v", code, catalog)
	}
	if code, topics := post("/api/internal/bank/list", map[string]any{"userId": "u_editor", "subjectId": "s"}); code != 200 || len(topics["topics"].([]any)) != 1 {
		t.Fatalf("topics: %d %v", code, topics)
	}
	if code, _ := post("/api/internal/bank/list", map[string]any{"userId": "u_editor", "subjectId": "nope"}); code != 404 {
		t.Fatalf("unknown subject: %d", code)
	}
	if code, page := post("/api/internal/bank/list", map[string]any{"userId": "u_editor", "topicId": "t", "offset": 1}); code != 200 || page["total"].(float64) != 3 || len(page["questions"].([]any)) != 2 {
		t.Fatalf("page: %d %v", code, page)
	}
	// An answer type keeps a topic's questions with a part of that type, and needs the topic.
	code, typed := post("/api/internal/bank/list", map[string]any{"userId": "u_editor", "topicId": "t", "answerType": "boolean"})
	if rows, _ := typed["questions"].([]any); code != 200 || typed["total"].(float64) != 1 || len(rows) != 1 || rows[0].(map[string]any)["id"] != "bq2" ||
		rows[0].(map[string]any)["answerTypes"].([]any)[0] != "boolean" {
		t.Fatalf("typed page: %d %v", code, typed)
	}
	if code, _ := post("/api/internal/bank/list", map[string]any{"userId": "u_editor", "subjectId": "s", "answerType": "boolean"}); code != 400 {
		t.Fatalf("answer type without a topic: %d", code)
	}
	if code, read := post("/api/internal/bank/read", map[string]any{"userId": "u_editor", "questionId": "bq1"}); code != 200 || len(read["sources"].([]any)) != 1 {
		t.Fatalf("read: %d %v", code, read)
	}

	// The collaboration service applies an append; this one records what it was handed.
	var sent struct {
		Commands   []map[string]any  `json:"commands"`
		Provenance *store.Provenance `json:"provenance"`
	}
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	msg := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	copyBody := func(call string, ids []string, extra map[string]any) map[string]any {
		body := map[string]any{"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"assistantMessageId": msg, "toolCallId": call, "questionIds": ids}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	for _, refused := range []map[string]any{
		copyBody("r1", []string{"bq1"}, map[string]any{"title": "T", "quizId": "x"}),
		copyBody("r2", []string{"bq1"}, nil),
		copyBody("r3", []string{"bq1", "bq1"}, map[string]any{"title": "T"}),
	} {
		if code, _ := post("/api/internal/bank/copy", refused); code != 400 {
			t.Fatalf("copy should refuse %v: %d", refused, code)
		}
	}
	if code, _ := post("/api/internal/bank/copy", copyBody("r4", []string{"missing"}, map[string]any{"title": "T"})); code != 404 {
		t.Fatalf("unknown question: %d", code)
	}

	code, receipt := post("/api/internal/bank/copy", copyBody("c1", []string{"bq1", "bq2"}, map[string]any{"title": "Bank practice"}))
	if code != 200 {
		t.Fatalf("copy to a new quiz: %d %v", code, receipt)
	}
	quizID := receipt["effect"].(map[string]any)["resource"].(map[string]any)["id"].(string)
	quiz, err := st.GetMaterial(context.Background(), quizID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _, err := materialdoc.ExtractQuiz(quiz.Content)
	if err != nil {
		t.Fatal(err)
	}
	var copied []map[string]any
	if err := json.Unmarshal(raw, &copied); err != nil {
		t.Fatal(err)
	}
	if len(copied) != 2 || copied[0]["id"] != "bq1" || !strings.Contains(string(raw), assets+"/figure.png") {
		t.Fatalf("copied questions: %s", raw)
	}
	credits := quiz.Provenance.Questions
	if len(quiz.Provenance.Books) != 0 || len(credits) != 1 || credits["bq1"].Web[0].URL != "https://open.example/essay" ||
		credits["bq1"].License != "CC BY-SA 4.0" {
		t.Fatalf("question credits: %#v", quiz.Provenance)
	}

	code, receipt = post("/api/internal/bank/copy", copyBody("c2", []string{"bq3"}, map[string]any{"quizId": quizID}))
	if code != 200 {
		t.Fatalf("copy into the quiz: %d %v", code, receipt)
	}
	if len(sent.Commands) != 1 || sent.Commands[0]["afterNodeId"] != "bq2" {
		t.Fatalf("append after the last question: %v", sent.Commands)
	}
	if merged := sent.Provenance.Questions; len(merged) != 2 || merged["bq3"].Web == nil || merged["bq3"].License != "CC BY-SA 4.0" {
		t.Fatalf("merged credits: %#v", sent.Provenance)
	}
	// A question without sources needs no indexed workspace content either.
	if _, err := st.Pool().Exec(context.Background(), `UPDATE files SET indexed=false WHERE id='f_e2e_private'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `UPDATE files SET indexed=true WHERE id='f_e2e_private'`)
	})
	if code, receipt := post("/api/internal/bank/copy", copyBody("c3", []string{"bq2"}, map[string]any{"title": "Unsourced"})); code != 200 {
		t.Fatalf("copy without sources into an unindexed workspace: %d %v", code, receipt)
	}

	// The bank page copies the same way for a signed-in editor of the workspace.
	pageCopy := func(user string, body map[string]any) (int, map[string]any) {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/bank/copy", user, body)
		out := map[string]any{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	newQuiz := map[string]any{"questionIds": []string{"bq3", "bq2"}, "workspaceId": "ws_e2e_private", "chapterId": "ch_e2e_private", "quizName": "From the bank"}
	if code, _ := pageCopy("u_viewer", newQuiz); code != 404 {
		t.Fatalf("viewer copy: %d", code)
	}
	for _, refused := range []map[string]any{
		{"questionIds": []string{"bq3"}, "workspaceId": "ws_e2e_private", "quizName": "T", "quizId": quizID},
		{"questionIds": []string{"bq3"}, "workspaceId": "ws_e2e_private"},
		{"questionIds": []string{"bq3"}, "workspaceId": "ws_e2e_private", "quizId": quizID, "chapterId": "ch_e2e_private"},
	} {
		if code, _ := pageCopy("u_editor", refused); code != 422 {
			t.Fatalf("page copy should refuse %v: %d", refused, code)
		}
	}
	code, made := pageCopy("u_editor", newQuiz)
	if code != 200 || made["workspaceId"] != "ws_e2e_private" {
		t.Fatalf("page copy to a new quiz: %d %v", code, made)
	}
	quiz, err = st.GetMaterial(context.Background(), made["quizId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if raw, _, err = materialdoc.ExtractQuiz(quiz.Content); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &copied); err != nil || len(copied) != 2 || copied[0]["id"] != "bq3" ||
		quiz.Title != "From the bank" || quiz.ChapterID == nil || *quiz.ChapterID != "ch_e2e_private" {
		t.Fatalf("page copy: %s %+v", raw, quiz)
	}
	if credits := quiz.Provenance.Questions; len(credits) != 1 || credits["bq3"].License != "CC BY-SA 4.0" {
		t.Fatalf("page copy credits: %#v", quiz.Provenance)
	}
	code, appended := pageCopy("u_editor", map[string]any{"questionIds": []string{"bq1"}, "workspaceId": "ws_e2e_private", "quizId": quiz.ID})
	if code != 200 || appended["quizId"] != quiz.ID {
		t.Fatalf("page copy into the quiz: %d %v", code, appended)
	}
	if len(sent.Commands) != 1 || sent.Commands[0]["afterNodeId"] != "bq2" {
		t.Fatalf("page append after the last question: %v", sent.Commands)
	}
	if merged := sent.Provenance.Questions; len(merged) != 2 || merged["bq1"].Web == nil || merged["bq3"].Web == nil {
		t.Fatalf("page copy merged credits: %#v", sent.Provenance)
	}

	// The model's own writes still may not claim a question credit.
	forged := noteBody(msg, "f1", "Forged", "text")
	forged["provenance"] = map[string]any{"books": []any{}, "questions": map[string]any{"q": map[string]any{"books": []any{}}}}
	if code, _ := post("/api/internal/materials", forged); code != 400 {
		t.Fatalf("model-supplied question credit: %d", code)
	}
}
