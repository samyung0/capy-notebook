package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A note's Process in the Indexing tab (Epo 2026-10-21) is the owner's, like
// a file's: a non-member misses, an editor is refused, a queued note answers
// processing_started, and a trashed note misses.
func TestProcessNoteChangesRoute(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", WorkspaceID: "ws_e2e_private",
		Kind: "note", Title: "Process route note", Content: noteTestContent(t, "# Process\n\nbody")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM jobs WHERE payload->>'materialId'=$1`, note.ID)
	})
	cleanupMaterial(t, st, note.ID)
	path := "/api/materials/" + note.ID + "/process-changes"
	for _, tc := range []struct {
		user   string
		status int
		code   string
	}{
		{"u_other", http.StatusNotFound, ""},
		{"u_editor", http.StatusForbidden, ""},
		{"u_owner", http.StatusAccepted, ""},
		{"u_owner", http.StatusConflict, "processing_started"},
	} {
		rec := doReq(t, h, http.MethodPost, path, tc.user, map[string]any{})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.code) {
			t.Fatalf("%s Process = %d body=%s, want %d %s", tc.user, rec.Code, rec.Body.String(), tc.status, tc.code)
		}
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET index_job_id=NULL, index_dirty_at=now() WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(t, h, http.MethodDelete, "/api/materials/"+note.ID, "u_owner", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("trash = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", map[string]any{}); rec.Code != http.StatusNotFound {
		t.Fatalf("trashed note Process = %d body=%s, want 404", rec.Code, rec.Body.String())
	}
}
