package httpapi_test

import (
	"context"
	"net/http"
	"testing"
)

// TestReinvitingAMemberSkipsTheInviteLimits (security regression: rate-limit
// audit M8). Inviting a current member by user id, or the owner themself,
// sends nothing: it answers 202 every time, even twice within the resend
// wait, and leaves the owner's daily count alone.
func TestReinvitingAMemberSkipsTheInviteLimits(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(ctx, `DELETE FROM workspace_invites
			WHERE workspace_id='ws_e2e_private' AND email IN ('u_viewer', 'u_owner', 'owner@capynotebook.test')`)
	})
	used := func() (n int) {
		t.Helper()
		if err := st.Pool().QueryRow(ctx, `SELECT COALESCE(sum(invites), 0) FROM invite_usage
			WHERE user_id='u_owner'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := used()
	for _, identifier := range []string{"u_viewer", "u_owner", "owner@capynotebook.test"} {
		for attempt := range 2 {
			rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/invites", "u_owner",
				map[string]any{"identifier": identifier, "role": "editor"})
			if rec.Code != http.StatusAccepted {
				t.Fatalf("invite %q, attempt %d → %d %s, want 202", identifier, attempt+1, rec.Code, rec.Body.String())
			}
		}
	}
	if after := used(); after != before {
		t.Fatalf("the owner's invite count went from %d to %d", before, after)
	}
}
