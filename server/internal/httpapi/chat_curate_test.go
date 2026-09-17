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

// Curate is fixed when the thread is created; the stream refuses a request
// that disagrees rather than switching the thread mid-life.
func TestCurateIsFixedPerConversation(t *testing.T) {
	h, st := openInternalHTTP(t)
	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor",
		map[string]any{"title": "Curate thread", "curate": true})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var conv store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &conv); err != nil {
		t.Fatal(err)
	}
	if !conv.Curate {
		t.Fatalf("created conversation is not curate: %s", rec.Body.String())
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, conv.ID)
	})

	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
		map[string]any{"conversationId": conv.ID, "text": "teach me regression"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatched flag: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.Code != "curate_mismatch" {
		t.Fatalf("body = %s", rec.Body.String())
	}

	// The refusal runs the other way too: an ordinary thread cannot be turned
	// into a curate one by the next request.
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor",
		map[string]any{"title": "Ordinary thread"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create ordinary: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var ordinary store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &ordinary); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, ordinary.ID)
	})
	if ordinary.Curate {
		t.Fatalf("an unflagged conversation is curate: %s", rec.Body.String())
	}
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
		map[string]any{"conversationId": ordinary.ID, "curate": true, "text": "teach me regression"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("curate on an ordinary thread: status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload.Code = ""
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.Code != "curate_mismatch" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// The library tools are reachable only through the turn's operations, so a
// curate turn grants library.read and an ordinary turn does not.
func TestCurateTurnGrantsLibraryRead(t *testing.T) {
	var turns [][]string
	retrieval := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Operations []string `json:"operations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		turns = append(turns, in.Operations)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	t.Cleanup(retrieval.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(retrieval.URL, ""))
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM conversations WHERE workspace_id='ws_e2e_private' AND title LIKE 'teach me%'`)
	})

	for _, body := range []map[string]any{
		{"text": "teach me regression"},
		{"curate": true, "text": "teach me regression from the library"},
	} {
		rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("stream %v: status = %d body=%s", body, rec.Code, rec.Body.String())
		}
	}
	if len(turns) != 2 {
		t.Fatalf("relayed turns = %d, want 2", len(turns))
	}
	if slices.Contains(turns[0], "library.read") {
		t.Fatalf("an ordinary turn was granted library.read: %v", turns[0])
	}
	if !slices.Contains(turns[1], "library.read") {
		t.Fatalf("a curate turn was not granted library.read: %v", turns[1])
	}
}

// The ledger is the one thing that carries a curate thread's progress between
// turns, and the only path it takes into the model is the stream body.
func TestCurateStreamCarriesTheStoredLedger(t *testing.T) {
	var relayed []json.RawMessage
	retrieval := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Ledger json.RawMessage `json:"ledger"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		relayed = append(relayed, in.Ledger)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	t.Cleanup(retrieval.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(retrieval.URL, ""))

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor",
		map[string]any{"curate": true, "title": "Ledger thread"})
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

	stream := map[string]any{"conversationId": conv.ID, "curate": true, "text": "teach me regression"}
	if rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", stream); rec.Code != http.StatusOK {
		t.Fatalf("first turn: status = %d body=%s", rec.Code, rec.Body.String())
	}

	stored := `{"requests":["three notes on linear regression"],"todos":[],"materials":[]}`
	if _, err := st.Pool().Exec(t.Context(),
		`UPDATE conversations SET ledger=$2 WHERE id=$1`, conv.ID, stored); err != nil {
		t.Fatal(err)
	}
	if rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", stream); rec.Code != http.StatusOK {
		t.Fatalf("second turn: status = %d body=%s", rec.Code, rec.Body.String())
	}

	if len(relayed) != 2 {
		t.Fatalf("relayed turns = %d, want 2", len(relayed))
	}
	if string(relayed[0]) != "null" {
		t.Fatalf("a thread with no ledger relayed %s, want null", relayed[0])
	}
	var got struct {
		Requests []string `json:"requests"`
	}
	if err := json.Unmarshal(relayed[1], &got); err != nil || len(got.Requests) != 1 {
		t.Fatalf("second turn relayed %s", relayed[1])
	}
}

// A curate turn writes materials from the library, so an actor who cannot edit
// is refused at the gateway instead of running a turn with no library tools.
func TestCurateRefusesAnActorWithoutEditAccess(t *testing.T) {
	h, _ := openInternalHTTP(t)

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_viewer",
		map[string]any{"title": "Viewer curate", "curate": true})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil ||
		len(created.Errors) != 1 || created.Errors[0].Message != "curate_requires_editor" {
		t.Fatalf("create body = %s", rec.Body.String())
	}

	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_viewer",
		map[string]any{"text": "teach me regression", "curate": true})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("stream: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var streamed struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &streamed); err != nil ||
		streamed.Code != "curate_requires_editor" {
		t.Fatalf("stream body = %s", rec.Body.String())
	}
}
