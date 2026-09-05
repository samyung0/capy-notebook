package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

/* ------------------------------------------------------------------ fake store

fakeStore implements webhookStore in memory so the handlers can be exercised
over a real httptest server without a database. Every method records its inputs
and returns caller-configurable errors, letting tests assert both the HTTP
response and the exact side effects (upserts, deletes, provisioning, idempotency
bookkeeping). */

type recordedEvent struct {
	id, source, eventType, userID string
	payload                       json.RawMessage
}

type upsertCall struct{ id, name, email, avatar string }

type pastDueCall struct {
	subscriptionID string
	eventCreated   int64
}

type fakeStore struct {
	// processed lets a test pretend an event id was already handled.
	processed map[string]bool
	// stripeCustomers maps customer id -> user id for UserIDByStripeCustomer.
	stripeCustomers map[string]string
	// subscriptionOwners maps subscription id -> user id for failed invoices.
	subscriptionOwners map[string]string
	accountStates      map[string]store.AccountState

	// Injected failures keyed by the operation name.
	upsertErr    error
	deleteErr    error
	subUpdateErr error

	// Captured calls.
	recorded        []recordedEvent
	marked          map[string]error
	upserts         []upsertCall
	defaultWSFor    []string
	deleted         []string
	setCustomer     map[string]string
	subUpserts      []store.Subscription
	pastDue         []pastDueCall
	recordedRawLen  int
	checkoutAllowed bool
	checkoutReserve string
	associated      map[string]string
	redacted        map[string]bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		processed:          map[string]bool{},
		stripeCustomers:    map[string]string{},
		subscriptionOwners: map[string]string{},
		accountStates:      map[string]store.AccountState{},
		marked:             map[string]error{},
		setCustomer:        map[string]string{},
		checkoutAllowed:    true,
		associated:         map[string]string{},
		redacted:           map[string]bool{},
	}
}

func (f *fakeStore) ClaimWebhookEvent(_ context.Context, id, source, eventType, userID string, payload json.RawMessage) (string, bool, error) {
	if f.processed[id] {
		return "", true, nil
	}
	f.recorded = append(f.recorded, recordedEvent{
		id: id, source: source, eventType: eventType, userID: userID, payload: payload,
	})
	f.recordedRawLen = len(payload)
	return "claim-" + id, false, nil
}

func (f *fakeStore) AssociateWebhookEvent(_ context.Context, _, id, _, userID string) error {
	f.associated[id] = userID
	return nil
}

func (f *fakeStore) RedactWebhookEvent(_ context.Context, _, id, _ string) error {
	f.redacted[id] = true
	return nil
}

func (f *fakeStore) MarkWebhookProcessed(_ context.Context, _, id, _ string, procErr error) error {
	f.marked[id] = procErr
	return nil
}

func (f *fakeStore) UpsertUserFromWebhook(_ context.Context, id, name, email, avatarURL string) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	f.upserts = append(f.upserts, upsertCall{id: id, name: name, email: email, avatar: avatarURL})
	return nil
}

func (f *fakeStore) CreateDefaultWorkspace(_ context.Context, userID string) error {
	f.defaultWSFor = append(f.defaultWSFor, userID)
	return nil
}

func (f *fakeStore) MarkIdentityDeleted(_ context.Context, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, id)
	return nil
}

func (f *fakeStore) UserIDByStripeCustomer(_ context.Context, customerID string) (string, error) {
	userID, ok := f.stripeCustomers[customerID]
	if !ok {
		return "", store.ErrNotFound
	}
	return userID, nil
}

func (f *fakeStore) RecordStripeCheckoutCompleted(
	_ context.Context,
	_, reservationID, userID, customerID, _ string,
) (bool, error) {
	if f.subUpdateErr != nil {
		return false, f.subUpdateErr
	}
	f.setCustomer[userID] = customerID
	f.checkoutReserve = reservationID
	return f.checkoutAllowed, nil
}

func (f *fakeStore) UpsertSubscription(_ context.Context, sub store.Subscription) error {
	if f.subUpdateErr != nil {
		return f.subUpdateErr
	}
	f.subUpserts = append(f.subUpserts, sub)
	return nil
}

