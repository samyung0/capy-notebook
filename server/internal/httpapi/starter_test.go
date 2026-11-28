package httpapi

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// While files are view-only the starter workspace gets its topic and welcome
// note and no blank Word file (Q860 A).
func TestStarterWorkspaceMakesNoWordFileWhileFilesAreViewOnly(t *testing.T) {
	testdb.SkipWhileFilesEditable(t)
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := randID("u_starter_view_only")
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Starter',$2)`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
	ws, err := st.CreateDefaultWorkspace(ctx, userID)
	if err != nil || ws.ID == "" {
		t.Fatalf("starter workspace = %+v, %v", ws, err)
	}
	// No Office engine: a blank Word file would fail the fill.
	if err := (&api{s: st}).fillStarterWorkspace(ctx, userID, ws); err != nil {
		t.Fatal(err)
	}
	var notes, files int
	if err := st.Pool().QueryRow(ctx, `SELECT
		(SELECT count(*) FROM materials WHERE workspace_id=$1 AND kind='note' AND parent_material_id IS NULL),
		(SELECT count(*) FROM files WHERE workspace_id=$1)`, ws.ID).Scan(&notes, &files); err != nil {
		t.Fatal(err)
	}
	if notes != 1 || files != 0 {
		t.Fatalf("starter workspace holds %d notes and %d files, want the welcome note alone", notes, files)
	}
}
