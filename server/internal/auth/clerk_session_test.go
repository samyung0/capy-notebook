package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	jose "github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// fakeClerk serves the JWKS and user endpoints of Clerk's Backend API and
// counts profile reads per user.
type fakeClerk struct {
	key     *rsa.PrivateKey
	kid     string
	mu      sync.Mutex
	reads   map[string]int
	failing map[string]bool
}

func startFakeClerk(t *testing.T) *fakeClerk {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeClerk{key: key, kid: "kid_" + randomHex(t), reads: map[string]int{}, failing: map[string]bool{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []jose.JSONWebKey{{
				Key: &key.PublicKey, KeyID: f.kid, Algorithm: string(jose.RS256), Use: "sig",
			}}})
		case strings.HasPrefix(r.URL.Path, "/v1/users/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/users/")
			f.mu.Lock()
			f.reads[id]++
			failing := f.failing[id]
			f.mu.Unlock()
			if failing {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"errors":[{"code":"internal_clerk_error"}]}`))
				return
			}
			first := "Clerk"
			primary := "idn_" + id
			_ = json.NewEncoder(w).Encode(clerk.User{
				ID:                    id,
				FirstName:             &first,
				PrimaryEmailAddressID: &primary,
				EmailAddresses: []*clerk.EmailAddress{{
					ID: primary, EmailAddress: id + "@example.test",
					Verification: &clerk.Verification{Status: "verified"},
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	previous := clerk.GetBackend()
	clerk.SetBackend(clerk.NewBackend(&clerk.BackendConfig{
		HTTPClient: srv.Client(),
		URL:        clerk.String(srv.URL + "/v1"),
		Key:        clerk.String("sk_test_fake"),
	}))
	t.Cleanup(func() { clerk.SetBackend(previous) })
	return f
}

func (f *fakeClerk) profileReads(userID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads[userID]
}

func (f *fakeClerk) token(t *testing.T, userID string) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{
		Algorithm: jose.RS256,
		Key:       jose.JSONWebKey{Key: f.key, KeyID: f.kid},
	}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	raw, err := jwt.Signed(signer).Claims(jwt.Claims{
		Subject:   userID,
		Issuer:    "https://clerk.example.test",
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
		Expiry:    jwt.NewNumericDate(now.Add(time.Hour)),
	}).CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func randomHex(t *testing.T) string {
	t.Helper()
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func openClerkTestStore(t *testing.T) *store.Store {
	t.Helper()
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
	return st
}

// clerkRequester sends authenticated requests for one Clerk identity through
// the real middleware and returns the status and the refusal code.
func clerkRequester(t *testing.T, st *store.Store, f *fakeClerk, userID string) func() (int, string) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	handler := auth.Middleware(auth.Config{SecretKey: "sk_test_fake", Store: st})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if auth.UserID(r.Context()) != userID {
				t.Errorf("handler user = %q, want %q", auth.UserID(r.Context()), userID)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
	token := f.token(t, userID)
	return func() (int, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Code
	}
}

// Epo 2026-10-17: the Clerk profile is read on the account's first request and
// then at most once an hour; the account-state check runs on every request.
func TestClerkProfileReadOnFirstRequestThenHourly(t *testing.T) {
	ctx := context.Background()
	st := openClerkTestStore(t)
	f := startFakeClerk(t)
	userID := "user_clerk_hourly_" + randomHex(t)
	request := clerkRequester(t, st, f, userID)

	if status, _ := request(); status != http.StatusNoContent {
		t.Fatalf("first request = %d, want 204", status)
	}
	if got := f.profileReads(userID); got != 1 {
		t.Fatalf("first request read the Clerk profile %d times, want 1", got)
	}
	var email string
	var starterDone bool
	if err := st.Pool().QueryRow(ctx, `SELECT email, starter_workspace_provisioned_at IS NOT NULL
		FROM users WHERE id=$1`, userID).Scan(&email, &starterDone); err != nil {
		t.Fatalf("first request did not provision the account: %v", err)
	}
	if email != userID+"@example.test" || !starterDone {
		t.Fatalf("provisioned email=%q starter=%v", email, starterDone)
	}

	for range 3 {
		if status, _ := request(); status != http.StatusNoContent {
			t.Fatalf("request within the hour = %d, want 204", status)
		}
	}
	if got := f.profileReads(userID); got != 1 {
		t.Fatalf("requests within the hour read the Clerk profile %d times in total, want 1", got)
	}

	if _, err := st.Pool().Exec(ctx, `UPDATE users SET profile_synced_at=now()-interval '61 minutes'
		WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	// A burst of requests after the hour (a page load) reads the profile once.
	var burst sync.WaitGroup
	for range 5 {
		burst.Add(1)
		go func() {
			defer burst.Done()
			if status, _ := request(); status != http.StatusNoContent {
				t.Errorf("request after the hour = %d, want 204", status)
			}
		}()
	}
	burst.Wait()
	if got := f.profileReads(userID); got != 2 {
		t.Fatalf("requests after the hour read the Clerk profile %d times in total, want 2", got)
	}
}

// Security regression: the account-state check refuses a locked account on
// every request, whether or not its profile is due, without a Clerk read.
func TestClerkLockedAccountRefusedOnEveryRequest(t *testing.T) {
	ctx := context.Background()
	st := openClerkTestStore(t)
	f := startFakeClerk(t)
	for _, tc := range []struct {
		state string
		lock  string
		code  string
	}{
		{"suspended", `suspended_at=now(), suspended_reason='test'`, "account_suspended"},
		{"deletion_pending", `deletion_requested_at=now()`, "account_deletion_pending"},
		{"deleted", `deletion_requested_at=now(), deleted_at=now()`, "account_deleted"},
	} {
		t.Run(tc.state, func(t *testing.T) {
			userID := "user_clerk_locked_" + randomHex(t)
			request := clerkRequester(t, st, f, userID)
			if status, _ := request(); status != http.StatusNoContent {
				t.Fatalf("provisioning request = %d, want 204", status)
			}
			for _, due := range []string{"now()", "now()-interval '2 hours'"} {
				if _, err := st.Pool().Exec(ctx, `UPDATE users SET `+tc.lock+`,
					profile_synced_at=`+due+` WHERE id=$1`, userID); err != nil {
					t.Fatal(err)
				}
				for range 2 {
					if status, code := request(); status != http.StatusForbidden || code != tc.code {
						t.Fatalf("locked request (profile synced %s) = %d %q, want 403 %q", due, status, code, tc.code)
					}
				}
			}
			if got := f.profileReads(userID); got != 1 {
				t.Fatalf("locked account read the Clerk profile %d times in total, want only the provisioning read", got)
			}
		})
	}
}

func TestClerkMissedProvisioningRefuses(t *testing.T) {
	ctx := context.Background()
	st := openClerkTestStore(t)
	f := startFakeClerk(t)
	userID := "user_clerk_unprovisioned_" + randomHex(t)
	f.mu.Lock()
	f.failing[userID] = true
	f.mu.Unlock()
	request := clerkRequester(t, st, f, userID)
	for range 2 {
		if status, code := request(); status != http.StatusServiceUnavailable || code != "account_state_unavailable" {
			t.Fatalf("unprovisioned request = %d %q, want 503 account_state_unavailable", status, code)
		}
	}
	var exists bool
	if err := st.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, userID).
		Scan(&exists); err != nil || exists {
		t.Fatalf("failed profile read provisioned a row: exists=%v err=%v", exists, err)
	}
	if got := f.profileReads(userID); got != 2 {
		t.Fatalf("unprovisioned identity read the Clerk profile %d times, want once per request", got)
	}
}
