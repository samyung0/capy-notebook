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

// The cap counts owned and joined workspaces together (Epo 2026-10-28): at
// the limit a user can neither create one nor accept an invitation, while a
// transfer to a member, which adds nothing, still goes through.
func TestWorkspaceCapCountsOwnedAndJoinedTogether(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "u_cap_member")
	other := newBlobTestUser(t, s, "u_cap_inviter")
	invite := func(wsID string) string {
		t.Helper()
		id := uid("inv")
		if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_invites
			(id,workspace_id,invited_user_id,email,role,token_hash,invited_by,expires_at)
			VALUES ($1,$2,$3,$4,'viewer',decode(md5($1) || md5($1),'hex'),$5,now()+interval '1 day')`,
			id, wsID, user, user+"@example.test", other); err != nil {
			t.Fatal(err)
		}
		return id
	}
	joined, err := s.CreateWorkspace(ctx, other, WorkspaceCreate{Name: "Joined", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	refused, err := s.CreateWorkspace(ctx, other, WorkspaceCreate{Name: "Refused", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, invite(joined.ID), user); err != nil {
		t.Fatal(err)
	}
	for i := range 9 {
		if _, err := s.CreateWorkspace(ctx, user, WorkspaceCreate{Name: fmt.Sprintf("Owned %d", i), Tags: []TagRef{}}); err != nil {
			t.Fatalf("owned workspace %d with one joined: %v", i+1, err)
		}
	}
	if _, err := s.CreateWorkspace(ctx, user, WorkspaceCreate{Name: "Eleventh", Tags: []TagRef{}}); !errors.Is(err, ErrWorkspaceLimitExceeded) {
		t.Fatalf("create at 9 owned + 1 joined: %v", err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, invite(refused.ID), user); !errors.Is(err, ErrWorkspaceLimitExceeded) {
		t.Fatalf("accept at the cap: %v", err)
	}
	if _, err := s.TransferWorkspace(ctx, other, joined.ID, user); err != nil {
		t.Fatalf("transfer to a member at the cap: %v", err)
	}
}
