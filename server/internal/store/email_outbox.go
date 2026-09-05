package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxEmailAttempts  = 6
	defaultEmailBatch = 5
	maxEmailBatch     = 10
)

var ErrEmailLeaseLost = errors.New("email outbox lease lost")
var ErrEmailIdempotencyRequired = errors.New("email outbox idempotency key is required")
var ErrInvalidEmailCategory = errors.New("invalid email notification category")

type EmailOutbox struct {
	ID                string
	UserID            string
	ToEmail           string
	Template          string
	Locale            string
	Payload           json.RawMessage
	IdempotencyKey    string
	Attempts          int
	ProviderMessageID string
	LastError         string
	CreatedAt         time.Time
	LeaseToken        string
	LeaseExpiresAt    time.Time
}

type EmailOutboxParams struct {
	UserID         string
	ToEmail        string
	Template       string
	Locale         string
	Payload        json.RawMessage
	IdempotencyKey string
	Category       string
}

// EnqueueEmailTx writes a product email only when the recipient address is
// nonblank and the recipient has enabled its category. It must be called with
// the same transaction as the domain event.
func EnqueueEmailTx(ctx context.Context, tx pgx.Tx, params EmailOutboxParams) (bool, error) {
	switch params.Category {
	case "workspace_invite", "membership", "billing", "lifecycle":
	default:
		return false, ErrInvalidEmailCategory
	}
	if params.IdempotencyKey == "" {
		return false, ErrEmailIdempotencyRequired
	}
	params.ToEmail = strings.TrimSpace(params.ToEmail)
	if params.ToEmail == "" {
		return false, nil
	}
	enabled, err := notificationEmailEnabled(ctx, tx, params.UserID, params.Category)
	if err != nil {
		return false, err
	}
	if !enabled {
		return false, nil
	}
	payload := params.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if params.Locale == "" {
		params.Locale = "en"
	}

	ct, err := tx.Exec(ctx, `INSERT INTO email_outbox
			(id, user_id, to_email, template, locale, payload, idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		uid("mail"),
		params.UserID,
		params.ToEmail,
		params.Template,
		params.Locale,
		payload,
		nullableString(params.IdempotencyKey),
	)
	return ct.RowsAffected() > 0, err
}

// ClaimEmails atomically moves a small batch of pending rows to sending. Every
// row gets its own lease token so a stale worker cannot complete a later claim.
// Stale rows at the attempt limit are terminally failed and their payloads are
// cleared instead of being requeued forever.
func (s *Store) ClaimEmails(ctx context.Context, limit int) ([]EmailOutbox, error) {
	if limit <= 0 {
		limit = defaultEmailBatch
	}
	if limit > maxEmailBatch {
		limit = maxEmailBatch
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Only pending rows: a 'sending' row still holds a live lease (and, during
	// the provider call, a row lock), and 'failed' is already terminal — both
	// would be rewritten on every tick for no reason.
	if _, err := tx.Exec(ctx, `UPDATE email_outbox
		SET status='failed', payload='{}'::jsonb,
			last_error=COALESCE(last_error, 'email exhausted retry budget'),
			lease_token=NULL, lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE attempts >= $1 AND status='pending'`, maxEmailAttempts); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE email_outbox
		SET status=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
			payload=CASE WHEN attempts >= $1 THEN '{}'::jsonb ELSE payload END,
			last_error=CASE WHEN attempts >= $1
				THEN COALESCE(last_error, 'email lease expired after maximum attempts')
				ELSE last_error END,
			lease_token=NULL, lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE status='sending' AND (
			lease_expires_at IS NULL OR lease_expires_at <= now()
		)`, maxEmailAttempts); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `SELECT id
		FROM email_outbox
		WHERE status='pending' AND next_attempt_at<=now()
		ORDER BY created_at
		FOR UPDATE SKIP LOCKED
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}

	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	out := make([]EmailOutbox, 0, len(ids))
	for _, id := range ids {
		leaseToken := uid("lease")
		var item EmailOutbox
		if err := tx.QueryRow(ctx, `UPDATE email_outbox
			SET status='sending', attempts=attempts+1,
				lease_token=$2, lease_expires_at=now()+interval '2 minutes',
				updated_at=now()
			WHERE id=$1 AND status='pending'
			RETURNING id, COALESCE(user_id,''), to_email, template, locale,
				payload, COALESCE(idempotency_key,''), attempts,
				COALESCE(provider_message_id,''), COALESCE(last_error,''),
				created_at, lease_token, lease_expires_at`,
			id, leaseToken).Scan(
			&item.ID,
			&item.UserID,
			&item.ToEmail,
			&item.Template,
			&item.Locale,
			&item.Payload,
			&item.IdempotencyKey,
			&item.Attempts,
			&item.ProviderMessageID,
			&item.LastError,
			&item.CreatedAt,
			&item.LeaseToken,
			&item.LeaseExpiresAt,
		); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

type EmailSendGuard struct {
	tx   pgx.Tx
	item EmailOutbox
	done bool
}

// BeginEmailSend locks the claimed outbox row while the caller performs the
// final business-validity check and provider request. Mutations that cancel
// the row therefore serialize before or after the send, rather than racing it.
func (s *Store) BeginEmailSend(ctx context.Context, item EmailOutbox) (*EmailSendGuard, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	guard := &EmailSendGuard{tx: tx, item: item}
	var id string
	if err := tx.QueryRow(ctx, `SELECT id
		FROM email_outbox
		WHERE id=$1 AND status='sending' AND lease_token=$2
			AND lease_expires_at>now()
		FOR UPDATE`, item.ID, item.LeaseToken).Scan(&id); err != nil {
		_ = tx.Rollback(context.Background())
		if isNoRows(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	active, err := emailClaimActive(ctx, tx, item)
	if err != nil {
		_ = tx.Rollback(context.Background())
		return nil, false, err
	}
	if !active {
		_ = tx.Rollback(context.Background())
		return nil, false, nil
	}
	return guard, true, nil
}

func (g *EmailSendGuard) Rollback() {
	if g == nil || g.done {
		return
	}
	g.done = true
	_ = g.tx.Rollback(context.Background())
}

func (g *EmailSendGuard) Cancel(ctx context.Context) error {
	if g == nil || g.done {
		return ErrEmailLeaseLost
	}
	defer func() { g.done = true }()
	tag, err := g.tx.Exec(ctx, `UPDATE email_outbox SET
			status='failed', payload='{}'::jsonb,
			last_error='email cancelled before send',
			lease_token=NULL, lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$2`,
		g.item.ID, g.item.LeaseToken)
	if err != nil {
		_ = g.tx.Rollback(context.Background())
		return err
	}
	if tag.RowsAffected() == 0 {
		_ = g.tx.Rollback(context.Background())
		return ErrEmailLeaseLost
	}
	return g.tx.Commit(ctx)
}

func (g *EmailSendGuard) MarkSent(ctx context.Context, providerMessageID string) error {
	if g == nil || g.done {
		return ErrEmailLeaseLost
	}
	defer func() { g.done = true }()
	tag, err := g.tx.Exec(ctx, `UPDATE email_outbox SET
			status='sent', payload='{}'::jsonb, provider_message_id=$2,
			last_error=NULL, sent_at=now(), lease_token=NULL,
			lease_expires_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$3`,
		g.item.ID, nullableString(providerMessageID), g.item.LeaseToken)
	if err != nil {
		_ = g.tx.Rollback(context.Background())
		return err
	}
	if tag.RowsAffected() == 0 {
		_ = g.tx.Rollback(context.Background())
		return ErrEmailLeaseLost
	}
	return g.tx.Commit(ctx)
}

func (g *EmailSendGuard) MarkFailed(
	ctx context.Context,
	sendErr error,
	retryAfter ...time.Duration,
) error {
	if g == nil || g.done {
		return ErrEmailLeaseLost
	}
	status, nextAttempt, lastError := emailFailureValues(g.item, sendErr, retryAfter...)
	defer func() { g.done = true }()
	tag, err := g.tx.Exec(ctx, `UPDATE email_outbox SET
			status=$2,
			payload=CASE WHEN $2='failed' THEN '{}'::jsonb ELSE payload END,
			next_attempt_at=$3, last_error=$4, lease_token=NULL,
			lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$5`,
		g.item.ID, status, nextAttempt, nullableString(lastError), g.item.LeaseToken)
	if err != nil {
		_ = g.tx.Rollback(context.Background())
		return err
	}
	if tag.RowsAffected() == 0 {
		_ = g.tx.Rollback(context.Background())
		return ErrEmailLeaseLost
	}
	return g.tx.Commit(ctx)
}

func (s *Store) EmailClaimActive(ctx context.Context, item EmailOutbox) (bool, error) {
	return emailClaimActive(ctx, s.pool, item)
}

func emailClaimActive(ctx context.Context, q rowQueryer, item EmailOutbox) (bool, error) {
	var active bool
	err := q.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1
		FROM email_outbox o
		WHERE o.id=$1 AND o.status='sending' AND o.lease_token=$2
			AND o.lease_expires_at > now()
			AND (
				o.template <> 'workspace-role-changed'
				OR EXISTS (
					SELECT 1 FROM workspace_members wm
					WHERE wm.workspace_id=o.payload->>'workspaceId'
						AND wm.user_id=o.user_id
						AND wm.role::text=o.payload->>'role'
						AND wm.updated_at=NULLIF(o.payload->>'updatedAt', '')::timestamptz
				)
			)
			AND (
				o.template <> 'workspace-member-removed'
				OR NOT EXISTS (
					SELECT 1 FROM workspace_members wm
					WHERE wm.workspace_id=o.payload->>'workspaceId'
						AND wm.user_id=o.user_id
				)
			)
	)`, item.ID, item.LeaseToken).Scan(&active)
	return active, err
}

