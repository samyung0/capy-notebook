package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// drawingQuestion is one question whose one part, draw-a, is drawn; sample is
// its drawn sample answer, {board, image} asset ids, or nil.
func drawingQuestion(sample map[string]any) map[string]any {
	answer := map[string]any{"type": "drawing"}
	if sample != nil {
		answer["sample"] = sample
	}
	return map[string]any{
		"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": []any{map[string]any{"id": "draw-a", "blocks": []any{map[string]any{"type": "text", "text": "Draw it."}},
			"answer": answer, "marks": 2, "markscheme": []any{map[string]any{"text": "Shape", "marks": 2}}, "solution": []any{}}},
	}
}

// drawingQuiz is u_owner's private quiz of drawingQuestion(sample).
func drawingQuiz(t *testing.T, h http.Handler, sample map[string]any) string {
	t.Helper()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Drawn %d", time.Now().UnixNano()), "privacy": "private",
		"questions": []any{drawingQuestion(sample)},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz → %d %s", rec.Code, rec.Body.String())
	}
	var quiz struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+quiz.ID, "u_owner", nil) })
	return quiz.ID
}

// drawingAssignment gives a quiz of one drawing part to the seeded class's
// members, marked as marking says.
func drawingAssignment(t *testing.T, h http.Handler, marking string) string {
	t.Helper()
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Drawn %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []any{drawingQuestion(nil)},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct{ ID string }
	_ = json.Unmarshal(quiz.Body.Bytes(), &made)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })
	rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_owner", map[string]any{
		"kind": "marked", "title": "Drawn", "quizId": made.ID, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "noLate": false, "latePenaltyPct": 0, "assignAll": true, "assignees": []string{}, "draft": false,
		"marking": marking, "showAnswers": true, "shuffle": false, "files": []any{},
	})
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("create assignment: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var assignment struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &assignment)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+assignment.ID, "u_owner", nil) })
	return assignment.ID
}

func startDrawingAttempt(t *testing.T, h http.Handler, assignmentID, user string) string {
	t.Helper()
	run := doReq(t, h, http.MethodPost, "/api/assignments/"+assignmentID+"/start", user, map[string]any{})
	if run.Code != http.StatusOK && run.Code != http.StatusCreated {
		t.Fatalf("start: status = %d body=%s", run.Code, run.Body.String())
	}
	var attempt struct{ ID string }
	_ = json.Unmarshal(run.Body.Bytes(), &attempt)
	return attempt.ID
}

// drawingDone is what Done sends: a board and a marking image, base64.
func drawingDone(t *testing.T) map[string]any {
	t.Helper()
	var png bytes.Buffer
	if err := pngEncode(&png); err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"board": base64.StdEncoding.EncodeToString([]byte("a saved board")),
		"image": base64.StdEncoding.EncodeToString(png.Bytes()),
	}
}

