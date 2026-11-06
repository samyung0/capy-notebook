package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// openGradingAPI serves the API with a stub grading model that gives every item
// the same choice ("zero", "partial" or "full") and a stub Jev for the author's
// computation check. The count covers both: every model call.
func openGradingAPI(t *testing.T, choice string) (http.Handler, *store.Store, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Questions map[string]any `json:"questions"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		answers := map[string]any{}
		for key := range body.Questions {
			answers[key] = map[string]any{"choice": choice, "noul": 0.01}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": jev.Model, "answers": answers, "usage": map[string]any{"input_tokens": 1000}})
	}))
	t.Cleanup(srv.Close)
	// The grading slot's model, behind the pipeline: each item's share.
	pipe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if choice == "fail" || (choice == "fail-once" && calls.Load() == 1) {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		var body struct {
			Question string `json:"question"`
			Items    []any  `json:"items"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		// One part never answers, until the caller gives up on it.
		if choice == "slow-second" && strings.Contains(body.Question, "Second part") {
			<-r.Context().Done()
			return
		}
		shares := make([]float64, len(body.Items))
		for i := range shares {
			shares[i] = map[string]float64{"zero": 0, "partial": 0.5, "full": 1, "fail-once": 1, "slow-second": 1}[choice]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"shares": shares, "comment": "Offered two answers for one point."})
	}))
	t.Cleanup(pipe.Close)
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(reg)
	cfg := httpapi.Config{
		E2EAuth: true, E2ESecret: "e2e-test-secret", E2EUserIDs: []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry: reg, Jev: jev.NewForTest("key", srv.URL),
	}
	client := pipeline.New(pipe.URL, "secret")
	if choice == "no-pipeline" {
		client = nil
	}
	h := httpapi.New(st, blob.NewMemory(), client, nil, "docling", cfg)
	return h, st, &calls
}

func gradingQuiz(t *testing.T, h http.Handler, privacy string) string {
	t.Helper()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": "Graded", "privacy": privacy,
		"questions": []any{map[string]any{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []any{
				map[string]any{"id": "open-a", "blocks": []any{map[string]any{"type": "text", "text": "Explain."}},
					"answer": map[string]any{"type": "open", "accepted": []any{"Because."}, "hints": []any{}}, "marks": 3,
					"markscheme": []any{map[string]any{"text": "Point one", "marks": 2}, map[string]any{"text": "Point two", "marks": 1}}, "solution": []any{}},
				map[string]any{"id": "closed-b", "blocks": []any{map[string]any{"type": "text", "text": "True?"}},
					"answer": map[string]any{"type": "boolean", "correct": true}, "marks": 1, "solution": []any{}},
				map[string]any{"id": "match-c", "blocks": []any{map[string]any{"type": "text", "text": "Match the capitals."}},
					"answer": map[string]any{"type": "matching", "options": []any{"Paris", "Rome", "Berlin"}, "pairs": []any{
						map[string]any{"left": "France", "right": 0}, map[string]any{"left": "Italy", "right": 1}, map[string]any{"left": "Germany", "right": 2},
					}}, "marks": 2, "solution": []any{map[string]any{"type": "text", "text": "Worked solution."}}},
			},
		}},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz → %d %s", rec.Code, rec.Body.String())
	}
	var quiz struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	return quiz.ID
}

// gradedParts reads a graded question list's parts by id.
func gradedParts(t *testing.T, questions []map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, q := range questions {
		for _, raw := range q["parts"].([]any) {
			p := raw.(map[string]any)
			out[p["id"].(string)] = p
		}
	}
	return out
}

