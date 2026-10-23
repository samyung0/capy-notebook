package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/alibaba"
	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The words the fake provider "hears": no log line may carry them.
const voiceSecretText = "mitochondria photosynthesis zebrafish"

type voiceFixture struct {
	handler     http.Handler
	pool        *pgxpool.Pool
	memberID    string
	outsiderID  string
	workspaceID string
	calls       *atomic.Int32
	// held is the member's reserved credits while the provider answered.
	held *atomic.Int64
	// sent is the last request body the provider received.
	sent *map[string]any
	// answer, when set, answers the provider's requests in place of the
	// fixture's status and body.
	answer *func(w http.ResponseWriter, r *http.Request)
}

// openVoice is a workspace with one source and a member, an outsider, and a
// fake Model Studio answering with status and body. A nil provider leaves
// voice input unconfigured.
func openVoice(t *testing.T, status int, body string, configured bool) voiceFixture {
	t.Helper()
	dsn := testdb.URL(t)
	ctx := context.Background()
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
	stamp := time.Now().UnixNano()
	memberID, outsiderID := fmt.Sprintf("u_voice_%d", stamp), fmt.Sprintf("u_voice_out_%d", stamp)
	for _, id := range []string{memberID, outsiderID} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
			VALUES ($1, 'Voice Test', $2, 'free')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1 OR id=$2`, memberID, outsiderID)
	})
	ws, err := st.CreateWorkspace(ctx, memberID, store.WorkspaceCreate{Name: "Cell Biology"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, name, kind, size_bytes, status)
		VALUES ($1, $2, $3, 'Krebs cycle.pdf', 'pdf', 1, 'ready')`, "f_voice_"+fmt.Sprint(stamp), ws.ID, memberID); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	var held atomic.Int64
	var sent map[string]any
	var answer func(w http.ResponseWriter, r *http.Request)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var reserved int64
		_ = pool.QueryRow(r.Context(), `SELECT reserved_micros FROM user_credits WHERE user_id = $1`, memberID).Scan(&reserved)
		held.Store(reserved)
		_ = json.NewDecoder(r.Body).Decode(&sent)
		if answer != nil {
			answer(w, r)
			return
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	cfg := httpapi.Config{
		E2EAuth:    true,
		E2ESecret:  "e2e-test-secret",
		E2EUserIDs: []string{memberID, outsiderID},
	}
	if configured {
		if cfg.Voice, err = alibaba.New("sk-voice-test", srv.URL+"/compatible-mode/v1"); err != nil {
			t.Fatal(err)
		}
	}
	return voiceFixture{
		handler: httpapi.New(st, blob.NewMemory(), nil, nil, "docling", cfg),
		pool:    pool, memberID: memberID, outsiderID: outsiderID, workspaceID: ws.ID,
		calls: &calls, held: &held, sent: &sent, answer: &answer,
	}
}

func (fx voiceFixture) post(t *testing.T, userID, contentType string, clip []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+fx.workspaceID+"/voice-transcriptions", bytes.NewReader(clip))
	req.Header.Set("Content-Type", contentType)
	if userID != "" {
		req.Header.Set(auth.HeaderE2EUserID, userID)
		req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	}
	rec := httptest.NewRecorder()
	fx.handler.ServeHTTP(rec, req)
	return rec
}

// ledger is the member's voice usage: events, their credits, provider calls
// by status, and the credits still held.
type voiceLedger struct {
	events, credits, units int64
	unit                   string
	applied, abandoned     int64
	reserved, used         int64
}

func (fx voiceFixture) ledger(t *testing.T) voiceLedger {
	t.Helper()
	ctx := context.Background()
	var l voiceLedger
	if err := fx.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(credit_micros), 0), COALESCE(sum(units), 0), COALESCE(max(unit), '')
		  FROM usage_events WHERE actor_user_id = $1 AND kind = 'audio'`, fx.memberID,
	).Scan(&l.events, &l.credits, &l.units, &l.unit); err != nil {
		t.Fatal(err)
	}
	if err := fx.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'applied'), count(*) FILTER (WHERE status = 'abandoned')
		  FROM provider_calls WHERE actor_user_id = $1 AND kind = 'audio'`, fx.memberID,
	).Scan(&l.applied, &l.abandoned); err != nil {
		t.Fatal(err)
	}
	if err := fx.pool.QueryRow(ctx, `
		SELECT COALESCE(max(reserved_micros), 0), COALESCE(max(used_micros), 0)
		  FROM user_credits WHERE user_id = $1`, fx.memberID,
	).Scan(&l.reserved, &l.used); err != nil {
		t.Fatal(err)
	}
	return l
}

// captureLogs sends every log line of the test to a buffer.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func voiceCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Errors) == 0 {
		return ""
	}
	return body.Errors[0].Message
}

const heard = `{"sentence":{"text":"  ` + voiceSecretText + ` ","begin_time":0,"end_time":2400},"usage":{"input_tokens":90,"output_tokens":6}}`