func bucketKeys(t *testing.T, mem *blob.Memory, prefix string) []string {
	t.Helper()
	listing, err := mem.ListObjects(context.Background(), prefix, "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(listing.Keys))
	for _, key := range listing.Keys {
		keys = append(keys, key.Key)
	}
	return keys
}

// TestADrawingReachesTheBucketOnlyForItsOwnRunningAttempt (security regression,
// Epo 2026-11-07, Q693): a board and image sent for another member's attempt, an
// unknown one, or a malformed id are refused before anything is written under
// drawings/; the member's own Done writes its board and image, and only they
// forget it.
func TestADrawingReachesTheBucketOnlyForItsOwnRunningAttempt(t *testing.T) {
	h, st, _, mem := openGradingAPIWithBlob(t, "full")
	ctx := context.Background()
	id := drawingAssignment(t, h, "ai_approve")
	if _, err := st.Pool().Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ('ws_e2e_private', 'u_other', 'viewer') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM workspace_members WHERE workspace_id='ws_e2e_private' AND user_id='u_other'`)
	})
	attempt := startDrawingAttempt(t, h, id, "u_viewer")
	done := drawingDone(t)
	for _, refused := range []struct {
		user, path string
		status     int
	}{
		{"u_other", "/api/assignment-attempts/" + attempt + "/drawings/draw-a", http.StatusNotFound},
		{"u_owner", "/api/assignment-attempts/" + attempt + "/drawings/draw-a", http.StatusNotFound},
		{"u_viewer", "/api/assignment-attempts/at_0000000000/drawings/draw-a", http.StatusNotFound},
		{"u_viewer", "/api/assignment-attempts/" + attempt + "..x/drawings/draw-a", http.StatusUnprocessableEntity},
	} {
		expectStatus(t, doReq(t, h, http.MethodPut, refused.path, refused.user, done), refused.status, refused.user+" "+refused.path)
	}
	if keys := bucketKeys(t, mem, "drawings/"); len(keys) != 0 {
		t.Fatalf("refused drawings left %v in the bucket", keys)
	}

	expectStatus(t, doReq(t, h, http.MethodPut, "/api/assignment-attempts/"+attempt+"/drawings/draw-a", "u_viewer", done), http.StatusOK, "the member's Done")
	if keys := bucketKeys(t, mem, "drawings/"+attempt+"/"); len(keys) != 2 {
		t.Fatalf("the member's Done wrote %v, want a board and an image", keys)
	}
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/assignment-attempts/"+attempt+"/drawings/draw-a", "u_other", nil), http.StatusNotFound, "another member's delete")
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/assignment-attempts/"+attempt+"/drawings/draw-a", "u_viewer", nil), http.StatusNoContent, "the member's delete")
}

// TestManualGradingWritesNoMarkingImage: marked by hand, nothing reads a marking
// image, so the member's page makes none and the server writes none (Q693).
func TestManualGradingWritesNoMarkingImage(t *testing.T) {
	h, _, _, mem := openGradingAPIWithBlob(t, "full")
	id := drawingAssignment(t, h, "manual")
	attempt := startDrawingAttempt(t, h, id, "u_viewer")
	var view struct {
		DrawingImages bool `json:"drawingImages"`
	}
	_ = json.Unmarshal(doReq(t, h, http.MethodGet, "/api/assignment-attempts/"+attempt, "u_viewer", nil).Body.Bytes(), &view)
	if view.DrawingImages {
		t.Fatal("a manually graded attempt asks for marking images")
	}
	expectStatus(t, doReq(t, h, http.MethodPut, "/api/assignment-attempts/"+attempt+"/drawings/draw-a", "u_viewer", drawingDone(t)), http.StatusOK, "Done")
	keys := bucketKeys(t, mem, "drawings/"+attempt+"/")
	if len(keys) != 1 || !strings.HasSuffix(keys[0], ".ydoc.gz") {
		t.Fatalf("manual grading wrote %v, want the board alone", keys)
	}
}

// TestDrawnSampleOfAnotherMaterialIsNeverSent (security regression, Q693): a
// drawn sample answer naming another material's image is not read for the
// model, and the part stays Not marked; the quiz's own image goes with it.
func TestDrawnSampleOfAnotherMaterialIsNeverSent(t *testing.T) {
	h, st, _, mem := openGradingAPIWithBlob(t, "full")
	ctx := context.Background()
	other := drawingQuiz(t, h, nil)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	board, image := "asset_sb_"+suffix, "asset_si_"+suffix
	var png bytes.Buffer
	if err := pngEncode(&png); err != nil {
		t.Fatal(err)
	}
	for _, asset := range []struct{ id, purpose, contentType string }{
		{board, "board", "application/gzip"}, {image, "image", "image/png"},
	} {
		path := "editor-assets/" + asset.id + "/blob"
		if _, _, err := mem.Put(path, bytes.NewReader(png.Bytes())); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Pool().Exec(ctx, `INSERT INTO editor_assets
			(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
			VALUES ($1,$2,'u_owner','u_owner','sample',$3,$4,$5,$6,'ready',now())`,
			asset.id, other, asset.purpose, path, asset.contentType, png.Len()); err != nil {
			t.Fatal(err)
		}
	}
	quiz := drawingQuiz(t, h, map[string]any{"board": board, "image": image})
	check := func() map[string]any {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz+"/check", "u_owner", map[string]any{
			"questionId": "q1", "answers": map[string]any{"draw-a": drawingDone(t)},
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
		}
		var detail struct{ Questions []map[string]any }
		_ = json.Unmarshal(rec.Body.Bytes(), &detail)
		return gradedParts(t, detail.Questions)["draw-a"]
	}
	before := gradedSamples.Load()
	if part := check(); part["pending"] != true {
		t.Fatalf("a part with another material's sample = %+v, want Not marked", part)
	}
	if sent := gradedSamples.Load() - before; sent != 0 {
		t.Fatalf("another material's image went to the model %d times", sent)
	}
	// The same images, the quiz's own: the sample goes and the part marks.
	if _, err := st.Pool().Exec(ctx, `UPDATE editor_assets SET material_id=$1 WHERE id = ANY($2)`, quiz, []string{board, image}); err != nil {
		t.Fatal(err)
	}
	if part := check(); part["pending"] != nil || part["awarded"] != float64(2) {
		t.Fatalf("a part with its own sample = %+v", part)
	}
	if sent := gradedSamples.Load() - before; sent != 1 {
		t.Fatalf("the quiz's own sample went %d times, want once", sent)
	}
}

// TestPracticeDrawingCheckOverStorageCallsNoModel (Epo 2026-11-07, Q694): a
// practice check of a drawing past the learner's storage is refused with the
// storage message before any marking is paid for.
func TestPracticeDrawingCheckOverStorageCallsNoModel(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	ctx := context.Background()
	quiz := drawingQuiz(t, h, nil)
	usage, err := st.StorageUsage(ctx, "u_owner")
	if err != nil {
		t.Fatal(err)
	}
	var held int64
	_ = st.Pool().QueryRow(ctx, `SELECT used_bytes FROM user_storage WHERE user_id='u_owner'`).Scan(&held)
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ('u_owner',$1)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`, usage.LimitBytes); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `UPDATE user_storage SET used_bytes=$1 WHERE user_id='u_owner'`, held)
	})
	before := calls.Load()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"draw-a": drawingDone(t)},
	})
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" {
		t.Fatalf("check past storage → %d %s", rec.Code, rec.Body.String())
	}
	if made := calls.Load() - before; made != 0 {
		t.Fatalf("%d model calls before the storage refusal", made)
	}
}

