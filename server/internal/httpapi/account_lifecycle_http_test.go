package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func deletionAPI(t *testing.T, mapped bool) (http.Handler, *pgxpool.Pool, string, string) {
	t.Helper()
	ctx := context.Background()
	dsn := testdb.URL(t)
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	userID := fmt.Sprintf("u_deletion_stripe_%d", time.Now().UnixNano())
	email := userID + "@example.test"
	var customerID *string
	if mapped {
		id := "cus_" + userID
		customerID = &id
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email,stripe_customer_id)
		VALUES ($1,'Deletion Stripe Test',$2,$3)`, userID, email, customerID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})

	handler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "capy", httpapi.Config{
		AuthDisabled: true,
		DevUserID:    userID,
	})
	return handler, pool, userID, email
}

func readDeletionPreflight(t *testing.T, handler http.Handler) struct {
	CanDelete           bool  `json:"canDelete"`
	LifecycleGeneration int64 `json:"lifecycleGeneration"`
	Subscription        *struct {
		Unavailable bool `json:"unavailable"`
	} `json:"subscription"`
} {
	t.Helper()
	rec := doReq(t, handler, http.MethodGet, "/api/account/deletion", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("preflight status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		CanDelete           bool  `json:"canDelete"`
		LifecycleGeneration int64 `json:"lifecycleGeneration"`
		Subscription        *struct {
			Unavailable bool `json:"unavailable"`
		} `json:"subscription"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestAccountDeletionFailsClosedForMappedCustomerWithoutStripe(t *testing.T) {
	handler, pool, userID, email := deletionAPI(t, true)
	preflight := readDeletionPreflight(t, handler)
	if preflight.CanDelete || preflight.Subscription == nil || !preflight.Subscription.Unavailable {
		t.Fatalf("preflight = %+v, want unavailable Stripe blocker", preflight)
	}

	rec := doReq(t, handler, http.MethodPost, "/api/account/deletion", "", map[string]any{
		"confirmEmail": email, "lifecycleGeneration": preflight.LifecycleGeneration,
	})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("confirmation status = %d body=%s", rec.Code, rec.Body.String())
	}
	var requestedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT deletion_requested_at FROM users WHERE id=$1`, userID).Scan(&requestedAt); err != nil {
		t.Fatal(err)
	}
	if requestedAt != nil {
		t.Fatalf("deletion lifecycle changed at %s", requestedAt)
	}
}

func TestAccountDeletionAllowsUnmappedCustomerWhenStripeIsDisabled(t *testing.T) {
	handler, _, _, email := deletionAPI(t, false)
	preflight := readDeletionPreflight(t, handler)
	if !preflight.CanDelete || preflight.Subscription != nil {
		t.Fatalf("preflight = %+v, want deletion allowed", preflight)
	}

	rec := doReq(t, handler, http.MethodPost, "/api/account/deletion", "", map[string]any{
		"confirmEmail": email, "lifecycleGeneration": preflight.LifecycleGeneration,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirmation status = %d body=%s", rec.Code, rec.Body.String())
	}
}