// Checking a question grades every part on the server, stores what it graded
// and returns the keys: the model's per-item marks on the open part, the boolean key
// and a matching share rounded down to a half mark.
func TestQuizCheckGradesOnTheServer(t *testing.T) {
	h, _, calls := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "private")
	answers := map[string]any{"open-a": "Because of reasons.", "closed-b": true, "match-c": map[string]any{"0": "Paris", "1": "Berlin"}}
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": answers})
	if rec.Code != http.StatusOK {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	var detail struct {
		ID, MaterialID string
		Correct, Total float64
		Questions      []map[string]any
		Answers        map[string]any
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	parts := gradedParts(t, detail.Questions)
	if detail.Correct != 4.5 || detail.Total != 6 || detail.Answers["closed-b"] != true ||
		parts["open-a"]["awarded"] != 3.0 || fmt.Sprint(parts["open-a"]["itemAwards"]) != "[2 1]" ||
		parts["closed-b"]["awarded"] != 1.0 || parts["closed-b"]["answer"].(map[string]any)["correct"] != true ||
		parts["match-c"]["awarded"] != 0.5 || fmt.Sprint(parts["match-c"]["itemResults"]) != "[true false false]" ||
		parts["match-c"]["solution"] == nil {
		t.Fatalf("graded attempt = %s", rec.Body.String())
	}
	stored := doReq(t, h, http.MethodGet, "/api/attempts/"+detail.ID, "u_owner", nil)
	if stored.Code != http.StatusOK || !strings.Contains(stored.Body.String(), `"itemResults":[true,false,false]`) || !strings.Contains(stored.Body.String(), `"correct":4.5`) {
		t.Fatalf("stored attempt → %d %s", stored.Code, stored.Body.String())
	}
	// Checking it again in the same attempt is refused before grading: no
	// second model call (counted at the end).
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": answers, "attemptId": detail.ID,
	}); rec.Code != http.StatusConflict {
		t.Fatalf("repeated check → %d %s", rec.Code, rec.Body.String())
	}
	if got := gradedParts(t, detail.Questions)["open-a"]["aiComment"]; got != "Offered two answers for one point." {
		t.Fatalf("the AI's comment = %v", got)
	}
	// A blank open answer earns 0 on every item without a model call.
	rec = doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": map[string]any{"open-a": "  "}})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"awarded":0,"blocks":[{"text":"Explain."`) || !strings.Contains(rec.Body.String(), `"itemAwards":[0,0]`) {
		t.Fatalf("blank attempt → %d %s", rec.Code, rec.Body.String())
	}
	// An answer to a part the projection lacks comes back unmarked rather
	// than refused (live-items D4; TestAttemptLeavesAnswersToUnprojectedPartsUnmarked).
	for _, body := range []map[string]any{
		{"open-a": strings.Repeat("a", 5001)},
		{"open-a": 5},
	} {
		if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": body}); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("attempt %v → %d, want 422", body, rec.Code)
		}
	}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_other", map[string]any{"questionId": "q1", "answers": answers}); rec.Code != http.StatusNotFound {
		t.Fatalf("private quiz attempted by a stranger → %d", rec.Code)
	}
	// The browser no longer grades or sends scores; the old routes are gone.
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_owner", map[string]any{"answers": map[string]string{"open-a": "x"}}); rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("removed grade route → %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": map[string]any{}, "correct": 6, "total": 6}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("client score → %d", rec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("model calls = %d, want only the answered open part", calls.Load())
	}
}

// Security regression (human error-handling, 2026-10-21): questions a request
// sends that fail our validation answer 400 with the reason, not a 500.
// A part the model cannot mark stays "Not marked", and the closed parts still
// mark: a check never fails for it (Epo 2026-11-03).
func TestQuizCheckLeavesAFailedPartNotMarked(t *testing.T) {
	h, _, _ := openGradingAPI(t, "fail")
	id := gradingQuiz(t, h, "private")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"open-a": "Because of reasons.", "closed-b": true},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	var detail struct{ Questions []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	parts := gradedParts(t, detail.Questions)
	if parts["open-a"]["pending"] != true || parts["open-a"]["itemAwards"] != nil {
		t.Fatalf("open part = %+v", parts["open-a"])
	}
	if parts["closed-b"]["awarded"] != float64(1) {
		t.Fatalf("closed part = %+v", parts["closed-b"])
	}
}

