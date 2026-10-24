package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// bankCommentDigestInterval is how often stored question-bank comment notices
// are emailed (Epo 2026-10-24, Q243).
const bankCommentDigestInterval = 4 * time.Hour

// runBankCommentDigestWorker sends each recipient one email holding all of its
// unsent bank comment notices, at start and every 4 hours. Temporary until a
// shared pipeline for content notices exists.
func runBankCommentDigestWorker(ctx context.Context, st *store.Store, sender mail.Sender) {
	tick := func() {
		n, err := st.SendBankCommentDigests(ctx, func(ctx context.Context, recipient string, bodies []string) error {
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			_, err := sender.Send(sendCtx, bankCommentDigest(recipient, bodies))
			return err
		})
		if err != nil && ctx.Err() == nil {
			log.Printf("bank comment digest: %v", err)
		}
		if n > 0 {
			log.Printf("sent %d bank comment notice(s)", n)
		}
	}
	tick()
	ticker := time.NewTicker(bankCommentDigestInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			tick()
		case <-ctx.Done():
			return
		}
	}
}

func bankCommentDigest(recipient string, bodies []string) mail.Message {
	subject := "Question bank comment"
	if len(bodies) > 1 {
		subject = fmt.Sprintf("%d question bank comments", len(bodies))
	}
	return mail.Message{To: recipient, Subject: subject, Text: strings.Join(bodies, "\n\n----\n\n")}
}
