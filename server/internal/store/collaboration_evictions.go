package store

import (
	"context"
	"time"
)

// CollaborationEviction is one leased, durable Redis publication. ID is also
// embedded in Payload and remains stable when delivery is retried.
type CollaborationEviction struct {
	ID       string
	Channel  string
	Payload  string
	LeaseID  string
	Attempts int
}

func (s *Store) ClaimCollaborationEvictions(
	ctx context.Context,
	limit int,
	lease time.Duration,
) ([]CollaborationEviction, error) {
	if limit <= 0 {
		return []CollaborationEviction{}, nil
	}
	leaseID := uid("cevl")
	rows, err := s.pool.Query(ctx, `WITH due AS (
		SELECT id FROM collaboration_eviction_outbox
		WHERE available_at <= now()
		  AND (lease_id IS NULL OR lease_expires_at <= now())
		ORDER BY available_at, created_at
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	)
	UPDATE collaboration_eviction_outbox e
	SET lease_id=$2,
		lease_expires_at=now()+make_interval(secs => $3),
		attempts=e.attempts+1
	FROM due
	WHERE e.id=due.id
	RETURNING e.id, e.channel, e.payload::text, e.lease_id, e.attempts`,
		limit, leaseID, max(1, int(lease/time.Second)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CollaborationEviction, 0, limit)
	for rows.Next() {
		var item CollaborationEviction
		if err := rows.Scan(
			&item.ID, &item.Channel, &item.Payload, &item.LeaseID, &item.Attempts,
		); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) CompleteCollaborationEviction(
	ctx context.Context,
	id, leaseID string,
) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox
		WHERE id=$1 AND lease_id=$2`, id, leaseID)
	return err
}

func (s *Store) RetryCollaborationEviction(
	ctx context.Context,
	id, leaseID, message string,
	delay time.Duration,
) error {
	_, err := s.pool.Exec(ctx, `UPDATE collaboration_eviction_outbox
		SET lease_id=NULL, lease_expires_at=NULL,
			available_at=now()+make_interval(secs => $3), last_error=$4
		WHERE id=$1 AND lease_id=$2`,
		id, leaseID, max(1, int(delay/time.Second)), message)
	return err
}
