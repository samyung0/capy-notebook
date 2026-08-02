package mail

import (
	"context"
	"log"
	"strconv"
	"sync/atomic"
)

type LogSender struct {
	sequence atomic.Uint64
}

func (s *LogSender) Send(_ context.Context, message Message) (string, error) {
	id := s.sequence.Add(1)
	// The log backend is development/e2e-only; include plain text so local
	// workflows can follow invite links without exposing bulky HTML markup.
	log.Printf("email backend=log id=log-%d to=%s subject=%q text=%q", id, message.To, message.Subject, message.Text)
	return "log-" + strconv.FormatUint(id, 10), nil
}
