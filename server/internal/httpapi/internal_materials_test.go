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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
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
	h, st, mem, _ := openInternalHTTPWithPipeline(t, nil)
	return h, st, mem
}

func openInternalHTTPWithPipeline(
	t *testing.T,
	pipe *pipeline.Client,
) (http.Handler, *store.Store, *blob.Memory, *models.Registry) {
	t.Helper()
	return openInternalHTTPWith(t, pipe, nil)
}

// openInternalHTTPWith is openInternalHTTPWithPipeline with a hook for the
// config, for a test that needs a dependency the others do not (the bank).
func openInternalHTTPWith(
	t *testing.T,
	pipe *pipeline.Client,
	configure func(*store.Store, *httpapi.Config),
) (http.Handler, *store.Store, *blob.Memory, *models.Registry) {
	t.Helper()
	return openInternalHTTPWithRedis(t, pipe, nil, configure)
}

// openInternalHTTPWithRedis is openInternalHTTPWith with a Redis client, for
// a test of the rate limiter.
func openInternalHTTPWithRedis(
	t *testing.T,
	pipe *pipeline.Client,
	rdb *redis.Client,
	configure func(*store.Store, *httpapi.Config),
) (http.Handler, *store.Store, *blob.Memory, *models.Registry) {
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
	converter := httptest.NewServer(withConverter(http.NotFoundHandler()))
	t.Cleanup(converter.Close)
	st.ConfigureMarkdownConverter(converter.URL, "collab-test-secret")
	mem := blob.NewMemory()
	config := httpapi.Config{
		AuthDisabled:   true,
		E2EAuth:        true,
		E2ESecret:      "e2e-test-secret",
		E2EUserIDs:     []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry:  reg,
		PipelineSecret: pipeSecret,
	}
	if configure != nil {
		configure(st, &config)
	}
	h := httpapi.New(st, mem, pipe, rdb, "docling", config)
	return h, st, mem, reg
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
		Undo *struct {
			OperationID string `json:"operationId"`
		} `json:"undo"`
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
		INSERT INTO user_credits (user_id, used_micros, purchased_micros)
		VALUES ('u_editor', 1000000000000000, 0)
		ON CONFLICT (user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros, purchased_micros=0
	`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if prior.Valid {
			_, _ = st.Pool().Exec(context.Background(), `
				UPDATE user_credits SET used_micros=$2, purchased_micros=$3 WHERE user_id=$1`,
				"u_editor", prior.Int64, store.StarterGrantMicros,
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

// An agent's sources are its made-from line (Epo 2026-10-21): the id or exact
// name of a workspace item of any kind, or of a chapter, is stored as its
// current name and any other string as written; a blank one is dropped.
// Nothing in the private workspace's quiz, flashcard set or note is indexed,
// and none is refused.
func TestInternalMaterialStoresItsSourcesAsNames(t *testing.T) {
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
					"id": "q_scope", "stem": []any{}, "layout": "paper", "labels": "letters",
					"parts": []any{map[string]any{"id": "q_scope:part:1", "blocks": []any{map[string]any{"type": "text", "text": "Was this scope persisted?"}}, "answer": map[string]any{"type": "boolean", "correct": true}, "marks": 1, "solution": []any{}}},
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
				"kind": tt.kind, "title": "Sourced " + tt.kind,
				"sources": []string{
					"note_e2e_private", "E2E Private Quiz", "dk_e2e_private", "ch_e2e_private",
					" Lecture 3, 14 Oct ", "https://example.org/cells", "Secret private title", "  ", "",
				},
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
			want := []string{
				"Secret private title", "E2E Private Quiz", "E2E Private Flashcards", "Private chapter",
				"Lecture 3, 14 Oct", "https://example.org/cells",
			}
			if !slices.Equal(material.ScopeFileNames, want) || len(material.ScopeChapters) != 0 {
				t.Errorf("sources = %#v, chapters = %#v", material.ScopeFileNames, material.ScopeChapters)
			}
		})
	}
}

// A material the agent names no sources for records none: the chat's scope
// is not filled in for it.
func TestInternalMaterialWithoutSourcesStoresNone(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	id := store.ChatMaterialID(msgID, "call_1")
	cleanupMaterial(t, st, id)
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_1", "Unsourced "+msgID, "body"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	material, err := st.GetMaterial(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(material.ScopeFileNames) != 0 || len(material.ScopeChapters) != 0 {
		t.Fatalf("sources = %#v, chapters = %#v", material.ScopeFileNames, material.ScopeChapters)
	}
}

// The only refusal sources can get is their format: at most 20 distinct ones
// of at most 200 characters each.
func TestInternalMaterialRefusesSourcesOverTheirBounds(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	tooMany := make([]string, 21)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("Lecture %d", i)
	}
	for name, sources := range map[string][]string{
		"too many": tooMany,
		"too long": {strings.Repeat("é", 201)},
	} {
		body := noteBody(msgID, "call_bounds", "Bounded "+name, "body")
		body["sources"] = sources
		rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
		if rec.Code != http.StatusBadRequest ||
			!strings.Contains(rec.Body.String(), "sources: send at most 20 sources of at most 200 characters each.") {
			t.Fatalf("%s: status = %d body=%s", name, rec.Code, rec.Body.String())
		}
	}
	var count int
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM materials WHERE id=$1`,
		store.ChatMaterialID(msgID, "call_bounds")).Scan(&count); err != nil || count != 0 {
		t.Fatalf("materials = %d, %v", count, err)
	}

	// A repeat counts once: 25 strings naming 15 sources are within the bound.
	repeated := make([]string, 25)
	for i := range repeated {
		repeated[i] = fmt.Sprintf("Lecture %d", i%15)
	}
	id := store.ChatMaterialID(msgID, "call_repeats")
	cleanupMaterial(t, st, id)
	body := noteBody(msgID, "call_repeats", "Repeated sources "+msgID, "body")
	body["sources"] = repeated
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("repeats: status = %d body=%s", rec.Code, rec.Body.String())
	}
	material, err := st.GetMaterial(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(material.ScopeFileNames) != 15 {
		t.Fatalf("sources = %#v", material.ScopeFileNames)
	}
}

