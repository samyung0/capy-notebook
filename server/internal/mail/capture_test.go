package mail

import (
	"context"
	"errors"
	"strconv"
	"testing"
)

type stubSender struct {
	err error
}

func (s stubSender) Send(context.Context, Message) (string, error) {
	return "stub", s.err
}

func TestRecordingSenderKeepsBoundedHistoryOfDeliveredMail(t *testing.T) {
	recorder := NewRecordingSender(stubSender{})
	ctx := context.Background()
	for i := 0; i < captureLimit+5; i++ {
		if _, err := recorder.Send(ctx, Message{Subject: strconv.Itoa(i)}); err != nil {
			t.Fatal(err)
		}
	}
	captured := recorder.Captured()
	if len(captured) != captureLimit {
		t.Fatalf("captured %d message(s), want %d", len(captured), captureLimit)
	}
	if captured[len(captured)-1].Subject != strconv.Itoa(captureLimit+4) {
		t.Fatalf("last captured subject = %q", captured[len(captured)-1].Subject)
	}
}

func TestRecordingSenderIgnoresFailedDeliveries(t *testing.T) {
	recorder := NewRecordingSender(stubSender{err: errors.New("boom")})
	if _, err := recorder.Send(context.Background(), Message{Subject: "x"}); err == nil {
		t.Fatal("expected the underlying failure to surface")
	}
	if len(recorder.Captured()) != 0 {
		t.Fatal("a failed send was recorded as delivered")
	}
}
