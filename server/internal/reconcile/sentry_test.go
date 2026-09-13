package reconcile

import (
	"context"
	"github.com/getsentry/sentry-go"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
	"testing"
	"time"
)

func TestSentryReconciliationReportedOnce(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &sentryTestTransport{}
	err = sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = st.EnqueueScheduledReconciliation(ctx, store.ReconcileJobStripe, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(st, Config{})
	err = runner.Drain(ctx)
	if err == nil {
		t.Fatal("expected missing config failure")
	}
	if len(transport.events) != 1 {
		t.Fatalf("runner events=%d", len(transport.events))
	}
	obs.CaptureErr(ctx, err, map[string]string{"stage": "reconciliation_run"})
	if len(transport.events) != 1 {
		t.Fatalf("outer worker duplicated event: %d", len(transport.events))
	}
}

type sentryTestTransport struct{ events []*sentry.Event }

func (t *sentryTestTransport) Configure(sentry.ClientOptions)        {}
func (t *sentryTestTransport) SendEvent(e *sentry.Event)             { t.events = append(t.events, e) }
func (t *sentryTestTransport) Flush(time.Duration) bool              { return true }
func (t *sentryTestTransport) FlushWithContext(context.Context) bool { return true }
func (t *sentryTestTransport) Close()                                {}
