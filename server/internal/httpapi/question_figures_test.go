package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// TestQuestionImageGoesToTheGrader (Epo 2026-11-23): an open part is graded
// with its question's stored image, numbered in its text.
func TestQuestionImageGoesToTheGrader(t *testing.T) {
	h, st, _, mem := openGradingAPIWithBlob(t, "full")
	image := fmt.Sprintf("asset_qi_%d", time.Now().UnixNano())
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": "Figure " + image, "privacy": "private",
		"questions": []any{map[string]any{
			"id": "q1", "layout": "paper", "labels": "letters",
			"stem": []any{map[string]any{"type": "image", "image": map[string]any{"assetId": image}, "width": 4, "height": 3, "description": "A demand curve"}},
			"parts": []any{map[string]any{"id": "open-a", "blocks": []any{map[string]any{"type": "text", "text": "Read the price at Q = 5."}},
				"answer": map[string]any{"type": "open", "accepted": []any{"$4"}}, "marks": 1,
				"markscheme": []any{map[string]any{"text": "Reads $4 from Figure 1", "marks": 1}}, "solution": []any{}}},
		}},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz → %d %s", rec.Code, rec.Body.String())
	}
	var quiz struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+quiz.ID, "u_owner", nil) })

	var png bytes.Buffer
	if err := pngEncode(&png); err != nil {
		t.Fatal(err)
	}
	path := "editor-assets/" + image + "/blob"
	if _, _, err := mem.Put(path, bytes.NewReader(png.Bytes())); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(context.Background(), `INSERT INTO editor_assets
		(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,'u_owner','u_owner','figure','image',$3,'image/png',$4,'ready',now())`,
		image, quiz.ID, path, png.Len()); err != nil {
		t.Fatal(err)
	}

	before := gradedFigures.Load()
	rec = doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz.ID+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"open-a": "The price is $4."},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	var detail struct{ Questions []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	if part := gradedParts(t, detail.Questions)["open-a"]; part["awarded"] != float64(1) {
		t.Fatalf("the part = %+v, want marked", part)
	}
	if sent := gradedFigures.Load() - before; sent != 1 {
		t.Fatalf("the question's image went %d times, want once", sent)
	}
}