// A part left Not marked can be checked again once credits are back (Epo
// 2026-11-05): only it is marked, from the answer first given, which the key has
// since been shown beside. Once marked, the question locks as any checked one.
func TestQuizCheckAgainMarksOnlyWhatWasNotMarked(t *testing.T) {
	h, _, calls := openGradingAPI(t, "fail-once")
	id := gradingQuiz(t, h, "private")
	check := func(attempt string, answers map[string]any) (int, []map[string]any, map[string]any, string) {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{
			"questionId": "q1", "answers": answers, "attemptId": attempt,
		})
		var detail struct {
			ID        string
			Questions []map[string]any
			Answers   map[string]any
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &detail)
		return rec.Code, detail.Questions, detail.Answers, detail.ID
	}
	code, questions, _, attempt := check("", map[string]any{"open-a": "Because of reasons.", "closed-b": true})
	if code != http.StatusOK || gradedParts(t, questions)["open-a"]["pending"] != true {
		t.Fatalf("first check → %d %+v", code, questions)
	}
	code, questions, answers, _ := check(attempt, map[string]any{"open-a": "A better answer, now I have seen the key."})
	if code != http.StatusOK {
		t.Fatalf("check again → %d", code)
	}
	parts := gradedParts(t, questions)
	if parts["open-a"]["pending"] != nil || parts["open-a"]["awarded"] != float64(3) || parts["closed-b"]["awarded"] != float64(1) {
		t.Fatalf("after checking again = %+v", parts)
	}
	if answers["open-a"] != "Because of reasons." {
		t.Fatalf("the answer changed to %v", answers["open-a"])
	}
	if calls.Load() != 2 {
		t.Fatalf("model calls = %d, want the failed one and one more", calls.Load())
	}
	if code, _, _, _ := check(attempt, map[string]any{"open-a": "Again."}); code != http.StatusConflict {
		t.Fatalf("a third check → %d, want 409", code)
	}
}

func TestCreateQuizRefusesInvalidQuestionsWith400(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	question := map[string]any{
		"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": []any{map[string]any{"id": "a", "blocks": []any{map[string]any{"type": "text", "text": "True?"}},
			"answer": map[string]any{"type": "boolean", "correct": true}, "marks": 1, "solution": []any{}}},
	}
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": "Twice", "privacy": "private", "questions": []any{question, question},
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "duplicate question id") {
		t.Fatalf("create quiz with a repeated question id → %d %s, want 400", rec.Code, rec.Body.String())
	}
}

// An ordering part always has an answer, the order the learner was shown, so
// grading refuses one sent without it rather than marking it wrong.
func TestAttemptNeedsAnOrder(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": "Order", "privacy": "private",
		"questions": []any{map[string]any{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []any{map[string]any{"id": "order-a", "blocks": []any{map[string]any{"type": "text", "text": "Order them."}},
				"answer": map[string]any{"type": "ordering", "items": []any{"One", "Two", "Three"}}, "marks": 1, "solution": []any{}}},
		}},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz → %d %s", rec.Code, rec.Body.String())
	}
	var quiz struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz.ID+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": map[string]any{}}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("attempt without an order → %d, want 422", rec.Code)
	}
	rec = doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz.ID+"/check", "u_owner", map[string]any{"questionId": "q1", "answers": map[string]any{"order-a": []any{"One", "Two", "Three"}}})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"correct":1`) {
		t.Fatalf("attempt with the shown order → %d %s", rec.Code, rec.Body.String())
	}
}

// The model's partial credit is half of each item's own marks.
func TestQuizCheckScalesPartialCreditByItemMarks(t *testing.T) {
	h, _, _ := openGradingAPI(t, "partial")
	id := gradingQuiz(t, h, "private")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"open-a": "Because of reasons."},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"awarded":1.5`) || !strings.Contains(rec.Body.String(), `"itemAwards":[1,0.5]`) {
		t.Fatalf("attempt → %d %s", rec.Code, rec.Body.String())
	}
}

