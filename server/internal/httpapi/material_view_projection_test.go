package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/getsentry/sentry-go"

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

	// A device holding its own copy reads the rest, and its room stays out of it
	// (Epo 2026-11-04): only the difference downloads, from the room's JOIN.
	rec := doReq(t, h, http.MethodGet, "/api/materials/"+diagram.ID+"?noContent=true", "u_owner", nil)
	var bare struct {
		Content struct {
			Value []any `json:"value"`
		} `json:"content"`
		Title string `json:"title"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &bare) != nil ||
		len(bare.Content.Value) != 0 || bare.Title != "Live diagram" {
		t.Fatalf("GET noContent = %d body=%s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 2 {
		t.Fatalf("project calls = %d, want 2", calls.Load())
	}
}

// Q784 A: a note in Trash opened from its owner's Trash asks its room for a
// fresh projection too. The room's in-Trash refusal (503 unavailable_target,
// the gateway refusing that projection's write) serves the stored projection
// and is reported nowhere, while any other 503 of the room's still is. Fails
// if the in-Trash refusal reaches Sentry.
func TestATrashedNotesInTrashRefusalIsNotReported(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	events := &sentryEvents{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: events}); err != nil {
		t.Fatal(err)
	}
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
	note, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_owner",
		Kind:      store.MaterialNote,
		Title:     "Trashed note",
		Content:   `{"schemaVersion":1,"value":[{"type":"p","id":"b1","children":[{"text":"Stored"}]}]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, note.ID)
	if _, err := st.Pool().Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, room_schema, state, stored_version, projected_version)
		VALUES ($1, 1, '\x0000'::bytea, 2, 1)`, note.ID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/materials/"+note.ID, "u_owner", nil),
		http.StatusNoContent, "the owner deleting")
	var answer atomic.Value
	var calls atomic.Int32
	room := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/materials/"+note.ID+"/project" {
			http.NotFound(w, r)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(answer.Load().(string)))
	}))
	t.Cleanup(room.Close)
	st.ConfigureCollaboration(room.URL, "collab-test-secret")

	for i, tc := range []struct {
		answer string
		events int
	}{
		{`{"code":"unavailable_target","message":"the material is in Trash"}`, 0},
		{`{"message":"store failed"}`, 1},
	} {
		answer.Store(tc.answer)
		events.take()
		rec := doReq(t, h, http.MethodGet, "/api/materials/"+note.ID, "u_owner", nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Stored") {
			t.Fatalf("%s: GET = %d body=%s", tc.answer, rec.Code, rec.Body.String())
		}
		if calls.Load() != int32(i+1) {
			t.Fatalf("%s: project calls = %d", tc.answer, calls.Load())
		}
		if got := events.take(); got != tc.events {
			t.Fatalf("%s: %d Sentry events, want %d", tc.answer, got, tc.events)
		}
	}
}