// A clip comes back as text, charged once for the seconds heard (2.4 s → 3 s
// at voice_input_second); the two-minute maximum is held during the call and
// released after it; the provider got
// the workspace's title and sources as context; nothing logged the text, the
// audio or the key.
func TestVoiceTranscriptionChargesHeardSecondsOnce(t *testing.T) {
	logs := captureLogs(t)
	fx := openVoice(t, http.StatusOK, heard, true)
	rec := fx.post(t, fx.memberID, "audio/webm;codecs=opus", []byte("OPUS-CLIP-BYTES"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out struct{ Text string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Text != voiceSecretText {
		t.Fatalf("text %q (%v)", out.Text, err)
	}
	if held := fx.held.Load(); held != 120*16_667 {
		t.Fatalf("held %d during the call, want the two-minute maximum", held)
	}
	if got := fx.ledger(t); got != (voiceLedger{events: 1, credits: 3 * 16_667, units: 3, unit: "seconds",
		applied: 1, used: 3 * 16_667}) {
		t.Fatalf("ledger %+v", got)
	}
	sent, _ := json.Marshal(*fx.sent)
	if !strings.Contains(string(sent), `Workspace: Cell Biology\nSources: Krebs cycle.pdf`) ||
		!strings.Contains(string(sent), `"format":"webm"`) || !strings.Contains(string(sent), "data:audio/webm;base64,") {
		t.Fatalf("provider request %s", sent)
	}
	for _, secret := range []string{"mitochondria", "OPUS-CLIP-BYTES", "T1BVUy1DTElQ", "sk-voice-test"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("logs carry %q:\n%s", secret, logs.String())
		}
	}
}

// Throttling answers 429 transcription_busy and charges nothing: the call is
// abandoned with the provider's status and the hold released. Nothing retries.
func TestVoiceTranscriptionProviderBusyChargesNothing(t *testing.T) {
	fx := openVoice(t, http.StatusTooManyRequests, `{"code":"Throttling.RateQuota","message":"`+voiceSecretText+`"}`, true)
	rec := fx.post(t, fx.memberID, "audio/mp4", []byte("aac"))
	if rec.Code != http.StatusTooManyRequests || voiceCode(t, rec) != "transcription_busy" ||
		strings.Contains(rec.Body.String(), "mitochondria") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if fx.calls.Load() != 1 {
		t.Fatalf("provider called %d times", fx.calls.Load())
	}
	if got := fx.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("ledger %+v", got)
	}
	var providerStatus int
	if err := fx.pool.QueryRow(context.Background(), `SELECT provider_status FROM provider_calls
		WHERE actor_user_id = $1`, fx.memberID).Scan(&providerStatus); err != nil || providerStatus != 429 {
		t.Fatalf("provider status %d (%v)", providerStatus, err)
	}
}

// Another provider failure is a 502 transcription_failed, uncharged.
func TestVoiceTranscriptionProviderFailureIsBadGateway(t *testing.T) {
	fx := openVoice(t, http.StatusInternalServerError, `{"code":"InternalError"}`, true)
	rec := fx.post(t, fx.memberID, "audio/ogg", []byte("ogg"))
	if rec.Code != http.StatusBadGateway || voiceCode(t, rec) != "transcription_failed" {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := fx.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("ledger %+v", got)
	}
}

// The server's two-minute check: a clip the provider heard past 125 s is
// refused with no text and no charge, and so is one with no speech; one
// inside the margin is charged at most the two minutes held.
func TestVoiceTranscriptionRefusesOverTwoMinutesAndSilence(t *testing.T) {
	long := openVoice(t, http.StatusOK, `{"sentence":{"text":"`+voiceSecretText+`","begin_time":0,"end_time":125001}}`, true)
	rec := long.post(t, long.memberID, "audio/webm", []byte("long"))
	if rec.Code != http.StatusUnprocessableEntity || voiceCode(t, rec) != "voice_too_long" ||
		strings.Contains(rec.Body.String(), "mitochondria") {
		t.Fatalf("over the cap: %d %s", rec.Code, rec.Body.String())
	}
	if got := long.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("over the cap ledger %+v", got)
	}
	// Inside the recorder's stop margin: answered, charged the 120 s held.
	margin := openVoice(t, http.StatusOK, `{"sentence":{"text":"`+voiceSecretText+`","begin_time":0,"end_time":124500}}`, true)
	if rec := margin.post(t, margin.memberID, "audio/webm", []byte("margin")); rec.Code != http.StatusOK {
		t.Fatalf("margin: %d %s", rec.Code, rec.Body.String())
	}
	if got := margin.ledger(t); got != (voiceLedger{events: 1, credits: 120 * 16_667, units: 120, unit: "seconds",
		applied: 1, used: 120 * 16_667}) {
		t.Fatalf("margin ledger %+v", got)
	}
	silent := openVoice(t, http.StatusOK, `{"sentence":{"text":"  ","begin_time":0,"end_time":4000}}`, true)
	if rec := silent.post(t, silent.memberID, "audio/webm", []byte("quiet")); rec.Code != http.StatusUnprocessableEntity ||
		voiceCode(t, rec) != "voice_no_speech" {
		t.Fatalf("silence: %d %s", rec.Code, rec.Body.String())
	}
	if got := silent.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("silence ledger %+v", got)
	}
}

