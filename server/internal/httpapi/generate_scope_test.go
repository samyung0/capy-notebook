package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// A Generate run reads the first GenerateScopeFiles indexed items of its
// scope in topic order, skipping unindexed ones (Epo 2026-11-21); the
// made-from line keeps every scoped item.
func TestGenerateReadsTheFirstIndexedItemsOfItsScope(t *testing.T) {
	var sent struct {
		FileIDs []string `json:"fileIds"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"questions":[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Q?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]}`))
	}))
	t.Cleanup(srv.Close)
	h := openShareAPI(t, pipeline.New(srv.URL, ""))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	stamp := time.Now().UnixNano()
	topic, prefix := fmt.Sprintf("tp_scope_%d", stamp), fmt.Sprintf("f_scope_%d_", stamp)
	exec(`INSERT INTO topics (id, workspace_id, name, position) VALUES ($1, 'ws_e2e_private', $1, 999)`, topic)
	// Position 0 is unindexed; positions 1 to 21 are indexed, one past the cap.
	exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status, topic_id, position, indexed)
		SELECT $1 || n, w.id, w.user_id, w.user_id, 'scope ' || n || '.md', 'md', 10, 'ready', $2, n, n > 0
		FROM workspaces w, generate_series(0, 21) n WHERE w.id = 'ws_e2e_private'`, prefix, topic)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM files WHERE id LIKE $1 || '%'`, prefix)
		_, _ = pool.Exec(context.Background(), `DELETE FROM topics WHERE id = $1`, topic)
	})

	body := generateBody(fmt.Sprintf("Scope cap %d", stamp))
	body["topics"] = []string{topic}
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor", body)
	var made struct {
		Quiz struct{ ID string } `json:"quiz"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil || rec.Code != http.StatusOK || made.Quiz.ID == "" {
		t.Fatalf("generate: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.Quiz.ID, "u_owner", nil) })

	want := make([]string, 0, fieldlimits.GenerateScopeFiles)
	for n := 1; n <= fieldlimits.GenerateScopeFiles; n++ {
		want = append(want, fmt.Sprintf("%s%d", prefix, n))
	}
	if !slices.Equal(sent.FileIDs, want) {
		t.Fatalf("sent %v, want %v", sent.FileIDs, want)
	}
	var named int
	if err := pool.QueryRow(ctx, `SELECT cardinality(scope_file_names) FROM materials WHERE id = $1`, made.Quiz.ID).Scan(&named); err != nil || named != 22 {
		t.Fatalf("made-from names = %d, %v; want all 22", named, err)
	}
}

// The user's instructions reach the model trimmed, and past
// GenerateInstructions characters the request is refused before any model
// call (Epo 2026-11-21).
func TestGenerateSendsTheUsersInstructions(t *testing.T) {
	var sent struct {
		Instructions string `json:"instructions"`
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"questions":[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Q?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]}`))
	}))
	t.Cleanup(srv.Close)
	h := openShareAPI(t, pipeline.New(srv.URL, ""))

	body := generateBody(fmt.Sprintf("Instructions %d", time.Now().UnixNano()))
	body["instructions"] = strings.Repeat("光", fieldlimits.GenerateInstructions+1)
	if rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor", body); rec.Code != http.StatusUnprocessableEntity || calls != 0 {
		t.Fatalf("over the limit: status = %d, model calls %d", rec.Code, calls)
	}

	body["instructions"] = "  Focus on mitosis.  "
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor", body)
	var made struct {
		Quiz struct{ ID string } `json:"quiz"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("generate: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.Quiz.ID, "u_owner", nil) })
	if sent.Instructions != "Focus on mitosis." {
		t.Fatalf("sent instructions %q", sent.Instructions)
	}
}
