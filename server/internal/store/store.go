package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/planlimits"
)

// ErrNotFound is returned by Get-style methods when a row is absent.
// rowQueryer is satisfied by both *pgxpool.Pool and pgx.Tx, so single-row
// helpers can run either standalone or inside a caller's transaction.
type rowQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

var ErrNotFound = errors.New("not found")

// ErrModelUnavailable means the request named a model that cannot be priced or
// run: empty preference, unknown/disabled key, or a pin whose config row is
// gone. Callers must fail the request rather than substituting Flash.
var ErrModelUnavailable = errors.New("model unavailable")

// ErrModelRefRequired is a Settings write that tried to clear a preference.
var ErrModelRefRequired = errors.New("model reference required")

// ErrInvalidLLMKey means a BYOK credential was rejected by the provider.
var ErrInvalidLLMKey = errors.New("invalid llm credential")

// ErrLLMCredentialsUnavailable means the gateway has no LLM_CREDENTIALS_KEY,
// so it cannot store or read user-supplied provider keys.
var ErrLLMCredentialsUnavailable = errors.New("llm credentials unavailable")

// ErrLLMKeyFailed means a BYOK call failed without a clear 401/403.
var ErrLLMKeyFailed = errors.New("llm credential failed")

// ErrConflict reports a failed optimistic revision comparison.
var ErrConflict = errors.New("revision conflict")

// ErrAccountLifecycleChanged means an account-deletion confirmation was based
// on a preflight taken before support restored the account.
var ErrAccountLifecycleChanged = errors.New("account lifecycle changed")

// ErrForbidden reports authenticated access without the required workspace
// role. Shared-resource probing still uses ErrNotFound.
var ErrForbidden = errors.New("forbidden")

// ErrTitleTaken means another material in the same workspace already uses that
// title (case-insensitive, trimmed). Standalone materials are not in this set.
var ErrTitleTaken = errors.New("material title already used in this workspace")

// ErrMaterialIDTaken means INSERT hit materials_pkey. The caller looks up
// the row and either returns the original or reports ErrMaterialConflict.
var ErrMaterialIDTaken = errors.New("material id already exists")

// ErrMaterialConflict means the same material id was reused with a different
// workspace, actor, kind, or payload.
var ErrMaterialConflict = errors.New("material id already used with a different payload")

// ErrAuthorityUnavailable means an initialized Y.Doc could not be mutated
// through the collaboration authority. Callers must fail closed with 503.
var ErrAuthorityUnavailable = errors.New("collaboration authority unavailable")

type Store struct {
	pool                *pgxpool.Pool
	registry            *models.Registry
	collaborationURL    string
	collaborationSecret string
	collaborationHTTP   *http.Client
	credKey             []byte
	planLimits          planlimits.Catalog
	planLimitsMu        sync.Mutex
}

// SetLLMCredentialKey installs the AES-256-GCM key used for user provider
// secrets. Empty leaves BYOK write/read disabled.
func (s *Store) SetLLMCredentialKey(key []byte) { s.credKey = key }

// Pool exposes the connection pool so the model registry can share it.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// SetModelRegistry attaches the process-wide registry so account creation
// can snapshot slot defaults onto the user row, chat/generate can resolve
// the preference per request, and ingest enqueue can pin embedding/vision.
func (s *Store) SetModelRegistry(r *models.Registry) { s.registry = r }

func (s *Store) ModelRegistry() *models.Registry { return s.registry }

// Open connects to Postgres without reading application tables. Migration and
// test-database commands use it before the schema necessarily exists.
func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{
		pool:              pool,
		collaborationHTTP: &http.Client{Timeout: 20 * time.Second},
	}, nil
}

