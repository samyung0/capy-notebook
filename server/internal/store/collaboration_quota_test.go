package store

import (
	"context"
	"testing"
	"time"
)

func TestCollaborationQuotaLiveFreeOnlyAccountStaysActive(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "collab_live_free_only")
	current := time.Now().Add(time.Hour).UTC()
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, plan_tier,
		 current_period_end, stripe_event_created)
		VALUES ($1,$2,'active','free',$3,1)`, uid("sub"), user, current); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateWorkspace(ctx, user, "Live Free only", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, user, "legacy-over-free.pdf", "pdf", nil, "", 1, "sources/"+uid("blob"),
	)
	if err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`,
		file.ID, freeLimit+1); err != nil {
		t.Fatal(err)
	}
	status, err := s.AccountAccess(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountActive || status.PlanTier != PlanFree {
		t.Fatalf("live-Free-only state=%s tier=%s, want active/free",
			status.State, status.PlanTier)
	}
}
