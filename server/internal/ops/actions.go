package ops

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminStore owns the single lazily opened pool used for permission-gated
// registry writes and reconciliation requests.
type AdminStore struct {
	pool               *pgxpool.Pool
	dsn                string
	mu                 sync.Mutex
	skipRoleValidation bool
}

func NewLazyAdminStore(dsn string) *AdminStore {
	return &AdminStore{dsn: strings.TrimSpace(dsn)}
}

func NewAdminStore(pool *pgxpool.Pool) *AdminStore {
	return &AdminStore{pool: pool}
}

func (s *AdminStore) SkipRoleValidation() {
	if s != nil {
		s.skipRoleValidation = true
	}
}

func (s *AdminStore) Configured() bool {
	return s != nil && (s.pool != nil || s.dsn != "")
}

func (s *AdminStore) writer(ctx context.Context) (*pgxpool.Pool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pool != nil {
		return s.pool, nil
	}
	if s.dsn == "" {
		return nil, errors.New("ops admin actions are not configured")
	}
	config, err := pgxpool.ParseConfig(s.dsn)
	if err != nil {
		return nil, errors.New("ops admin configuration is invalid")
	}
	config.MaxConns = 2
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open ops admin database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping ops admin database: %w", err)
	}
	if !s.skipRoleValidation {
		if err := ValidateDatabaseRole(ctx, pool, AdminDatabaseRole); err != nil {
			pool.Close()
			return nil, fmt.Errorf("validate ops admin role: %w", err)
		}
	}
	s.pool = pool
	return pool, nil
}

func (s *AdminStore) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pool != nil && s.dsn != "" {
		s.pool.Close()
		s.pool = nil
	}
}

func (s *AdminStore) RequestReconciliation(
	ctx context.Context,
	principal Principal,
	jobType string,
) (ReconciliationRequest, error) {
	var out ReconciliationRequest
	pool, err := s.writer(ctx)
	if err != nil {
		return out, err
	}
	err = pool.QueryRow(
		ctx,
		`SELECT run_id, already_queued, requested_at
		   FROM request_reconciliation($1, $2, $3)`,
		jobType,
		principal.UserID,
		obs.TraceID(ctx),
	).Scan(&out.RunID, &out.AlreadyQueued, &out.RequestedAt)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42501" {
		return out, ErrForbidden
	}
	return out, err
}