func (f *fakeStore) UpsertAttributedSubscription(
	_ context.Context,
	customerID string,
	sub store.Subscription,
) error {
	if f.subUpdateErr != nil {
		return f.subUpdateErr
	}
	f.setCustomer[sub.UserID] = customerID
	f.subUpserts = append(f.subUpserts, sub)
	return nil
}

func (f *fakeStore) MarkSubscriptionPastDue(_ context.Context, subscriptionID string, eventCreated int64) error {
	if f.subUpdateErr != nil {
		return f.subUpdateErr
	}
	f.pastDue = append(f.pastDue, pastDueCall{subscriptionID: subscriptionID, eventCreated: eventCreated})
	return nil
}

func (f *fakeStore) UserIDBySubscription(_ context.Context, subscriptionID string) (string, error) {
	userID, ok := f.subscriptionOwners[subscriptionID]
	if !ok {
		return "", store.ErrNotFound
	}
	return userID, nil
}

func (f *fakeStore) AccountAccess(_ context.Context, userID string) (store.AccountStatus, error) {
	state, ok := f.accountStates[userID]
	if !ok {
		state = store.AccountActive
	}
	return store.AccountStatus{UserID: userID, State: state}, nil
}

/* ---------------------------------------------------------------- signing help */

const (
	// A svix secret is "whsec_" + base64(signingKey). We derive the key back
	// out when signing so svix.Verify recomputes the same HMAC.
	testClerkSecret  = "whsec_dGVzdC1jbGVyay1zaWduaW5nLWtleS0wMDAwMDAwMDA="
	testStripeSecret = "whsec_test_stripe_signing_secret"
)

// signSvix reproduces the Svix signature scheme Clerk uses: base64 HMAC-SHA256
// over "{id}.{timestamp}.{payload}", emitted as the "v1,<sig>" header trio.
func signSvix(t *testing.T, secret string, body []byte) http.Header {
	return signSvixID(t, secret, "msg_"+hex.EncodeToString([]byte("test")), body)
}

func signSvixID(t *testing.T, secret, id string, body []byte) http.Header {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		t.Fatalf("decode svix secret: %v", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + ts + "." + string(body)))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("svix-id", id)
	h.Set("svix-timestamp", ts)
	h.Set("svix-signature", "v1,"+sig)
	return h
}

func TestClerkWebhookUsesVerifiedSvixIDWhenBodyHasNoID(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})
	for i, name := range []string{"First", "Second"} {
		body, err := json.Marshal(map[string]any{
			"type": "user.updated",
			"data": map[string]any{"id": "user_same", "first_name": name},
		})
		if err != nil {
			t.Fatal(err)
		}
		headerID := fmt.Sprintf("msg_distinct_%d", i)
		resp := post(t, srv.URL+"/webhooks/clerk",
			signSvixID(t, testClerkSecret, headerID, body), body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("delivery %d status=%d", i, resp.StatusCode)
		}
	}
	if len(f.upserts) != 2 {
		t.Fatalf("distinct Svix deliveries processed=%d, want 2", len(f.upserts))
	}
}

// signStripe reproduces Stripe's "t=<ts>,v1=<hex-hmac>" signature over
// "{ts}.{payload}", keyed by the raw endpoint secret string.
func signStripe(_ *testing.T, secret string, body []byte) http.Header {
	ts := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, body)))
	sig := hex.EncodeToString(mac.Sum(nil))

	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Stripe-Signature", fmt.Sprintf("t=%d,v1=%s", ts, sig))
	return h
}

// newTestServer builds an httptest server whose only wired collaborator is the
// fake store, so requests flow through the same routing + handlers as production.
func newTestServer(t *testing.T, f *fakeStore, cfg Config) *httptest.Server {
	return newTestServerWithSubscription(t, f, cfg, nil)
}