// Refusals before the provider: no session (401), not a member (404), a type
// outside the allowlist (415), a body past 2 MiB (413, read no further), and
// no configuration (503 voice_unavailable). None calls the provider or holds
// credits.
func TestVoiceTranscriptionRefusesBeforeTheProvider(t *testing.T) {
	fx := openVoice(t, http.StatusOK, heard, true)
	cases := []struct {
		name, user, contentType string
		clip                    []byte
		status                  int
	}{
		{"anonymous", "", "audio/webm", []byte("a"), http.StatusUnauthorized},
		{"outsider", fx.outsiderID, "audio/webm", []byte("a"), http.StatusNotFound},
		{"wav", fx.memberID, "audio/wav", []byte("a"), http.StatusUnsupportedMediaType},
		{"json", fx.memberID, "application/json", []byte(`{}`), http.StatusUnsupportedMediaType},
		{"too large", fx.memberID, "audio/webm", make([]byte, 2<<20), http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		if rec := fx.post(t, tc.user, tc.contentType, tc.clip); rec.Code != tc.status {
			t.Errorf("%s: status %d, want %d: %s", tc.name, rec.Code, tc.status, rec.Body.String())
		}
	}
	unconfigured := openVoice(t, http.StatusOK, heard, false)
	if rec := unconfigured.post(t, unconfigured.memberID, "audio/webm", []byte("a")); rec.Code != http.StatusServiceUnavailable ||
		voiceCode(t, rec) != "voice_unavailable" {
		t.Errorf("unconfigured: %d %s", rec.Code, rec.Body.String())
	}
	if fx.calls.Load() != 0 || unconfigured.calls.Load() != 0 {
		t.Fatalf("provider called %d/%d times", fx.calls.Load(), unconfigured.calls.Load())
	}
	if got := fx.ledger(t); got != (voiceLedger{}) {
		t.Fatalf("ledger %+v", got)
	}
}

// A caller that goes away while the provider works is charged nothing: the
// call is abandoned as cancelled and the hold released.
func TestVoiceTranscriptionCallerGoneChargesNothing(t *testing.T) {
	fx := openVoice(t, http.StatusOK, heard, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	*fx.answer = func(_ http.ResponseWriter, r *http.Request) {
		cancel()
		// The gateway drops the provider request once its caller is gone.
		<-r.Context().Done()
	}
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/voice-transcriptions", bytes.NewReader([]byte("clip")))
	req.Header.Set("Content-Type", "audio/webm")
	req.Header.Set(auth.HeaderE2EUserID, fx.memberID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	fx.handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "mitochondria") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := fx.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("ledger %+v", got)
	}
	var category, code string
	if err := fx.pool.QueryRow(context.Background(), `SELECT error_category, error_code FROM provider_calls
		WHERE actor_user_id = $1`, fx.memberID).Scan(&category, &code); err != nil || category != "request" || code != "cancelled" {
		t.Fatalf("abandoned as %s/%s (%v)", category, code, err)
	}
}

// A receipt refused after the session closed (here the call's window ran out
// while the provider answered) still answers the clip: the hold is freed,
// nothing is charged, and the call ends uncharged.
func TestVoiceTranscriptionRefusedReceiptStillAnswers(t *testing.T) {
	fx := openVoice(t, http.StatusOK, heard, true)
	*fx.answer = func(w http.ResponseWriter, r *http.Request) {
		if _, err := fx.pool.Exec(r.Context(), `UPDATE provider_calls
			SET opened_at = now() - interval '3 minutes',
			    receipt_deadline_at = now() - interval '1 second'
			WHERE actor_user_id = $1 AND status = 'open'`, fx.memberID); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, heard)
	}
	rec := fx.post(t, fx.memberID, "audio/webm", []byte("clip"))
	var out struct{ Text string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); rec.Code != http.StatusOK || err != nil || out.Text != voiceSecretText {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := fx.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("ledger %+v", got)
	}
}

// Text with no end cannot be capped or charged: a 502, uncharged.
func TestVoiceTranscriptionWithoutAnEndIsBadGateway(t *testing.T) {
	fx := openVoice(t, http.StatusOK, `{"sentence":{"text":"`+voiceSecretText+`"}}`, true)
	rec := fx.post(t, fx.memberID, "audio/webm", []byte("clip"))
	if rec.Code != http.StatusBadGateway || voiceCode(t, rec) != "transcription_failed" ||
		strings.Contains(rec.Body.String(), "mitochondria") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := fx.ledger(t); got != (voiceLedger{abandoned: 1}) {
		t.Fatalf("ledger %+v", got)
	}
}
