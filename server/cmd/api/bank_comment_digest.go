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

// runBankCommentDigestWorker sends each recipient one email holding its
// unsent bank comment notices (at most store.BankDigestComments, then a count
// and a link to the bank), at start and every 4 hours. Temporary until a
// shared pipeline for content notices exists.
func runBankCommentDigestWorker(ctx context.Context, st *store.Store, sender mail.Sender, appURL string) {
	bankURL := strings.TrimRight(appURL, "/") + "/qb"
	tick := func() {
		n, err := st.SendBankCommentDigests(ctx, func(ctx context.Context, recipient string, bodies []string, more int) error {
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			_, err := sender.Send(sendCtx, bankCommentDigest(recipient, bodies, more, bankURL))
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

func bankCommentDigest(recipient string, bodies []string, more int, bankURL string) mail.Message {
	subject := "Question bank comment"
	if total := len(bodies) + more; total > 1 {
		subject = fmt.Sprintf("%d question bank comments", total)
	}
	text := strings.Join(bodies, "\n\n----\n\n")
	if more > 0 {
		text += fmt.Sprintf("\n\n----\n\nand %d more: %s", more, bankURL)
	}
	return mail.Message{To: recipient, Subject: subject, Text: text}
}