func newTestServerWithSubscription(
	t *testing.T,
	f *fakeStore,
	cfg Config,
	retrieve func(string) (*stripe.Subscription, error),
) *httptest.Server {
	t.Helper()
	a := &api{wh: f, cfg: cfg, stripeSubscription: retrieve}
	mux := http.NewServeMux()
	mux.HandleFunc("/webhooks/clerk", a.clerkWebhook)
	mux.HandleFunc("/webhooks/stripe", a.stripeWebhook)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, url string, headers http.Header, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header = headers
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

/* ------------------------------------------------------------------ clerk tests */

func clerkBody(t *testing.T, id, evtType string, data map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"id": id, "type": evtType, "data": data})
	if err != nil {
		t.Fatalf("marshal clerk body: %v", err)
	}
	return b
}

func TestClerkWebhook_UserCreated(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_created_1", "user.created", map[string]any{
		"id":         "user_123",
		"first_name": "Ada",
		"last_name":  "Lovelace",
		"email_addresses": []map[string]any{
			{"email_address": "ada@example.com"},
		},
		"image_url": "https://img.example/ada.png",
	})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.upserts) != 1 {
		t.Fatalf("upserts = %d, want 1", len(f.upserts))
	}
	got := f.upserts[0]
	if got.id != "user_123" || got.name != "Ada Lovelace" || got.email != "ada@example.com" || got.avatar != "https://img.example/ada.png" {
		t.Errorf("upsert mismatch: %+v", got)
	}
	if len(f.defaultWSFor) != 1 || f.defaultWSFor[0] != "user_123" {
		t.Errorf("default workspace not provisioned on create: %v", f.defaultWSFor)
	}
	if _, ok := f.marked["evt_created_1"]; !ok {
		t.Errorf("event not marked processed")
	}
	if len(f.recorded) != 1 || f.recorded[0].source != "clerk" ||
		f.recorded[0].eventType != "user.created" || f.recorded[0].userID != "" {
		t.Errorf("event not recorded correctly: %+v", f.recorded)
	}
	if f.associated["evt_created_1"] != "user_123" || f.redacted["evt_created_1"] {
		t.Fatalf("created event association=%q redacted=%v",
			f.associated["evt_created_1"], f.redacted["evt_created_1"])
	}
}

func TestClerkWebhook_UserUpdated_NoWorkspaceProvision(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_updated_1", "user.updated", map[string]any{
		"id":         "user_456",
		"first_name": "Grace",
		"email_addresses": []map[string]any{
			{"email_address": "grace@example.com"},
		},
	})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.upserts) != 1 || f.upserts[0].name != "Grace" {
		t.Fatalf("upsert mismatch: %+v", f.upserts)
	}
	if len(f.defaultWSFor) != 0 {
		t.Errorf("user.updated must not provision a workspace: %v", f.defaultWSFor)
	}
}

func TestClerkWebhook_UserDeleted(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_deleted_1", "user.deleted", map[string]any{"id": "user_789"})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.deleted) != 1 || f.deleted[0] != "user_789" {
		t.Errorf("delete mismatch: %v", f.deleted)
	}
}

func TestClerkWebhook_UnknownUserDeletedIsTerminalAndRedacted(t *testing.T) {
	f := newFakeStore()
	f.deleteErr = store.ErrNotFound
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_deleted_unknown", "user.deleted", map[string]any{
		"id": "user_never_provisioned",
	})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !f.redacted["evt_deleted_unknown"] || f.associated["evt_deleted_unknown"] != "" {
		t.Fatalf("unknown deletion association=%q redacted=%v",
			f.associated["evt_deleted_unknown"], f.redacted["evt_deleted_unknown"])
	}
}

func TestClerkWebhook_InvalidSignature(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_bad", "user.created", map[string]any{"id": "user_x"})
	headers := signSvix(t, testClerkSecret, body)
	headers.Set("svix-signature", "v1,deadbeef") // tamper

	resp := post(t, srv.URL+"/webhooks/clerk", headers, body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if len(f.upserts) != 0 || len(f.recorded) != 0 {
		t.Errorf("no side effects expected on bad signature")
	}
}

func TestClerkWebhook_TamperedBody(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_tamper", "user.created", map[string]any{"id": "user_x"})
	headers := signSvix(t, testClerkSecret, body)
	// Sign the original body but send a different one.
	tampered := clerkBody(t, "evt_tamper", "user.created", map[string]any{"id": "attacker"})

	resp := post(t, srv.URL+"/webhooks/clerk", headers, tampered)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 on tampered body", resp.StatusCode)
	}
}