func (s *Store) CancelEmailClaim(ctx context.Context, item EmailOutbox) error {
	_, err := s.pool.Exec(ctx, `UPDATE email_outbox SET
			status='failed', payload='{}'::jsonb,
			last_error='email cancelled before send',
			lease_token=NULL, lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$2`,
		item.ID, item.LeaseToken)
	return err
}

func (s *Store) MarkEmailSent(ctx context.Context, item EmailOutbox, providerMessageID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE email_outbox SET
			status='sent', payload='{}'::jsonb, provider_message_id=$2,
			last_error=NULL, sent_at=now(), lease_token=NULL,
			lease_expires_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$3`,
		item.ID, nullableString(providerMessageID), item.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrEmailLeaseLost
	}
	return nil
}

func (s *Store) MarkEmailFailed(
	ctx context.Context,
	item EmailOutbox,
	sendErr error,
	retryAfter ...time.Duration,
) error {
	status, nextAttempt, lastError := emailFailureValues(item, sendErr, retryAfter...)
	tag, err := s.pool.Exec(ctx, `UPDATE email_outbox SET
			status=$2,
			payload=CASE WHEN $2='failed' THEN '{}'::jsonb ELSE payload END,
			next_attempt_at=$3, last_error=$4, lease_token=NULL,
			lease_expires_at=NULL, sent_at=NULL, updated_at=now()
		WHERE id=$1 AND status='sending' AND lease_token=$5`,
		item.ID, status, nextAttempt, nullableString(lastError), item.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrEmailLeaseLost
	}
	return nil
}

func emailFailureValues(
	item EmailOutbox,
	sendErr error,
	retryAfter ...time.Duration,
) (string, time.Time, string) {
	status := "pending"
	nextAttempt := time.Now().UTC()
	if item.Attempts >= maxEmailAttempts {
		status = "failed"
	} else {
		delay := 30 * time.Second
		for attempt := 1; attempt < item.Attempts; attempt++ {
			delay *= 2
			if delay >= time.Hour {
				delay = time.Hour
				break
			}
		}
		nextAttempt = nextAttempt.Add(delay)
	}
	if len(retryAfter) > 0 && retryAfter[0] > 0 {
		providerRetryAt := time.Now().UTC().Add(retryAfter[0])
		if providerRetryAt.After(nextAttempt) {
			nextAttempt = providerRetryAt
		}
	}

	lastError := ""
	if sendErr != nil {
		lastError = sendErr.Error()
	}
	return status, nextAttempt, lastError
}

// ReleaseEmailClaims returns claims that were not processed before shutdown
// to the queue without touching a newer claim for the same row. The claim
// incremented attempts without ever reaching the provider, so give the attempt
// back — otherwise a few restarts alone can exhaust the retry budget.
func (s *Store) ReleaseEmailClaims(ctx context.Context, items []EmailOutbox) error {
	for _, item := range items {
		if _, err := s.pool.Exec(ctx, `UPDATE email_outbox SET
				status='pending', attempts=GREATEST(attempts-1, 0),
				lease_token=NULL, lease_expires_at=NULL, sent_at=NULL,
				next_attempt_at=LEAST(next_attempt_at, now()), updated_at=now()
			WHERE id=$1 AND status='sending' AND lease_token=$2`,
			item.ID, item.LeaseToken); err != nil {
			return err
		}
	}
	return nil
}