// Only an untrashed item of the material's own workspace resolves to its name
// (security regression: any-item-sources review F1): an id from another
// workspace or of a trashed item is stored as written, so a made-from line
// never shows a name its readers could not see.
func TestInternalMaterialKeepsForeignAndTrashedIDsAsWritten(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id='trash_sources',
		purge_after=now() + interval '1 day' WHERE id='qz_e2e_private'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `UPDATE materials SET trashed_at=NULL,
			trash_episode_id=NULL, purge_after=NULL WHERE id='qz_e2e_private'`)
	})
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	id := store.ChatMaterialID(msgID, "call_1")
	cleanupMaterial(t, st, id)
	body := noteBody(msgID, "call_1", "Foreign sources "+msgID, "body")
	body["sources"] = []string{"f_e2e_public", "note_e2e_public", "ch_e2e_public", "qz_e2e_private", "note_e2e_private"}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	material, err := st.GetMaterial(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"f_e2e_public", "note_e2e_public", "ch_e2e_public", "qz_e2e_private", "Secret private title"}
	if !slices.Equal(material.ScopeFileNames, want) {
		t.Fatalf("sources = %#v, want %#v", material.ScopeFileNames, want)
	}
}

func TestInternalMaterialRejectsEmptyContent(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	for _, body := range []map[string]any{
		{"kind": "quiz", "questions": []any{}},
		{"kind": "flashcards", "cards": []any{}},
		{"kind": "mindmap", "content": ""},
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

// A note sent with blank content is the blank note a user's new note starts
// as, and the receipt tells the model it is blank (Epo 2026-10-29).
func TestInternalMaterialCreatesABlankNoteFromBlankContent(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_blank", "Blank "+msgID, " \n\n "))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	receipt := decodeReceipt(t, rec)
	cleanupMaterial(t, st, receipt.Effect.Resource.ID)
	var out struct {
		Notice string `json:"notice"`
		Effect struct {
			BlockIDs []string `json:"blockIds"`
		} `json:"effect"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	note, err := st.GetMaterial(t.Context(), receipt.Effect.Resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := materialdoc.Parse(note.Content)
	if err != nil {
		t.Fatal(err)
	}
	blank := materialdoc.Empty().Value[0]
	if len(doc.Value) != 1 || doc.Value[0]["type"] != blank["type"] || fmt.Sprint(doc.Value[0]["children"]) != fmt.Sprint(blank["children"]) {
		t.Fatalf("note = %s, want the blank note", note.Content)
	}
	if !strings.Contains(out.Notice, "created blank") || !slices.Equal(out.Effect.BlockIDs, []string{doc.Value[0]["id"].(string)}) {
		t.Fatalf("receipt = %s", rec.Body.String())
	}
}

// A generated set's card over a cap is refused, naming the card and the cap,
// before any document is built (security regression: a stored set Go cannot
// project breaks the material for everyone).
func TestInternalMaterialRefusesAnOverLongCard(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	body := map[string]any{
		"kind": "flashcards", "title": "Long cards", "workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_long_card",
		"cards": []map[string]string{
			{"front": "Short", "back": "Fine"},
			{"front": strings.Repeat("é", materialdoc.MaxCardFrontRunes+1), "back": "b"},
		},
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "cards[1]: a flashcard front holds at most 200 characters") {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// A curated material stores its attribution and takes the ShareAlike licence
// of its sources; a mix of CC BY and CC BY-SA is CC BY-SA.
func TestInternalMaterialStoresProvenanceAndShareAlikeLicense(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	body := noteBody(msgID, "call_prov", "Curated regression note", "# Regression\n\nA fitted line.")
	body["provenance"] = map[string]any{
		"books": []map[string]any{
			{
				"id": "openintro", "title": "OpenIntro Statistics", "authors": []string{"Diez"},
				"license": "CC BY", "excerptIds": []string{"e_1"}, "version": 1,
			},
			{
				"id": "ahss", "title": "Advanced High School Statistics", "authors": []string{},
				"license": "CC BY-SA 4.0", "excerptIds": []string{"e_2", "e_3"}, "version": 2,
			},
		},
		// A model-supplied licence must not survive: the server computes it.
		"license": "WTFPL",
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	receipt := decodeReceipt(t, rec)
	cleanupMaterial(t, st, receipt.Effect.Resource.ID)

	stored, err := st.GetMaterial(context.Background(), receipt.Effect.Resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Provenance == nil || len(stored.Provenance.Books) != 2 {
		t.Fatalf("provenance = %+v", stored.Provenance)
	}
	if stored.Provenance.License != "CC BY-SA 4.0" {
		t.Fatalf("license = %q, want the ShareAlike licence", stored.Provenance.License)
	}
	if got := stored.Provenance.Books[1].ExcerptIDs; len(got) != 2 {
		t.Fatalf("excerpt ids = %v", got)
	}
	if got := stored.Provenance.Books[1].Version; got != 2 {
		t.Fatalf("book version = %d, want the version the excerpts were read from", got)
	}

	body["toolCallId"] = "call_prov_invalid"
	body["title"] = "Unattributed"
	body["provenance"] = map[string]any{
		"books": []map[string]any{
			{"id": "ahss", "title": "AHSS", "excerptIds": []string{}, "version": 1},
		},
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a book without excerpt ids: status = %d body=%s", rec.Code, rec.Body.String())
	}

	body["toolCallId"] = "call_prov_unversioned"
	body["title"] = "Unversioned"
	body["provenance"] = map[string]any{
		"books": []map[string]any{
			{"id": "ahss", "title": "AHSS", "excerptIds": []string{"e_1"}},
		},
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a book without a version: status = %d body=%s", rec.Code, rec.Body.String())
	}

	body["toolCallId"] = "call_prov_web"
	body["title"] = "Web credit"
	body["provenance"] = map[string]any{
		"books": []map[string]any{},
		"web": []map[string]any{
			{"url": "https://open.example/essay", "title": "An essay", "authors": []string{}, "license": "CC BY 4.0", "retrievedAt": "2026-10-02"},
		},
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("web provenance from a model call: status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// A chat write whose actor may no longer edit the turn's workspace (a viewer
// now, or no longer a member) is refused as permission_denied, which tells the
// agent to stop editing (Epo 2026-10-21).
func TestInternalMaterialRefusesAnActorWhoLostEditing(t *testing.T) {
	h, st := openInternalHTTP(t)
	for _, user := range []string{"u_viewer", "u_other"} {
		msgID := seedAssistantMessage(t, st, user, "ws_e2e_private")
		body := noteBody(msgID, "call_lost_"+user, "Lost", "# Lost")
		body["userId"] = user
		rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "permission_denied" {
			t.Fatalf("%s: %d %s", user, rec.Code, rec.Body.String())
		}
	}
}

// Two copyleft families have no single answer, so the material is refused
// instead of being credited under whichever book came first. Two versions of
// one family land on the newer one.
func TestInternalMaterialRefusesTwoCopyleftFamilies(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	body := noteBody(msgID, "call_prov_mixed", "Mixed licences", "# Regression\n\nA fitted line.")
	body["provenance"] = map[string]any{
		"books": []map[string]any{
			{
				"id": "ahss", "title": "Advanced High School Statistics",
				"license": "CC BY-SA 4.0", "excerptIds": []string{"e_1"}, "version": 1,
			},
			{
				"id": "wiki", "title": "Wikibooks Statistics",
				"license": "GFDL 1.3", "excerptIds": []string{"e_2"}, "version": 1,
			},
		},
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != "lifecycle_rejected" ||
		!strings.Contains(payload.Message, "CC BY-SA") ||
		!strings.Contains(payload.Message, "GFDL") {
		t.Fatalf("body = %s", rec.Body.String())
	}

	// One family at two versions licenses the material under the newer one.
	body["toolCallId"] = "call_prov_same"
	body["title"] = "One family"
	body["provenance"] = map[string]any{
		"books": []map[string]any{
			{
				"id": "osp", "title": "OpenStax Prealgebra",
				"license": "CC BY-SA 3.0", "excerptIds": []string{"e_2"}, "version": 3,
			},
			{
				"id": "ahss", "title": "Advanced High School Statistics",
				"license": "CC BY-SA 4.0", "excerptIds": []string{"e_1"}, "version": 1,
			},
		},
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("one family status = %d body=%s", rec.Code, rec.Body.String())
	}
	receipt := decodeReceipt(t, rec)
	cleanupMaterial(t, st, receipt.Effect.Resource.ID)
	stored, err := st.GetMaterial(context.Background(), receipt.Effect.Resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Provenance.License != "CC BY-SA 4.0" {
		t.Fatalf("license = %q", stored.Provenance.License)
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

// An agent note's quiz and flashcards fences become rows under the note, made
// in the note's transaction with the references already pointing at them.
func TestInternalCreateNoteCreatesItsMiniChecks(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	question := `{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Is a tangent perpendicular to the radius?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`
	title := "Tangents " + msgID
	markdown := "# Tangents\n\n```quiz\n{\"questions\":[" + question + "]}\n```\n\nRecap.\n\n" +
		"```quiz\n{\"questions\":[" + question + "]}\n```\n\n" +
		"```flashcards\n{\"cards\":[{\"front\":\"Tangent\",\"back\":\"One point\"}]}\n```"
	body := noteBody(msgID, "call_checks", title, markdown)
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := store.ChatMaterialID(msgID, "call_checks")
	type child struct{ ID, Kind, Title string }
	children := func() []child {
		rows, err := st.Pool().Query(t.Context(),
			`SELECT id, kind, title FROM materials WHERE parent_material_id=$1 ORDER BY title`, noteID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []child
		for rows.Next() {
			var c child
			if err := rows.Scan(&c.ID, &c.Kind, &c.Title); err != nil {
				t.Fatal(err)
			}
			out = append(out, c)
		}
		return out
	}
	got := children()
	if len(got) != 3 {
		t.Fatalf("embedded rows = %+v", got)
	}
	// Each row is named by a random UUID that is never displayed.
	titles := map[string]bool{}
	for _, c := range got {
		if _, err := uuid.Parse(c.Title); err != nil {
			t.Fatalf("embedded title %q is not a UUID", c.Title)
		}
		titles[c.Title] = true
	}
	if len(titles) != 3 {
		t.Fatalf("embedded titles = %+v", got)
	}
	note, err := st.GetMaterial(t.Context(), noteID)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := materialdoc.ExtractMaterialRefs(note.Content)
	if err != nil || len(refs) != 3 {
		t.Fatalf("note refs = %+v err = %v", refs, err)
	}
	for _, ref := range refs {
		found := false
		for _, c := range got {
			found = found || c.ID == ref.MaterialID
		}
		if !found {
			t.Fatalf("reference %+v points at no embedded row", ref)
		}
	}

	if replay := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body); replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
	if again := children(); len(again) != 3 {
		t.Fatalf("a replay created rows again: %+v", again)
	}

	broken := noteBody(msgID, "call_broken", "Broken "+msgID, "```quiz\nquestions: [\n```")
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, broken)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_input") {
		t.Fatalf("broken fence: status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// create_material files the material in the chapter it names, and only in a
// chapter of the same workspace.
func TestInternalCreateMaterialFilesItInTheChapter(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	body := noteBody(msgID, "call_chapter", "Filed "+msgID, "Filed note.")
	body["chapterId"] = "ch_e2e_private"
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body); rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	mt, err := st.GetMaterial(t.Context(), store.ChatMaterialID(msgID, "call_chapter"))
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, mt.ID)
	if mt.ChapterID == nil || *mt.ChapterID != "ch_e2e_private" {
		t.Fatalf("chapter = %v", mt.ChapterID)
	}
	foreign := noteBody(msgID, "call_foreign_chapter", "Foreign "+msgID, "Foreign.")
	foreign["chapterId"] = "ch_e2e_public"
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, foreign); rec.Code != http.StatusBadRequest {
		t.Fatalf("foreign chapter: status = %d body=%s", rec.Code, rec.Body.String())
	}
}