func TestClerkWebhook_NotConfigured(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: ""})

	body := clerkBody(t, "evt", "user.created", map[string]any{"id": "user_x"})
	resp := post(t, srv.URL+"/webhooks/clerk", http.Header{"Content-Type": []string{"application/json"}}, body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
}

func TestClerkWebhook_Idempotent(t *testing.T) {
	f := newFakeStore()
	f.processed["evt_dup"] = true
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_dup", "user.created", map[string]any{"id": "user_dup"})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.upserts) != 0 {
		t.Errorf("already-processed event must not re-run side effects: %v", f.upserts)
	}
}

func TestClerkWebhook_ProcessingErrorReturns500(t *testing.T) {
	f := newFakeStore()
	f.upsertErr = fmt.Errorf("db down")
	srv := newTestServer(t, f, Config{ClerkWebhookSecret: testClerkSecret})

	body := clerkBody(t, "evt_err", "user.created", map[string]any{"id": "user_err"})
	resp := post(t, srv.URL+"/webhooks/clerk", signSvix(t, testClerkSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if err := f.marked["evt_err"]; err == nil {
		t.Errorf("processing error should be persisted via MarkWebhookProcessed")
	}
}

/* ----------------------------------------------------------------- stripe tests */

func stripeBody(t *testing.T, id, evtType string, object map[string]any) []byte {
	t.Helper()
	// api_version must match the SDK's expected version or ConstructEvent
	// rejects the event before signature checks even matter.
	b, err := json.Marshal(map[string]any{
		"id":          id,
		"type":        evtType,
		"api_version": stripe.APIVersion,
		"data":        map[string]any{"object": object},
	})
	if err != nil {
		t.Fatalf("marshal stripe body: %v", err)
	}
	return b
}

func TestStripeWebhook_CheckoutCompleted(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	body := stripeBody(t, "evt_stripe_1", "checkout.session.completed", map[string]any{
		"id":       "cs_test_1",
		"customer": "cus_123",
		"metadata": map[string]string{
			"user_id": "user_abc", "checkout_reservation_id": "checkout_local_1",
		},
		"subscription": map[string]any{
			"id":     "sub_checkout",
			"status": "active",
			"items": map[string]any{
				"data": []map[string]any{
					{"price": map[string]any{"id": "price_pro_123"}},
				},
			},
		},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if f.setCustomer["user_abc"] != "cus_123" {
		t.Errorf("stripe customer id not linked: %v", f.setCustomer)
	}
	if f.checkoutReserve != "checkout_local_1" {
		t.Fatalf("checkout reservation=%q, want checkout_local_1", f.checkoutReserve)
	}
	// Checkout used to only link the customer, leaving a paying user on free
	// limits until customer.subscription.created happened to arrive.
	if len(f.subUpserts) != 1 {
		t.Fatalf("subscription upserts = %d, want 1", len(f.subUpserts))
	}
	got := f.subUpserts[0]
	if got.UserID != "user_abc" || got.PlanTier != store.PlanPro || got.Status != "active" {
		t.Errorf("checkout did not record the paid tier: %+v", got)
	}
}

func TestStripeWebhook_CheckoutCompletedRejectsCustomerUserMismatch(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_other"] = "user_other"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})
	body := stripeBody(t, "evt_checkout_mismatch", "checkout.session.completed", map[string]any{
		"id":       "cs_mismatch",
		"customer": "cus_other",
		"metadata": map[string]string{"user_id": "user_metadata"},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d, want retryable 500", resp.StatusCode)
	}
	if len(f.setCustomer) != 0 || f.associated["evt_checkout_mismatch"] != "" {
		t.Fatalf("mismatched checkout mutated customer=%v associated=%v", f.setCustomer, f.associated)
	}
}

func TestStripeWebhook_CheckoutCompletedRetrievesSubscriptionID(t *testing.T) {
	f := newFakeStore()
	requested := ""
	srv := newTestServerWithSubscription(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	}, func(id string) (*stripe.Subscription, error) {
		requested = id
		return &stripe.Subscription{
			ID:     id,
			Status: stripe.SubscriptionStatusActive,
			Items: &stripe.SubscriptionItemList{Data: []*stripe.SubscriptionItem{{
				Price: &stripe.Price{ID: "price_pro_123"},
			}}},
		}, nil
	})

	body := stripeBody(t, "evt_checkout_id", "checkout.session.completed", map[string]any{
		"id":           "cs_checkout_id",
		"customer":     "cus_checkout_id",
		"metadata":     map[string]string{"user_id": "user_checkout_id"},
		"subscription": "sub_checkout_id",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if requested != "sub_checkout_id" {
		t.Fatalf("retrieved subscription %q, want sub_checkout_id", requested)
	}
	if len(f.subUpserts) != 1 || f.subUpserts[0].PlanTier != store.PlanPro ||
		f.subUpserts[0].Status != "active" {
		t.Fatalf("checkout subscription upserts = %+v", f.subUpserts)
	}
}

func TestStripeWebhook_CheckoutCompletedLockedAccountDoesNotGrantEntitlement(t *testing.T) {
	f := newFakeStore()
	f.checkoutAllowed = false
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})
	body := stripeBody(t, "evt_stripe_locked", "checkout.session.completed", map[string]any{
		"id":       "cs_locked",
		"customer": "cus_locked",
		"metadata": map[string]string{"user_id": "user_locked"},
		"subscription": map[string]any{
			"id": "sub_locked", "status": "active",
			"items": map[string]any{"data": []map[string]any{{
				"price": map[string]any{"id": "price_pro_123"},
			}}},
		},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 0 {
		t.Fatalf("locked account received entitlement: %+v", f.subUpserts)
	}
}

func TestStripeWebhook_CheckoutCompleted_CustomerLookup(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_999"] = "user_from_lookup"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	// No metadata.user_id: handler must fall back to UserIDByStripeCustomer.
	body := stripeBody(t, "evt_stripe_2", "checkout.session.completed", map[string]any{
		"id":       "cs_test_2",
		"customer": "cus_999",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if f.setCustomer["user_from_lookup"] != "cus_999" {
		t.Errorf("customer lookup fallback failed: %v", f.setCustomer)
	}
}

func TestStripeWebhook_CheckoutCompletedUnknownFallbackIsTerminal(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_checkout_orphan", "checkout.session.completed", map[string]any{
		"id":       "cs_orphan",
		"customer": "cus_orphan",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if f.marked["evt_checkout_orphan"] != nil {
		t.Fatalf("orphan checkout was left retryable: %v", f.marked["evt_checkout_orphan"])
	}
	if len(f.subUpserts) != 0 || len(f.setCustomer) != 0 {
		t.Fatalf("orphan checkout changed billing state: upserts=%+v customers=%+v", f.subUpserts, f.setCustomer)
	}
	if !f.redacted["evt_checkout_orphan"] {
		t.Fatal("orphan checkout payload was retained")
	}
}

func TestStripeWebhook_SubscriptionUpdated_ProTier(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_555"] = "user_555"
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	periodEnd := time.Now().Add(30 * 24 * time.Hour).Unix()
	body := stripeBody(t, "evt_sub_1", "customer.subscription.updated", map[string]any{
		"id":                   "sub_1",
		"customer":             "cus_555",
		"status":               "active",
		"cancel_at_period_end": true,
		"items": map[string]any{
			"data": []map[string]any{
				{
					"price":              map[string]any{"id": "price_pro_123"},
					"current_period_end": periodEnd,
				},
			},
		},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 1 {
		t.Fatalf("subscription upserts = %d, want 1", len(f.subUpserts))
	}
	got := f.subUpserts[0]
	if got.StripeSubscriptionID != "sub_1" || got.UserID != "user_555" ||
		got.Status != "active" || got.PlanTier != store.PlanPro {
		t.Errorf("subscription update mismatch: %+v", got)
	}
	// The period end lives on the item, not the subscription, in this API
	// version. Reading it off the wrong object is why renewalAt was always null.
	if got.CurrentPeriodEnd == nil || got.CurrentPeriodEnd.Unix() != periodEnd {
		t.Errorf("period end not captured: %+v", got.CurrentPeriodEnd)
	}
	if !got.CancelAtPeriodEnd {
		t.Error("cancel_at_period_end not captured")
	}
}

func TestStripeWebhook_SubscriptionDeleted_ClosesButRetainsHistoricalTier(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_666"] = "user_666"
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	// Deletion revokes entitlement through status. The subscription row keeps
	// its historical product tier so paid-lapse grace remains derivable.
	body := stripeBody(t, "evt_sub_2", "customer.subscription.deleted", map[string]any{
		"id":       "sub_2",
		"customer": "cus_666",
		"status":   "active",
		"items": map[string]any{
			"data": []map[string]any{
				{"price": map[string]any{"id": "price_pro_123"}},
			},
		},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 1 {
		t.Fatalf("subscription upserts = %d, want 1", len(f.subUpserts))
	}
	got := f.subUpserts[0]
	if got.Status != "canceled" || got.PlanTier != store.PlanPro {
		t.Errorf("deleted subscription must be canceled historical Pro, got %+v", got)
	}
}

func TestStripeWebhook_SubscriptionForUnknownCustomerIsIgnored(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	// A subscription for a customer we cannot resolve has nowhere to go. Writing
	// it with an empty user id would violate the FK and fail the webhook forever.
	body := stripeBody(t, "evt_sub_orphan", "customer.subscription.updated", map[string]any{
		"id": "sub_orphan", "customer": "cus_unknown", "status": "active",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 0 {
		t.Errorf("unresolvable subscription must not be written: %+v", f.subUpserts)
	}
	if !f.redacted["evt_sub_orphan"] {
		t.Fatal("orphan subscription payload was retained")
	}
}

func TestStripeWebhook_SubscriptionMetadataHandlesEarlyDelivery(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	body := stripeBody(t, "evt_sub_early", "customer.subscription.created", map[string]any{
		"id":       "sub_early",
		"customer": "cus_not_bound_yet",
		"status":   "active",
		"metadata": map[string]string{"user_id": "user_early"},
		"items": map[string]any{"data": []map[string]any{{
			"price": map[string]any{"id": "price_pro_123"},
		}}},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 1 || f.subUpserts[0].UserID != "user_early" {
		t.Fatalf("early subscription was not attributed from metadata: %+v", f.subUpserts)
	}
	if f.setCustomer["user_early"] != "cus_not_bound_yet" {
		t.Fatalf("early subscription customer=%q, want cus_not_bound_yet",
			f.setCustomer["user_early"])
	}
}

func TestStripeWebhook_SubscriptionRejectsCustomerMetadataMismatch(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_identity_b"] = "user_b"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_sub_identity_mismatch", "customer.subscription.updated", map[string]any{
		"id":       "sub_identity_mismatch",
		"customer": "cus_identity_b",
		"status":   "active",
		"metadata": map[string]string{"user_id": "user_a"},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d, want retryable 500", resp.StatusCode)
	}
	if !errors.Is(f.marked["evt_sub_identity_mismatch"], store.ErrConflict) {
		t.Fatalf("processed error=%v, want conflict", f.marked["evt_sub_identity_mismatch"])
	}
	if len(f.subUpserts) != 0 || f.associated["evt_sub_identity_mismatch"] != "" {
		t.Fatalf("identity mismatch mutated webhook state: upserts=%v association=%q",
			f.subUpserts, f.associated["evt_sub_identity_mismatch"])
	}
}

func TestStripeWebhook_SubscriptionRejectsExistingOwnerMismatch(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_existing_b"] = "user_b"
	f.subscriptionOwners["sub_existing_a"] = "user_a"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_sub_owner_mismatch", "customer.subscription.updated", map[string]any{
		"id":       "sub_existing_a",
		"customer": "cus_existing_b",
		"status":   "active",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d, want retryable 500", resp.StatusCode)
	}
	if !errors.Is(f.marked["evt_sub_owner_mismatch"], store.ErrConflict) {
		t.Fatalf("processed error=%v, want conflict", f.marked["evt_sub_owner_mismatch"])
	}
	if len(f.subUpserts) != 0 || f.associated["evt_sub_owner_mismatch"] != "" {
		t.Fatalf("owner mismatch mutated webhook state: upserts=%v association=%q",
			f.subUpserts, f.associated["evt_sub_owner_mismatch"])
	}
}

func TestStripeWebhook_SubscriptionForPurgedCustomerIsTerminal(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_purged"] = "user_purged"
	f.accountStates["user_purged"] = store.AccountDeleted
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_sub_purged", "customer.subscription.updated", map[string]any{
		"id": "sub_purged", "customer": "cus_purged", "status": "active",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 0 {
		t.Fatalf("purged subscription changed billing state: %+v", f.subUpserts)
	}
	if !f.redacted["evt_sub_purged"] {
		t.Fatal("purged subscription payload was retained")
	}
}

func TestStripeWebhook_InvoicePaymentFailedMarksPastDue(t *testing.T) {
	f := newFakeStore()
	f.subscriptionOwners["sub_failing"] = "user_failing"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	// The link moved to parent.subscription_details in the current API version;
	// reading invoice.subscription silently finds nothing.
	body := stripeBody(t, "evt_invoice_1", "invoice.payment_failed", map[string]any{
		"id": "in_1",
		"parent": map[string]any{
			"type": "subscription_details",
			"subscription_details": map[string]any{
				"subscription": map[string]any{"id": "sub_failing"},
			},
		},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.pastDue) != 1 || f.pastDue[0].subscriptionID != "sub_failing" {
		t.Fatalf("payment failure not recorded: %+v", f.pastDue)
	}
}

func TestStripeWebhook_InvoicePaymentFailedRetriesUntilSubscriptionArrives(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_failing"] = "user_failing"
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})
	body := stripeBody(t, "evt_invoice_early", "invoice.payment_failed", map[string]any{
		"id":       "in_early",
		"customer": "cus_failing",
		"parent": map[string]any{
			"type": "subscription_details",
			"subscription_details": map[string]any{
				"subscription": map[string]any{"id": "sub_early"},
			},
		},
	})

	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("early delivery status = %d, want 500", resp.StatusCode)
	}
	if f.marked["evt_invoice_early"] == nil || len(f.pastDue) != 0 {
		t.Fatalf("early delivery marked=%v pastDue=%+v", f.marked["evt_invoice_early"], f.pastDue)
	}

	f.subscriptionOwners["sub_early"] = "user_failing"
	resp = post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("retry status = %d, want 200", resp.StatusCode)
	}
	if len(f.pastDue) != 1 || f.pastDue[0].subscriptionID != "sub_early" {
		t.Fatalf("retry did not record payment failure: %+v", f.pastDue)
	}
}

func TestStripeWebhook_InvoicePaymentFailedIgnoresPurgedOrOrphanedCustomer(t *testing.T) {
	for _, test := range []struct {
		name              string
		customerID        string
		userID            string
		subscriptionOwner bool
		state             store.AccountState
	}{
		{name: "orphaned", customerID: "cus_orphaned"},
		{name: "purged", customerID: "cus_purged", userID: "user_purged", state: store.AccountDeleted},
		{
			name: "purged_retained_subscription", customerID: "cus_purged_retained",
			userID: "user_purged_retained", subscriptionOwner: true, state: store.AccountDeleted,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFakeStore()
			if test.userID != "" {
				f.stripeCustomers[test.customerID] = test.userID
				f.accountStates[test.userID] = test.state
			}
			if test.subscriptionOwner {
				f.subscriptionOwners["sub_"+test.name] = test.userID
			}
			srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})
			defer srv.Close()
			body := stripeBody(t, "evt_invoice_"+test.name, "invoice.payment_failed", map[string]any{
				"id":       "in_" + test.name,
				"customer": test.customerID,
				"parent": map[string]any{
					"type": "subscription_details",
					"subscription_details": map[string]any{
						"subscription": map[string]any{"id": "sub_" + test.name},
					},
				},
			})
			resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if f.marked["evt_invoice_"+test.name] != nil || len(f.pastDue) != 0 {
				t.Fatalf("terminal delivery marked=%v pastDue=%+v",
					f.marked["evt_invoice_"+test.name], f.pastDue)
			}
			if !f.redacted["evt_invoice_"+test.name] {
				t.Fatal("terminal invoice payload was retained")
			}
			if f.associated["evt_invoice_"+test.name] != "" {
				t.Fatalf("terminal invoice was associated with %q", f.associated["evt_invoice_"+test.name])
			}
		})
	}
}

func TestStripeWebhook_PostPurgeTerminalPayloadsAreRedactedInStore(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users
		(id,name,stripe_customer_id,deletion_requested_at,purge_after,deleted_at,identity_deleted_at)
		VALUES ('user_webhook_purged','', 'cus_webhook_purged',now(),now(),now(),now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id,user_id,status,plan_tier,current_period_end)
		VALUES ('sub_post_purge','user_webhook_purged','active','pro',now()+interval '1 month')`); err != nil {
		t.Fatal(err)
	}
	a := &api{wh: st, cfg: Config{StripeWebhookSecret: testStripeSecret}}
	mux := http.NewServeMux()
	mux.HandleFunc("/webhooks/stripe", a.stripeWebhook)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	tests := []struct {
		id        string
		eventType string
		object    map[string]any
	}{
		{
			id:        "evt_post_purge_subscription",
			eventType: "customer.subscription.updated",
			object: map[string]any{
				"id": "sub_post_purge", "customer": "cus_webhook_purged", "status": "active",
			},
		},
		{
			id:        "evt_post_purge_invoice",
			eventType: "invoice.payment_failed",
			object: map[string]any{
				"id": "in_post_purge", "customer": "cus_webhook_purged",
				"parent": map[string]any{
					"type": "subscription_details",
					"subscription_details": map[string]any{
						"subscription": map[string]any{"id": "sub_post_purge"},
					},
				},
			},
		},
	}
	for _, test := range tests {
		body := stripeBody(t, test.id, test.eventType, test.object)
		resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d, want 200", test.id, resp.StatusCode)
		}
		var payload string
		if err := st.Pool().QueryRow(ctx, `SELECT payload::text FROM webhook_events WHERE id=$1`, test.id).
			Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if payload != "{}" {
			t.Fatalf("%s payload=%s, want {}", test.id, payload)
		}
	}
	var subscriptionStatus string
	if err := st.Pool().QueryRow(ctx, `SELECT status FROM user_subscriptions
		WHERE stripe_subscription_id='sub_post_purge'`).Scan(&subscriptionStatus); err != nil {
		t.Fatal(err)
	}
	if subscriptionStatus != "active" {
		t.Fatalf("purged subscription status=%q, want active", subscriptionStatus)
	}
}

func TestStripeWebhook_InvalidSignature(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_bad", "checkout.session.completed", map[string]any{"id": "cs_x"})
	headers := signStripe(t, testStripeSecret, body)
	headers.Set("Stripe-Signature", "t=1,v1=deadbeef") // tamper

	resp := post(t, srv.URL+"/webhooks/stripe", headers, body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if len(f.subUpserts) != 0 || len(f.recorded) != 0 {
		t.Errorf("no side effects expected on bad signature")
	}
}

func TestStripeWebhook_NotConfigured(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{StripeWebhookSecret: ""})

	body := stripeBody(t, "evt", "checkout.session.completed", map[string]any{"id": "cs_x"})
	resp := post(t, srv.URL+"/webhooks/stripe", http.Header{"Content-Type": []string{"application/json"}}, body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
}

func TestStripeWebhook_Idempotent(t *testing.T) {
	f := newFakeStore()
	f.processed["evt_dup_stripe"] = true
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_dup_stripe", "customer.subscription.updated", map[string]any{
		"id": "sub_dup", "customer": "cus_dup", "status": "active",
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(f.subUpserts) != 0 {
		t.Errorf("already-processed stripe event must not re-run side effects")
	}
}
