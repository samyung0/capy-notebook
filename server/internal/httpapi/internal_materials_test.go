package httpapi_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

const pipeSecret = "pipe-test-secret"

func openInternalMaterialsHTTP(t *testing.T) http.Handler {
	h, _ := openInternalHTTP(t)
	return h
}

func openInternalHTTP(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()
	h, st, _ := openInternalHTTPWithBlob(t)
	return h, st
}

func openInternalHTTPWithBlob(t *testing.T) (http.Handler, *store.Store, *blob.Memory) {
	t.Helper()
	dsn := testdb.URL(t)
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	st.SetModelRegistry(reg)
	mem := blob.NewMemory()
	h := httpapi.New(st, mem, nil, nil, "docling", "capy", httpapi.Config{
		AuthDisabled:   true,
		E2EAuth:        true,
		E2ESecret:      "e2e-test-secret",
		E2EUserIDs:     []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry:  reg,
		PipelineSecret: pipeSecret,
	})
	return h, st, mem
}

func doInternal(
	t *testing.T,
	h http.Handler,
	method, path, secret string,
	body any,
) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if secret != "" {
		req.Header.Set("X-Pipeline-Secret", secret)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// seedAssistantMessage creates the conversation and streaming assistant row a
// chat tool callback must be bound to; the trusted context is verified against
// this row, never against the request body alone.
func seedAssistantMessage(t *testing.T, st *store.Store, userID, wsID string) string {
	t.Helper()
	ctx := context.Background()
	convID := fmt.Sprintf("conv_int_%d", time.Now().UnixNano())
	msgID := fmt.Sprintf("m_int_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO conversations (id, user_id, workspace_id) VALUES ($1,$2,$3)`,
		convID, userID, wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO messages (id, conversation_id, role, status) VALUES ($1,$2,'assistant','streaming')`,
		msgID, convID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, convID)
	})
	return msgID
}

func noteBody(msgID, callID, title, content string) map[string]any {
	return map[string]any{
		"workspaceId":        "ws_e2e_private",
		"userId":             "u_editor",
		"assistantMessageId": msgID,
		"toolCallId":         callID,
		"kind":               "note",
		"title":              title,
		"content":            content,
	}
}

type receiptBody struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Effect      *struct {
		Operation string `json:"operation"`
		Resource  struct {
			Kind         string `json:"kind"`
			ID           string `json:"id"`
			Title        string `json:"title"`
			MaterialKind string `json:"materialKind"`
		} `json:"resource"`
	} `json:"effect"`
}

func decodeReceipt(t *testing.T, rec *httptest.ResponseRecorder) receiptBody {
	t.Helper()
	var out receiptBody
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if out.Outcome != "succeeded" || out.Effect == nil || out.Effect.Operation != "created" || out.Effect.Resource.Kind != "material" {
		t.Fatalf("receipt = %s", rec.Body.String())
	}
	return out
}

func cleanupMaterial(t *testing.T, st *store.Store, id string) {
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, id)
	})
}

func TestInternalMaterialRunsAfterInferenceCreditsExhaust(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	var prior sql.NullInt64
	if err := st.Pool().QueryRow(ctx, `
		SELECT (SELECT used_micros FROM user_credits WHERE user_id='u_editor')
	`).Scan(&prior); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO user_credits (user_id, used_micros)
		VALUES ('u_editor', 1000000000000000)
		ON CONFLICT (user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros
	`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if prior.Valid {
			_, _ = st.Pool().Exec(context.Background(), `
				UPDATE user_credits SET used_micros=$2 WHERE user_id=$1`,
				"u_editor", prior.Int64,
			)
		} else {
			_, _ = st.Pool().Exec(context.Background(), `
				DELETE FROM user_credits WHERE user_id='u_editor'`)
		}
	})
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	response := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_1", "Exhausted inference tool", "accepted tool output"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	decodeReceipt(t, response)
}

func TestInternalMaterialReplayReturnsTheReceipt(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	title := "Internal replay " + msgID
	first := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", title, "alpha"))
	if first.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", first.Code, first.Body.String())
	}
	replay := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", title, "alpha"))
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
	a, b := decodeReceipt(t, first), decodeReceipt(t, replay)
	if a.OperationID != b.OperationID || a.OperationID != store.ChatOperationID(msgID, "call_1") {
		t.Fatalf("operation ids %s / %s", a.OperationID, b.OperationID)
	}
	if a.Effect.Resource.ID != b.Effect.Resource.ID || a.Effect.Resource.ID != store.ChatMaterialID(msgID, "call_1") {
		t.Fatalf("material ids %s / %s", a.Effect.Resource.ID, b.Effect.Resource.ID)
	}
	var count int
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM materials WHERE id=$1`, a.Effect.Resource.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("materials = %d", count)
	}
	// Replay survives the material being removed: the receipt still answers
	// without recreating the resource.
	if _, err := st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, a.Effect.Resource.ID); err != nil {
		t.Fatal(err)
	}
	late := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", title, "alpha"))
	if late.Code != http.StatusOK {
		t.Fatalf("late replay status = %d body=%s", late.Code, late.Body.String())
	}
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM materials WHERE id=$1`, a.Effect.Resource.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("replay after purge recreated the material")
	}
}

func TestInternalMaterialMismatchIsConflict(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	title := "Internal conflict " + msgID
	first := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", title, "alpha"))
	if first.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", first.Code, first.Body.String())
	}
	dup := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", title, "beta"))
	if dup.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d body=%s", dup.Code, dup.Body.String())
	}
}

