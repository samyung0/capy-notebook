package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestFreePlanOwnsTenWorkspaces(t *testing.T) {
	s := openAccessTestStore(t)
	user := newBlobTestUser(t, s, "u_workspace_cap")
	ctx := context.Background()
	for i := range 10 {
		if _, err := s.CreateWorkspace(ctx, user, WorkspaceCreate{Name: fmt.Sprintf("Owned %d", i), Tags: []TagRef{}}); err != nil {
			t.Fatalf("workspace %d: %v", i+1, err)
		}
	}
	_, err := s.CreateWorkspace(ctx, user, WorkspaceCreate{Name: "One too many", Tags: []TagRef{}})
	if !errors.Is(err, ErrWorkspaceLimitExceeded) {
		t.Fatalf("eleventh workspace: %v", err)
	}
}
