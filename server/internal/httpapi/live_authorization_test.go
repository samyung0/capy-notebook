package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestLiveWorkspaceContextClosesAtAccountDeletionBoundary(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	registry, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(registry)

	userID := "u_live_boundary"
	if _, err := st.UpsertUserFromClerk(
		ctx, userID, "Live Boundary", userID+"@example.test", "",
	); err != nil {
		t.Fatal(err)
	}
	workspace, err := st.CreateWorkspace(ctx, userID, "Live boundary", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}

	a := &api{s: st}
	liveCtx, cancel := a.liveWorkspaceContextAtInterval(
		ctx, userID, workspace.ID, 5*time.Millisecond,
	)
	defer cancel()
	if _, err := st.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}

	select {
	case <-liveCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("live workspace context remained open after account deletion")
	}
}