func TestInternalMaterialRejectsForgedContext(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	// Another actor claiming this message, and the right actor claiming another
	// workspace, are both refused without disclosing the message.
	otherActor := noteBody(msgID, "call_1", "forged", "x")
	otherActor["userId"] = "u_owner"
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, otherActor); rec.Code != http.StatusNotFound {
		t.Fatalf("forged actor status = %d body=%s", rec.Code, rec.Body.String())
	}
	otherWS := noteBody(msgID, "call_1", "forged", "x")
	otherWS["workspaceId"] = "ws_e2e_public"
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, otherWS); rec.Code != http.StatusNotFound {
		t.Fatalf("forged workspace status = %d body=%s", rec.Code, rec.Body.String())
	}
	missing := noteBody("m_missing", "call_1", "forged", "x")
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, missing); rec.Code != http.StatusNotFound {
		t.Fatalf("missing message status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalMaterialConcurrentSameIDConverges(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	body := noteBody(msgID, "call_1", "Internal race "+msgID, "same")
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		codes []int
		ids   []string
	)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
			var out receiptBody
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			mu.Lock()
			codes = append(codes, rec.Code)
			if out.Effect != nil {
				ids = append(ids, out.Effect.Resource.ID)
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	for _, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("codes = %v", codes)
		}
	}
	if len(ids) != 2 || ids[0] != ids[1] {
		t.Fatalf("ids = %v", ids)
	}
	var count int
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM agent_operations WHERE message_id=$1`, msgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("receipts = %d", count)
	}
}

func TestInternalGeneratedQuizAndFlashcardSetPersistResolvedScope(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()

	tests := []struct {
		kind string
		body map[string]any
	}{
		{
			kind: "quiz",
			body: map[string]any{
				"questions": []map[string]any{{
					"id": "q_scope", "type": "boolean", "level": "recall",
					"prompt": "Was this scope persisted?", "correct": true,
				}},
			},
		},
		{
			kind: "flashcards",
			body: map[string]any{
				"cards": []map[string]string{{"front": "Scope", "back": "Persisted"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.kind, func(t *testing.T) {
			msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
			id := store.ChatMaterialID(msgID, "call_1")
			cleanupMaterial(t, st, id)
			body := map[string]any{
				"workspaceId": "ws_e2e_private", "userId": "u_editor",
				"assistantMessageId": msgID, "toolCallId": "call_1",
				"kind": tt.kind, "title": "Scoped " + tt.kind,
				"fileIds": []string{"f_e2e_private"}, "chapterIds": []string{"ch_e2e_private"},
			}
			for key, value := range tt.body {
				body[key] = value
			}

			response := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
			receipt := decodeReceipt(t, response)
			if receipt.Effect.Resource.ID != id || receipt.Effect.Resource.MaterialKind != tt.kind {
				t.Fatalf("effect = %+v", receipt.Effect)
			}
			material, err := st.GetMaterial(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(material.ScopeChapters, []string{"Private chapter"}) {
				t.Errorf("scope chapters = %#v", material.ScopeChapters)
			}
			if !slices.Equal(material.ScopeFileNames, []string{"secret-notes.md"}) {
				t.Errorf("scope file names = %#v", material.ScopeFileNames)
			}
		})
	}
}

func TestInternalMaterialRejectsEmptyContent(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	for _, body := range []map[string]any{
		{"kind": "quiz", "questions": []any{}},
		{"kind": "flashcards", "cards": []any{}},
		{"kind": "mindmap", "content": ""},
		{"kind": "note", "content": "   "},
	} {
		body["workspaceId"], body["userId"] = "ws_e2e_private", "u_editor"
		body["assistantMessageId"], body["toolCallId"] = msgID, "call_"+body["kind"].(string)
		body["title"] = "Empty " + body["kind"].(string)
		rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body=%s", body["kind"], rec.Code, rec.Body.String())
		}
	}
}

func TestInternalGetAgentOperationRequiresItsActorAndWorkspace(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	cleanupMaterial(t, st, store.ChatMaterialID(msgID, "call_1"))
	created := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(msgID, "call_1", "Internal get "+msgID, "getme"))
	if created.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", created.Code, created.Body.String())
	}
	opID := decodeReceipt(t, created).OperationID
	path := "/api/internal/agent-operations/" + opID

	missing := doInternal(t, h, http.MethodGet, path, pipeSecret, nil)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing actor status = %d body=%s", missing.Code, missing.Body.String())
	}
	wrongWS := doInternal(t, h, http.MethodGet, path+"?workspaceId=ws_e2e_public&userId=u_editor", pipeSecret, nil)
	if wrongWS.Code != http.StatusNotFound {
		t.Fatalf("wrong workspace status = %d body=%s", wrongWS.Code, wrongWS.Body.String())
	}
	wrongActor := doInternal(t, h, http.MethodGet, path+"?workspaceId=ws_e2e_private&userId=u_owner", pipeSecret, nil)
	if wrongActor.Code != http.StatusNotFound {
		t.Fatalf("wrong actor status = %d body=%s", wrongActor.Code, wrongActor.Body.String())
	}
	ok := doInternal(t, h, http.MethodGet, path+"?workspaceId=ws_e2e_private&userId=u_editor", pipeSecret, nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("get status = %d body=%s", ok.Code, ok.Body.String())
	}
	if decodeReceipt(t, ok).OperationID != opID {
		t.Fatalf("receipt = %s", ok.Body.String())
	}
}
