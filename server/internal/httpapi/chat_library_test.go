package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func doAsUser(t *testing.T, h http.Handler, method, path, userID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req = httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// streamCapture runs a retrieval stub that records every stream body it is
// sent and answers each with an empty turn.
func streamCapture(t *testing.T) (http.Handler, *store.Store, *[]map[string]json.RawMessage) {
	t.Helper()
	var bodies []map[string]json.RawMessage
	retrieval := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		bodies = append(bodies, in)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	t.Cleanup(retrieval.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(retrieval.URL, ""))
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM conversations WHERE workspace_id='ws_e2e_private' AND title LIKE 'teach me%'`)
	})
	return h, st, &bodies
}

func operationsOf(t *testing.T, body map[string]json.RawMessage) []string {
	t.Helper()
	var ops []string
	if err := json.Unmarshal(body["operations"], &ops); err != nil {
		t.Fatal(err)
	}
	return ops
}

// The library tools are reachable only through the turn's operations: the
// Library switch grants library.read to any role that can chat, and a viewer
// still gets no write operations with it.
func TestLibrarySwitchGrantsLibraryRead(t *testing.T) {
	h, _, bodies := streamCapture(t)
	for _, turn := range []struct {
		user string
		body map[string]any
	}{
		{"u_editor", map[string]any{"text": "teach me regression"}},
		{"u_editor", map[string]any{"library": true, "text": "teach me regression from the library"}},
		{"u_viewer", map[string]any{"library": true, "text": "teach me regression as a viewer"}},
	} {
		rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", turn.user, turn.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("stream %v: status = %d body=%s", turn.body, rec.Code, rec.Body.String())
		}
	}
	if len(*bodies) != 3 {
		t.Fatalf("relayed turns = %d, want 3", len(*bodies))
	}
	off, on, viewer := operationsOf(t, (*bodies)[0]), operationsOf(t, (*bodies)[1]), operationsOf(t, (*bodies)[2])
	if slices.Contains(off, "library.read") || string((*bodies)[0]["library"]) != "false" {
		t.Fatalf("a turn with Library off was granted the library: %v", off)
	}
	if !slices.Contains(on, "library.read") || string((*bodies)[1]["library"]) != "true" {
		t.Fatalf("a turn with Library on was not granted library.read: %v", on)
	}
	if !slices.Contains(viewer, "library.read") || slices.Contains(viewer, "material.create") {
		t.Fatalf("viewer operations with Library on = %v", viewer)
	}
}

// The open item reaches the model with its stored title, and only when it is a
// live item of this workspace; the browser never supplies the title. Study
// progress and the saved study preferences ride along.
func TestStreamSendsTheOpenResourceAndStudySwitch(t *testing.T) {
	h, st, bodies := streamCapture(t)
	if _, err := st.Pool().Exec(t.Context(),
		`INSERT INTO workspace_study (user_id, workspace_id, enabled) VALUES ('u_editor','ws_e2e_private',true)
		 ON CONFLICT (user_id, workspace_id) DO UPDATE SET enabled=true`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM workspace_study WHERE user_id='u_editor' AND workspace_id='ws_e2e_private'`)
		_, _ = st.Pool().Exec(context.Background(), `UPDATE users SET study_preferences='{}' WHERE id='u_editor'`)
	})
	// Preferences are saved through the account route, then reach every turn.
	rec := doAsUser(t, h, http.MethodPatch, "/api/me/study-preferences", "u_editor",
		map[string]any{"explainerStyle": "brief", "quizLength": 5})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("save preferences: status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doAsUser(t, h, http.MethodPatch, "/api/me/study-preferences", "u_editor",
		map[string]any{"explainerStyle": "epic"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("an unknown style was saved: status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, open := range []map[string]any{
		{"id": "qz_e2e_private", "kind": "material"},
		{"id": "f_e2e_private", "kind": "file"},
		{"id": "f_e2e_public", "kind": "file"},
		{"id": "qz_e2e_private", "kind": "file"},
	} {
		rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
			map[string]any{"text": "teach me what is open", "openResource": open})
		if rec.Code != http.StatusOK {
			t.Fatalf("stream %v: status = %d body=%s", open, rec.Code, rec.Body.String())
		}
	}
	want := []string{
		`{"id":"qz_e2e_private","kind":"material","title":"E2E Private Quiz"}`,
		`{"id":"f_e2e_private","kind":"file","title":"secret-notes.md"}`,
		"null", // another workspace's file
		"null", // a material passed as a file
	}
	for i, body := range *bodies {
		if got := string(body["openResource"]); got != want[i] {
			t.Fatalf("turn %d openResource = %s, want %s", i, got, want[i])
		}
		if string(body["studyProgress"]) != "true" {
			t.Fatalf("turn %d studyProgress = %s", i, body["studyProgress"])
		}
		if got := string(body["studyPreferences"]); got != `{"explainerStyle":"brief","quizLength":5}` {
			t.Fatalf("turn %d studyPreferences = %s", i, got)
		}
	}
}