// TestPracticeDrawingIsLoggedAsAIMarked: a drawing the model marked on a
// practice check logs the AI as its grader.
func TestPracticeDrawingIsLoggedAsAIMarked(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	quiz := drawingQuiz(t, h, nil)
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"draw-a": drawingDone(t)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	var grader string
	if err := st.Pool().QueryRow(context.Background(), `SELECT grader FROM answer_events
		WHERE material_id=$1 AND part_id='draw-a' ORDER BY created_at DESC LIMIT 1`, quiz).Scan(&grader); err != nil {
		t.Fatal(err)
	}
	if grader != "ai" {
		t.Fatalf("grader = %q, want ai", grader)
	}
}

// TestAnUnreadableKeptImageLeavesThePartNotMarked: Check again over a drawing
// whose kept image can't be read leaves that part Not marked rather than failing
// the check.
func TestAnUnreadableKeptImageLeavesThePartNotMarked(t *testing.T) {
	h, st, _, mem := openGradingAPIWithBlob(t, "fail-once")
	quiz := drawingQuiz(t, h, nil)
	check := func(attempt string) (int, map[string]any, string) {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz+"/check", "u_owner", map[string]any{
			"questionId": "q1", "answers": map[string]any{"draw-a": drawingDone(t)}, "attemptId": attempt,
		})
		var detail struct {
			ID        string
			Questions []map[string]any
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &detail)
		return rec.Code, gradedParts(t, detail.Questions)["draw-a"], detail.ID
	}
	code, part, attempt := check("")
	if code != http.StatusOK || part["pending"] != true {
		t.Fatalf("first check → %d %+v", code, part)
	}
	held, err := st.AttemptDrawings(context.Background(), attempt)
	if err != nil || held["draw-a"].ImageKey == "" {
		t.Fatalf("no kept image: %+v, err %v", held, err)
	}
	if err := mem.Delete(context.Background(), held["draw-a"].ImageKey); err != nil {
		t.Fatal(err)
	}
	before := gradedImages.Load()
	code, part, _ = check(attempt)
	if code != http.StatusOK || part["pending"] != true {
		t.Fatalf("check again over an unreadable image → %d %+v", code, part)
	}
	if sent := gradedImages.Load() - before; sent != 0 {
		t.Fatalf("%d grading calls without an image to send", sent)
	}
}
