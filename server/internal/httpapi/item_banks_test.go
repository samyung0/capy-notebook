package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// The quiz editor's From the bank (Epo 2026-11-15): an editor of the quiz who
// reads the class bank gets the picked questions back as copies with fresh
// ids; a viewer of the quiz is answered not found.
func TestCopyBankQuestionsToQuiz(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
	question := map[string]any{
		"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": []map[string]any{{
			"id": "p1", "blocks": []map[string]any{{"type": "text", "text": "Name the process"}},
			"answer": map[string]any{"type": "short", "accepted": []string{"osmosis"}}, "marks": 1, "solution": []any{},
		}},
	}
	banked := doReq(t, h, http.MethodPost, "/api/item-banks/ws_e2e_private/questions", "u_owner", map[string]any{
		"question": question, "tags": []string{},
	})
	if banked.Code != http.StatusCreated {
		t.Fatalf("bank a question: status = %d body=%s", banked.Code, banked.Body.String())
	}
	var item struct{ ID string }
	_ = json.Unmarshal(banked.Body.Bytes(), &item)
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Bank copy %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{question},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct{ ID string }
	_ = json.Unmarshal(quiz.Body.Bytes(), &made)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })

	path := "/api/quizzes/" + made.ID + "/bank-questions"
	body := map[string]any{"bank": "ws_e2e_private", "questionIds": []string{item.ID}}
	rec := doReq(t, h, http.MethodPost, path, "u_editor", body)
	var out struct {
		Questions []map[string]any `json:"questions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK ||
		len(out.Questions) != 1 || out.Questions[0]["id"] == "q1" {
		t.Fatalf("an editor copies: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, path, "u_viewer", body); rec.Code != http.StatusNotFound {
		t.Fatalf("a viewer copies: status = %d body=%s", rec.Code, rec.Body.String())
	}
}
