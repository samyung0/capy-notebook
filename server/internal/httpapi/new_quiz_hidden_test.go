package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// TestEditorsQuizStartsHidden: a quiz an editor makes in a workspace starts
// hidden from its members until shown (Epo 2026-11-16): the editor reads it
// with the flag, a viewer member gets not found.
func TestEditorsQuizStartsHidden(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_editor", map[string]any{
		"name": fmt.Sprintf("Starts hidden %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "q1:part:1", "blocks": []map[string]any{{"type": "text", "text": "Pick the second"}},
				"answer": map[string]any{"type": "mcq", "options": []string{"a", "b"}, "correct": []int{1}},
				"marks":  1, "solution": []any{},
			}},
		}},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var made struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_editor", nil) })

	read := doReq(t, h, http.MethodGet, "/api/materials/"+made.ID, "u_editor", nil)
	var material struct {
		Hidden bool `json:"hidden"`
	}
	if err := json.Unmarshal(read.Body.Bytes(), &material); err != nil || read.Code != http.StatusOK || !material.Hidden {
		t.Fatalf("editor reads it: status = %d hidden = %v body=%s", read.Code, material.Hidden, read.Body.String())
	}
	if rec := doReq(t, h, http.MethodGet, "/api/materials/"+made.ID, "u_viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("viewer reads it: status = %d", rec.Code)
	}
}
