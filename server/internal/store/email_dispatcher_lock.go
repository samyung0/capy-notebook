package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

const emailDispatcherAdvisoryKey int64 = 0x65766f6d61696c

// EmailDispatcherLock owns a dedicated database session because PostgreSQL
// advisory locks are session-scoped. Releasing the pooled connection without
// unlocking it would leak leadership to whichever request reuses that session.
type EmailDispatcherLock struct {
	conn *pgxpool.Conn
}

func (s *Store) TryAcquireEmailDispatcherLock(ctx context.Context) (*EmailDispatcherLock, bool, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var acquired bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, emailDispatcherAdvisoryKey).
		Scan(&acquired); err != nil {
		conn.Release()
		return nil, false, err
	}
	if !acquired {
		conn.Release()
		return nil, false, nil
	}
	return &EmailDispatcherLock{conn: conn}, true, nil
}

func (l *EmailDispatcherLock) Release(ctx context.Context) error {
	if l == nil || l.conn == nil {
		return nil
	}
	defer func() {
		l.conn.Release()
		l.conn = nil
	}()
	var unlocked bool
	if err := l.conn.QueryRow(ctx, `SELECT pg_advisory_unlock($1)`, emailDispatcherAdvisoryKey).
		Scan(&unlocked); err != nil {
		return err
	}
	if !unlocked {
		return ErrEmailLeaseLost
	}
	return nil
}

func (l *EmailDispatcherLock) Alive(ctx context.Context) error {
	if l == nil || l.conn == nil {
		return ErrEmailLeaseLost
	}
	var one int
	if err := l.conn.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
		return err
	}
	return nil
}