// read_study_progress reads the requester's own progress, and only while it is
// on for them in that workspace.
func TestInternalStudyProgressNeedsProgressOn(t *testing.T) {
	h, st := openInternalHTTP(t)
	body := map[string]any{"workspaceId": "ws_e2e_private", "userId": "u_editor"}
	if _, err := st.Pool().Exec(t.Context(),
		`INSERT INTO workspace_study (user_id, workspace_id, enabled) VALUES ('u_editor','ws_e2e_private',false)
		 ON CONFLICT (user_id, workspace_id) DO UPDATE SET enabled=false`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM workspace_study WHERE user_id='u_editor' AND workspace_id='ws_e2e_private'`)
	})
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/study-progress", pipeSecret, body); rec.Code != http.StatusForbidden {
		t.Fatalf("progress off: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := st.Pool().Exec(t.Context(),
		`UPDATE workspace_study SET enabled=true WHERE user_id='u_editor' AND workspace_id='ws_e2e_private'`); err != nil {
		t.Fatal(err)
	}
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/study-progress", pipeSecret, body); rec.Code != http.StatusOK {
		t.Fatalf("progress on: status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// The ledger is the one thing that carries a build's progress between turns,
// and the only path it takes into the model is the stream body.
func TestStreamCarriesTheStoredLedger(t *testing.T) {
	h, st, bodies := streamCapture(t)

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor",
		map[string]any{"title": "Ledger thread"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var conv store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &conv); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, conv.ID)
	})

	stream := map[string]any{"conversationId": conv.ID, "text": "teach me regression"}
	if rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", stream); rec.Code != http.StatusOK {
		t.Fatalf("first turn: status = %d body=%s", rec.Code, rec.Body.String())
	}
	stored := `{"next_todo_id":1,"todos":[{"id":0,"text":"three notes on linear regression"}]}`
	if _, err := st.Pool().Exec(t.Context(),
		`UPDATE conversations SET ledger=$2 WHERE id=$1`, conv.ID, stored); err != nil {
		t.Fatal(err)
	}
	if rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", stream); rec.Code != http.StatusOK {
		t.Fatalf("second turn: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(*bodies) != 2 {
		t.Fatalf("relayed turns = %d, want 2", len(*bodies))
	}
	if string((*bodies)[0]["ledger"]) != "null" {
		t.Fatalf("a thread with no ledger relayed %s, want null", (*bodies)[0]["ledger"])
	}
	var got struct {
		Todos []struct {
			Text string `json:"text"`
		} `json:"todos"`
	}
	if err := json.Unmarshal((*bodies)[1]["ledger"], &got); err != nil || len(got.Todos) != 1 {
		t.Fatalf("second turn relayed %s", (*bodies)[1]["ledger"])
	}
}
