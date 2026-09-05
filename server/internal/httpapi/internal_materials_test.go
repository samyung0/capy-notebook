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

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
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
	h := httpapi.New(st, mem, nil, nil, "docling", "evo", httpapi.Config{
		AuthDisabled:   true,
		E2EAuth:        true,
		E2ESecret:      "e2e-test-secret",
		E2EUserIDs:     []string{"u_owner", "u_editor", "u_commenter", "u_viewer", "u_other"},
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

func noteBody(id, title, content string) map[string]any {
	return map[string]any{
		"id":          id,
		"workspaceId": "ws_e2e_private",
		"userId":      "u_editor",
		"kind":        "note",
		"title":       title,
		"content":     content,
	}
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
	id := fmt.Sprintf("mat_exhausted_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, id)
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
	response := doInternal(
		t,
		h,
		http.MethodPost,
		"/api/internal/materials",
		pipeSecret,
		noteBody(id, "Exhausted inference tool", "accepted tool output"),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestInternalMaterialLookupBeforeCreateReplaysSameID(t *testing.T) {
	h := openInternalMaterialsHTTP(t)
	id := fmt.Sprintf("mat_int_%d", time.Now().UnixNano())
	title := "Internal replay " + id
	first := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(id, title, "alpha"))
	if first.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", first.Code, first.Body.String())
	}
	replay := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(id, title, "alpha"))
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
	var a, b map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(replay.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if a["materialId"] != b["materialId"] || a["materialId"] != id {
		t.Fatalf("replay id = %v / %v, want %s", a["materialId"], b["materialId"], id)
	}
}

func TestInternalMaterialMismatchIsConflict(t *testing.T) {
	h := openInternalMaterialsHTTP(t)
	id := fmt.Sprintf("mat_int_%d", time.Now().UnixNano())
	title := "Internal conflict " + id
	first := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(id, title, "alpha"))
	if first.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", first.Code, first.Body.String())
	}
	dup := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(id, title, "beta"))
	if dup.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d body=%s", dup.Code, dup.Body.String())
	}
}

func TestInternalMaterialConcurrentSameIDConverges(t *testing.T) {
	h := openInternalMaterialsHTTP(t)
	id := fmt.Sprintf("mat_int_%d", time.Now().UnixNano())
	title := "Internal race " + id
	body := noteBody(id, title, "same")
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
			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			mu.Lock()
			codes = append(codes, rec.Code)
			if id, ok := out["materialId"].(string); ok {
				ids = append(ids, id)
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
	if len(ids) != 2 || ids[0] != id || ids[1] != id {
		t.Fatalf("ids = %v want both %s", ids, id)
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
			id := fmt.Sprintf("mat_scope_%s_%d", tt.kind, time.Now().UnixNano())
			t.Cleanup(func() {
				_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, id)
			})
			body := map[string]any{
				"id": id, "workspaceId": "ws_e2e_private", "userId": "u_editor",
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

func TestInternalGetMaterialRequiresWorkspaceActor(t *testing.T) {
	h := openInternalMaterialsHTTP(t)
	id := fmt.Sprintf("mat_int_%d", time.Now().UnixNano())
	title := "Internal get " + id
	created := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, noteBody(id, title, "getme"))
	if created.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", created.Code, created.Body.String())
	}

	missing := doInternal(t, h, http.MethodGet, "/api/internal/materials/"+id, pipeSecret, nil)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing actor status = %d body=%s", missing.Code, missing.Body.String())
	}

	wrongWS := doInternal(t, h, http.MethodGet,
		"/api/internal/materials/"+id+"?workspaceId=ws_e2e_public&userId=u_owner",
		pipeSecret, nil)
	if wrongWS.Code != http.StatusNotFound {
		t.Fatalf("wrong workspace status = %d body=%s", wrongWS.Code, wrongWS.Body.String())
	}

	ok := doInternal(t, h, http.MethodGet,
		"/api/internal/materials/"+id+"?workspaceId=ws_e2e_private&userId=u_editor",
		pipeSecret, nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("get status = %d body=%s", ok.Code, ok.Body.String())
	}
}
