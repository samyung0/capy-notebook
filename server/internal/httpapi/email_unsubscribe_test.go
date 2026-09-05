package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
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

	userID := "u_email_unsubscribe_get"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email)
		VALUES ($1,'Email Unsubscribe Test',$2)`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
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