// sharedCheck posts a shared page's check as a browser does: a signed-out one
// with no auth headers at all, and no Turnstile token either way.
func sharedCheck(t *testing.T, h http.Handler, path, user string, answers map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"questionId": "q1", "answers": answers}
	if user != "" {
		return doReq(t, h, http.MethodPost, path, user, body)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestSharedPageCheckLeavesOpenAnswersNotMarked (security regression: Epo
// 2026-11-05, Q640 B). A shared page's check of an open part makes no model call
// and takes no Turnstile token: visitors can't spend anyone's model budget.
// Closed parts still mark, the open part comes back Not marked with its marking
// points, and a signed-in visitor gets the same, with no attempt, no daily parts
// and no charge.
func TestSharedPageCheckLeavesOpenAnswersNotMarked(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	ctx := context.Background()
	id := gradingQuiz(t, h, "link")
	path := "/api/public/quizzes/" + store.ShareToken(nil, id) + "/grade"
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM grading_usage WHERE user_id='u_other'`)
	})
	answers := map[string]any{"open-a": "Because.", "closed-b": true}
	for _, user := range []string{"", "u_other"} {
		before := calls.Load()
		rec := sharedCheck(t, h, path, user, answers)
		var graded struct {
			Correct, Total float64
			Question       map[string]any
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &graded)
		if rec.Code != http.StatusOK || graded.Correct != 1 || graded.Total != 6 {
			t.Fatalf("visitor %q → %d %s", user, rec.Code, rec.Body.String())
		}
		if calls.Load() != before {
			t.Fatalf("visitor %q: %d model calls, want none", user, calls.Load()-before)
		}
		parts := gradedParts(t, []map[string]any{graded.Question})
		open := parts["open-a"]
		if open["pending"] != true || open["awarded"] != float64(0) || open["itemAwards"] != nil {
			t.Fatalf("visitor %q: open part = %v, want Not marked", user, open)
		}
		if scheme, _ := open["markscheme"].([]any); len(scheme) != 2 {
			t.Fatalf("visitor %q: open part's marking points = %v", user, open["markscheme"])
		}
		closed := parts["closed-b"]
		if closed["awarded"] != float64(1) || closed["answer"].(map[string]any)["correct"] != true {
			t.Fatalf("visitor %q: closed part = %v", user, closed)
		}
		// The check reveals the rest of the question's key, and solutions, as before.
		if solution, _ := parts["match-c"]["solution"].([]any); len(solution) != 1 {
			t.Fatalf("visitor %q: worked solution = %v", user, parts["match-c"]["solution"])
		}
	}
	var attempts, reserved int
	if err := st.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM attempts WHERE material_id=$1),
		(SELECT count(*) FROM grading_usage WHERE user_id='u_other')`, id).Scan(&attempts, &reserved); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || reserved != 0 {
		t.Fatalf("attempts %d, daily parts rows %d; a shared page's check stores nothing", attempts, reserved)
	}
}

// A blank open answer reads as not answered, not as Not marked, and an answer
// naming a part the question lacks is refused.
func TestSharedPageCheckTakesBlankAndRefusesUnknownParts(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	path := "/api/public/quizzes/" + store.ShareToken(nil, gradingQuiz(t, h, "link")) + "/grade"
	rec := sharedCheck(t, h, path, "", map[string]any{"open-a": "  "})
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"pending"`) {
		t.Fatalf("blank open answer → %d %s", rec.Code, rec.Body.String())
	}
	if rec := sharedCheck(t, h, path, "", map[string]any{"nope": 1}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown part → %d", rec.Code)
	}
}

// A shared note sends its embedded quizzes answer-free, and its link grades
// only a quiz the note embeds and references, storing nothing.
func TestAnonymousNoteEmbedsAndGrading(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	ctx := context.Background()
	standalone := gradingQuiz(t, h, "link")
	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", Kind: "note", Title: "Embeds", Content: noteTestContent(t, "# Embeds\n\nbody")})
	if err != nil {
		t.Fatal(err)
	}
	questions := json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1-a","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`)
	embed := func() store.Material {
		mt, err := st.CreateEmbeddedMaterial(ctx, "u_owner", note.ID, store.EmbeddedDraft{Kind: "quiz", Questions: questions})
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	quiz, unreferenced := embed(), embed()
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("intro"), materialdoc.MaterialRefNode(quiz.ID, "quiz"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateMaterial(ctx, note.ID, store.MaterialPatch{Content: &content, UpdatedBy: "u_owner"}); err != nil {
		t.Fatal(err)
	}
	token := store.ShareToken(nil, note.ID)
	grade := func(quizID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/public/notes/"+token+"/quizzes/"+quizID+"/grade",
			strings.NewReader(`{"questionId":"q1","answers":{"q1-a":true}}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := doReq(t, h, http.MethodGet, "/api/public/notes/"+token, "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("private note → %d", rec.Code)
	}
	if rec := grade(quiz.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("private note's quiz grade → %d", rec.Code)
	}
	if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", note.ID, "", store.PrivacyLink); err != nil {
		t.Fatal(err)
	}

	rec := doReq(t, h, http.MethodGet, "/api/public/notes/"+token, "", nil)
	var read struct {
		Embeds []struct {
			ID, Kind  string
			Questions []map[string]any
		}
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &read)
	if rec.Code != http.StatusOK || len(read.Embeds) != 1 || read.Embeds[0].ID != quiz.ID || read.Embeds[0].Kind != "quiz" ||
		len(read.Embeds[0].Questions) != 1 || strings.Contains(rec.Body.String(), `"correct"`) {
		t.Fatalf("note read → %d %s", rec.Code, rec.Body.String())
	}

	if rec := grade(quiz.ID); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"correct":1`) {
		t.Fatalf("embedded quiz grade → %d %s", rec.Code, rec.Body.String())
	}
	for _, id := range []string{unreferenced.ID, standalone} {
		if rec := grade(id); rec.Code != http.StatusNotFound {
			t.Fatalf("grade %s through the note → %d", id, rec.Code)
		}
	}
	var attempts int
	if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM attempts WHERE material_id=$1`, quiz.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("grading through the note stored %d attempts", attempts)
	}
}

// TestSharedNoteQuizCheckLeavesOpenAnswersNotMarked (security regression: Epo
// 2026-11-05, Q640 B). A quiz embedded in a shared note checks like a shared
// quiz: no model call and no token for any visitor, its open part Not marked with
// its marking points, and nothing stored.
func TestSharedNoteQuizCheckLeavesOpenAnswersNotMarked(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	ctx := context.Background()
	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", Kind: "note", Title: "Open embed", Content: noteTestContent(t, "# Embeds\n\nbody")})
	if err != nil {
		t.Fatal(err)
	}
	questions, err := json.Marshal([]any{map[string]any{
		"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": []any{map[string]any{"id": "open-a", "blocks": []any{map[string]any{"type": "text", "text": "Explain."}},
			"answer": map[string]any{"type": "open", "accepted": []any{"Because."}, "hints": []any{}}, "marks": 1,
			"markscheme": []any{map[string]any{"text": "Point one", "marks": 1}}, "solution": []any{}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := st.CreateEmbeddedMaterial(ctx, "u_owner", note.ID, store.EmbeddedDraft{Kind: "quiz", Questions: questions})
	if err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("intro"), materialdoc.MaterialRefNode(quiz.ID, "quiz"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateMaterial(ctx, note.ID, store.MaterialPatch{Content: &content, UpdatedBy: "u_owner"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", note.ID, "", store.PrivacyLink); err != nil {
		t.Fatal(err)
	}
	path := "/api/public/notes/" + store.ShareToken(nil, note.ID) + "/quizzes/" + quiz.ID + "/grade"
	for _, user := range []string{"", "u_other"} {
		before := calls.Load()
		rec := sharedCheck(t, h, path, user, map[string]any{"open-a": "Because."})
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"pending":true`) || !strings.Contains(rec.Body.String(), "Point one") {
			t.Fatalf("visitor %q → %d %s", user, rec.Code, rec.Body.String())
		}
		if calls.Load() != before {
			t.Fatalf("visitor %q: %d model calls, want none", user, calls.Load()-before)
		}
	}
	var attempts int
	if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM attempts WHERE material_id=$1`, quiz.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("the embed stored %d attempts", attempts)
	}
}
