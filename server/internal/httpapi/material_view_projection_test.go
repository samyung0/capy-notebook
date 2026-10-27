package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// Q453 (Epo 2026-10-27): a diagram's View read asks its open room for a fresh
// projection, as a note's does, so an edit shows at once; when the room's
// answer fails, the read serves the stored projection (2026-10-07). Fails if
// a diagram GET skips the room.
func TestADiagramViewAsksItsOpenRoomForAFreshProjection(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner"},
	})
	diagram, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_owner",
		Kind:      store.MaterialDiagram,
		Title:     "Live diagram",
		Content: `{"schemaVersion":1,"value":[{"type":"mermaid","id":"m1","source":"flowchart LR\n  A --> B",` +
			`"children":[{"type":"mermaid_caption","children":[{"text":""}]}]}]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, diagram.ID)
	// The room stored a version its projection has not caught up with.
	if _, err := st.Pool().Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, room_schema, state, stored_version, projected_version)
		VALUES ($1, 1, '\x0000'::bytea, 2, 1)`, diagram.ID); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	var failing atomic.Bool
	room := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/materials/"+diagram.ID+"/project" {
			http.NotFound(w, r)
			return
		}
		calls.Add(1)
		if failing.Load() {
			http.Error(w, `{"message":"store failed"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"projected":true,"yjsVersion":2}`))
	}))
	t.Cleanup(room.Close)
	st.ConfigureCollaboration(room.URL, "collab-test-secret")

	read := func() {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, "/api/materials/"+diagram.ID, "u_owner", nil)
		var out struct {
			Content struct {
				Value []struct {
					Source string `json:"source"`
				} `json:"value"`
			} `json:"content"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &out) != nil ||
			len(out.Content.Value) != 1 || out.Content.Value[0].Source != "flowchart LR\n  A --> B" {
			t.Fatalf("GET = %d body=%s", rec.Code, rec.Body.String())
		}
	}
	read()
	if calls.Load() != 1 {
		t.Fatalf("project calls = %d, want 1", calls.Load())
	}
	failing.Store(true)
	read()
	if calls.Load() != 2 {
		t.Fatalf("project calls = %d, want 2", calls.Load())
	}
}
