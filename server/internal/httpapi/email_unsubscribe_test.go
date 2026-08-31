package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/evonotes/server/internal/mail"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
)

func TestEmailUnsubscribeGETDoesNotMutate(t *testing.T) {
	dsn := testdb.URL(t)
	ctx := context.Background()
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.LoadPlanLimits(ctx); err != nil {
		t.Fatal(err)
	}

	userID := "u_1"
	t.Cleanup(func() {
		_, _ = st.SetNotificationPrefs(ctx, userID, store.NotificationPrefs{
			EmailMembership:      true,
			EmailWorkspaceInvite: true,
		})
	})
	secret := "aVeryLongRandomSecretValue-123456"
	token := mail.UnsubscribeToken(secret, userID, "workspace_invite")
	a := &api{s: st, cfg: Config{EmailUnsubscribeSecret: secret}}

	get := httptest.NewRecorder()
	a.emailUnsubscribe(get, httptest.NewRequest(http.MethodGet, "/?token="+token, nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", get.Code)
	}
	prefs, err := st.GetNotificationPrefs(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.EmailWorkspaceInvite || !prefs.EmailMembership {
		t.Fatalf("GET mutated preferences: %#v", prefs)
	}

	post := httptest.NewRecorder()
	a.emailUnsubscribe(post, httptest.NewRequest(http.MethodPost, "/?token="+token, nil))
	if post.Code != http.StatusNoContent {
		t.Fatalf("POST status = %d, want 204", post.Code)
	}
	prefs, err = st.GetNotificationPrefs(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if prefs.EmailWorkspaceInvite || !prefs.EmailMembership {
		t.Fatalf("POST changed the wrong category: %#v", prefs)
	}
}
