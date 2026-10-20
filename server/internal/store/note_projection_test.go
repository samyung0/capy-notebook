package store

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A View read asks the room for a projection only while stored versions are
// ahead of it, and reports whether the service projected.
func TestProjectLiveNoteCallsOnlyWhenTheProjectionLags(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_live_projection")
	material, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "note", Title: "Live", Content: materialTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/materials/"+material.ID+"/project" || r.Header.Get("X-Collaboration-Secret") != "live-secret" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"projected":true,"yjsVersion":2}`))
	}))
	t.Cleanup(sidecar.Close)
	s.ConfigureCollaboration(sidecar.URL, "live-secret")

	// No Yjs row: nothing to project.
	if projected, err := s.ProjectLiveNote(ctx, material.ID); err != nil || projected {
		t.Fatalf("no room: projected=%v err=%v", projected, err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, room_schema, state, stored_version, projected_version)
		VALUES ($1, 1, '\x0000'::bytea, 1, 1)`, material.ID); err != nil {
		t.Fatal(err)
	}
	// Current projection: no call.
	if projected, err := s.ProjectLiveNote(ctx, material.ID); err != nil || projected {
		t.Fatalf("current: projected=%v err=%v", projected, err)
	}
	if calls.Load() != 0 {
		t.Fatalf("calls = %d, want 0", calls.Load())
	}
	if _, err := s.pool.Exec(ctx, `UPDATE material_yjs_documents SET stored_version=2 WHERE material_id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	projected, err := s.ProjectLiveNote(ctx, material.ID)
	if err != nil || !projected || calls.Load() != 1 {
		t.Fatalf("lagging: projected=%v err=%v calls=%d", projected, err, calls.Load())
	}
}
