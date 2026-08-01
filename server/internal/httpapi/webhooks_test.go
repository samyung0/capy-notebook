package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v82"
)

/* ------------------------------------------------------------------ fake store

fakeStore implements webhookStore in memory so the handlers can be exercised
over a real httptest server without a database. Every method records its inputs
and returns caller-configurable errors, letting tests assert both the HTTP
response and the exact side effects (upserts, deletes, provisioning, idempotency
bookkeeping). */

type recordedEvent struct {
	id, source, eventType string
	payload               json.RawMessage
}

type upsertCall struct{ id, name, email, avatar string }

type subUpdateCall struct{ customerID, status, planTier string }

type fakeStore struct {
	// processed lets a test pretend an event id was already handled.
	processed map[string]bool
	// stripeCustomers maps customer id -> user id for UserIDByStripeCustomer.
	stripeCustomers map[string]string

	// Injected failures keyed by the operation name.
	upsertErr    error
	deleteErr    error
	subUpdateErr error

	// Captured calls.
	recorded       []recordedEvent
	marked         map[string]error
	upserts        []upsertCall
	defaultWSFor   []string
	deleted        []string
	setCustomer    map[string]string
	subUpdates     []subUpdateCall
	recordedRawLen int
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		processed:       map[string]bool{},
		stripeCustomers: map[string]string{},
		marked:          map[string]error{},
		setCustomer:     map[string]string{},
	}
}

func (f *fakeStore) WebhookProcessed(_ context.Context, id string) (bool, error) {
	return f.processed[id], nil
}

func (f *fakeStore) RecordWebhookEvent(_ context.Context, id, source, eventType string, payload json.RawMessage) error {
	f.recorded = append(f.recorded, recordedEvent{id: id, source: source, eventType: eventType, payload: payload})
	f.recordedRawLen = len(payload)
	return nil
}

func (f *fakeStore) MarkWebhookProcessed(_ context.Context, id string, procErr error) error {
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

func (f *fakeStore) MarkUserDeleted(_ context.Context, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, id)
	return nil
}

func (f *fakeStore) UserIDByStripeCustomer(_ context.Context, customerID string) (string, error) {
	return f.stripeCustomers[customerID], nil
}

func (f *fakeStore) SetStripeCustomerID(_ context.Context, userID, customerID string) error {
	f.setCustomer[userID] = customerID
	return nil
}

func (f *fakeStore) UpdateSubscriptionByCustomerID(_ context.Context, customerID, status, planTier string) error {
	if f.subUpdateErr != nil {
		return f.subUpdateErr
	}
	f.subUpdates = append(f.subUpdates, subUpdateCall{customerID: customerID, status: status, planTier: planTier})
	return nil
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
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		t.Fatalf("decode svix secret: %v", err)
	}
	id := "msg_" + hex.EncodeToString([]byte("test"))
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
	t.Helper()
	a := &api{wh: f, cfg: cfg}
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
	if len(f.recorded) != 1 || f.recorded[0].source != "clerk" || f.recorded[0].eventType != "user.created" {
		t.Errorf("event not recorded correctly: %+v", f.recorded)
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
	srv := newTestServer(t, f, Config{StripeWebhookSecret: testStripeSecret})

	body := stripeBody(t, "evt_stripe_1", "checkout.session.completed", map[string]any{
		"id":       "cs_test_1",
		"customer": "cus_123",
		"metadata": map[string]string{"user_id": "user_abc"},
	})
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if f.setCustomer["user_abc"] != "cus_123" {
		t.Errorf("stripe customer id not linked: %v", f.setCustomer)
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

func TestStripeWebhook_SubscriptionUpdated_ProTier(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	body := stripeBody(t, "evt_sub_1", "customer.subscription.updated", map[string]any{
		"id":       "sub_1",
		"customer": "cus_555",
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
	if len(f.subUpdates) != 1 {
		t.Fatalf("subUpdates = %d, want 1", len(f.subUpdates))
	}
	got := f.subUpdates[0]
	if got.customerID != "cus_555" || got.status != "active" || got.planTier != "pro" {
		t.Errorf("subscription update mismatch: %+v", got)
	}
}

func TestStripeWebhook_SubscriptionDeleted_ForcesFree(t *testing.T) {
	f := newFakeStore()
	srv := newTestServer(t, f, Config{
		StripeWebhookSecret: testStripeSecret,
		StripePricePro:      "price_pro_123",
	})

	// Even with a pro price on the item, deletion must force canceled/free.
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
	if len(f.subUpdates) != 1 {
		t.Fatalf("subUpdates = %d, want 1", len(f.subUpdates))
	}
	got := f.subUpdates[0]
	if got.status != "canceled" || got.planTier != "free" {
		t.Errorf("deleted subscription must be canceled/free, got %+v", got)
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
	if len(f.subUpdates) != 0 || len(f.recorded) != 0 {
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
	if len(f.subUpdates) != 0 {
		t.Errorf("already-processed stripe event must not re-run side effects")
	}
}
