package mail

import (
	"context"
	"sync"
)

const captureLimit = 50

// Recorder exposes messages captured by a RecordingSender. Tests read delivered
// mail through this instead of parsing the API process' stdout, which is
// unreliable across docker compose log drivers, buffering, and CI runners.
type Recorder interface {
	Captured() []Message
}

// RecordingSender delegates to another sender and keeps the most recent
// messages in memory. It is wired only under APP_ENV=e2e.
type RecordingSender struct {
	inner Sender

	mu       sync.Mutex
	messages []Message
}

func NewRecordingSender(inner Sender) *RecordingSender {
	return &RecordingSender{inner: inner}
}

func (s *RecordingSender) Send(ctx context.Context, message Message) (string, error) {
	id, err := s.inner.Send(ctx, message)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, message)
	if len(s.messages) > captureLimit {
		s.messages = s.messages[len(s.messages)-captureLimit:]
	}
	return id, nil
}

func (s *RecordingSender) Captured() []Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Message, len(s.messages))
	copy(out, s.messages)
	return out
}