// New opens a serving store and loads the complete plan catalog. It fails
// startup when the schema or either required plan row is missing or invalid.
func New(ctx context.Context, dsn string) (*Store, error) {
	s, err := Open(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := s.LoadPlanLimits(ctx); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func NewWithPool(pool *pgxpool.Pool) *Store {
	return &Store{
		pool:              pool,
		collaborationHTTP: &http.Client{Timeout: 20 * time.Second},
	}
}

// LoadPlanLimits installs one immutable snapshot for this process. Callers
// invoke it once during startup after migrations, never from a request path.
func (s *Store) LoadPlanLimits(ctx context.Context) error {
	s.planLimitsMu.Lock()
	defer s.planLimitsMu.Unlock()
	if _, err := s.planLimits.For(planlimits.TierFree); err == nil {
		return nil
	}
	catalog, err := planlimits.Load(ctx, s.pool)
	if err != nil {
		return err
	}
	s.planLimits = catalog
	return nil
}

func (s *Store) PlanLimits(tier PlanTier) (planlimits.Limits, error) {
	return s.planLimits.For(string(tier))
}

func (s *Store) MaxSourceFileBytes() (int64, error) {
	return s.planLimits.MaxSourceFileBytes()
}

func (s *Store) Close() { s.pool.Close() }

// ConfigureCollaboration enables Yjs-authoritative commands. The sidecar
// bootstraps a missing durable document from the SQL projection on first use.
func (s *Store) ConfigureCollaboration(rawURL, secret string) {
	s.collaborationURL = strings.TrimRight(rawURL, "/")
	s.collaborationSecret = secret
}

// uid mirrors the frontend's id scheme: a short prefixed random token.
func uid(prefix string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

// isNoRows reports whether err is pgx's no-rows sentinel.
func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isRetryableTransactionError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

type cloneSourceLock struct {
	key    string
	shared bool
}

func cloneSourceLockKey(sourceKind, sourceID string) string {
	return "clone-source:" + sourceKind + ":" + sourceID
}

// lockCloneSources establishes the canonical source hierarchy before a clone
// snapshot or deletion takes any account or content lock. Callers choose shared
// or exclusive mode for each level. A transaction-scoped lock is too late
// because PostgreSQL can establish a snapshot while waiting for it.
func (s *Store) lockCloneSources(
	ctx context.Context,
	locks []cloneSourceLock,
) (*pgxpool.Conn, func(), error) {
	for attempt := 0; ; attempt++ {
		conn, err := s.pool.Acquire(ctx)
		if err != nil {
			return nil, nil, err
		}
		acquired := locks[:0]
		for _, lock := range locks {
			query := `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`
			if lock.shared {
				query = `SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0))`
			}
			var locked bool
			err = conn.QueryRow(ctx, query, lock.key).Scan(&locked)
			if err != nil || !locked {
				break
			}
			acquired = append(acquired, lock)
		}
		if err == nil && len(acquired) == len(locks) {
			return conn, func() {
				unlockCloneSources(context.WithoutCancel(ctx), conn, acquired)
				conn.Release()
			}, nil
		}
		unlockCloneSources(context.WithoutCancel(ctx), conn, acquired)
		conn.Release()
		if err != nil {
			return nil, nil, err
		}
		if err := waitCloneRetry(ctx, attempt); err != nil {
			return nil, nil, err
		}
	}
}

func unlockCloneSources(ctx context.Context, conn *pgxpool.Conn, locks []cloneSourceLock) {
	for i := len(locks) - 1; i >= 0; i-- {
		query := `SELECT pg_advisory_unlock(hashtextextended($1, 0))`
		if locks[i].shared {
			query = `SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))`
		}
		_, _ = conn.Exec(ctx, query, locks[i].key)
	}
}

func (s *Store) lockWorkspaceCloneSource(
	ctx context.Context,
	workspaceID string,
	shared bool,
) (*pgxpool.Conn, func(), error) {
	return s.lockCloneSources(ctx, []cloneSourceLock{{
		key: cloneSourceLockKey("workspace", workspaceID), shared: shared,
	}})
}

// lockMaterialCloneSource orders a workspace-contained material under its
// workspace fence. The returned connection is also the transaction starter so
// the session locks cannot migrate to a different pooled connection.
func (s *Store) lockMaterialCloneSource(
	ctx context.Context,
	materialID string,
	shared bool,
) (*pgxpool.Conn, func(), error) {
	for attempt := 0; ; attempt++ {
		var workspaceID *string
		if err := s.pool.QueryRow(ctx,
			`SELECT workspace_id FROM materials WHERE id=$1`, materialID,
		).Scan(&workspaceID); isNoRows(err) {
			return nil, nil, ErrNotFound
		} else if err != nil {
			return nil, nil, err
		}
		locks := make([]cloneSourceLock, 0, 2)
		if workspaceID != nil {
			locks = append(locks, cloneSourceLock{
				key: cloneSourceLockKey("workspace", *workspaceID), shared: true,
			})
		}
		locks = append(locks, cloneSourceLock{
			key: cloneSourceLockKey("material", materialID), shared: shared,
		})
		conn, unlock, err := s.lockCloneSources(ctx, locks)
		if err != nil {
			return nil, nil, err
		}
		var placementUnchanged bool
		err = conn.QueryRow(ctx, `SELECT workspace_id IS NOT DISTINCT FROM $2::text
			FROM materials WHERE id=$1`, materialID, workspaceID).
			Scan(&placementUnchanged)
		if isNoRows(err) {
			unlock()
			return nil, nil, ErrNotFound
		}
		if err != nil {
			unlock()
			return nil, nil, err
		}
		if placementUnchanged {
			return conn, unlock, nil
		}
		unlock()
		if err := waitCloneRetry(ctx, attempt); err != nil {
			return nil, nil, err
		}
	}
}

func uniqueConstraintName(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName
	}
	return ""
}
