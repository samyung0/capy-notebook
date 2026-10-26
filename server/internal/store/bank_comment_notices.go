package store

import (
	"context"
	"errors"
)

// Question-bank comments are stored as notices and sent as one email per
// recipient every 4 hours (Epo 2026-10-24, Q243). This is temporary until a
// shared pipeline for content notices (reports, feedback, forums) exists.

// AddBankCommentNotice stores one rendered comment for the next digest.
func (s *Store) AddBankCommentNotice(ctx context.Context, userID, recipient, body string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO bank_comment_notices (id, user_id, recipient, body)
		VALUES ($1, $2, $3, $4)`, uid("bcn"), userID, recipient, body)
	return err
}

// BankDigestComments is the most comments one digest email lists; the rest
// are counted as "and N more" (Epo 2026-10-24, Q314).
const BankDigestComments = 200

// SendBankCommentDigests calls send once per recipient with its oldest
// BankDigestComments unsent notices and the count of the rest, and marks all
// of them sent when the send succeeds. A failed send leaves its notices for
// the next run.
//
// The notices stay row-locked until the commit and a concurrent run skips
// locked rows, so two API replicas never send one notice twice; a notice goes
// out again only if the commit fails after its email was sent. A notice whose
// author has requested account deletion is held, and the purge deletes it.
func (s *Store) SendBankCommentDigests(
	ctx context.Context,
	send func(ctx context.Context, recipient string, bodies []string, more int) error,
) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT n.id, n.recipient, n.body
		FROM bank_comment_notices n
		JOIN users u ON u.id = n.user_id
		WHERE n.sent_at IS NULL AND u.deletion_requested_at IS NULL
		ORDER BY n.created_at, n.id
		FOR UPDATE OF n SKIP LOCKED`)
	if err != nil {
		return 0, err
	}
	var recipients []string
	ids := map[string][]string{}
	bodies := map[string][]string{}
	for rows.Next() {
		var id, recipient, body string
		if err := rows.Scan(&id, &recipient, &body); err != nil {
			rows.Close()
			return 0, err
		}
		if ids[recipient] == nil {
			recipients = append(recipients, recipient)
		}
		ids[recipient] = append(ids[recipient], id)
		bodies[recipient] = append(bodies[recipient], body)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	sent := 0
	var sendErrs []error
	for _, recipient := range recipients {
		listed := bodies[recipient][:min(len(bodies[recipient]), BankDigestComments)]
		if err := send(ctx, recipient, listed, len(bodies[recipient])-len(listed)); err != nil {
			sendErrs = append(sendErrs, err)
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE bank_comment_notices SET sent_at = now() WHERE id = ANY($1)`,
			ids[recipient]); err != nil {
			return 0, err
		}
		sent += len(ids[recipient])
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return sent, errors.Join(sendErrs...)
}

// PruneBankCommentNotices deletes notices 30 days after their digest email
// was sent (Epo 2026-10-24, Q302). Unsent notices stay for the next digest.
func (s *Store) PruneBankCommentNotices(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM bank_comment_notices
		WHERE sent_at < now() - interval '30 days'`)
	return err
}
