package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/evonotes/server/migrations"
)

// ErrNotFound is returned by Get-style methods when a row is absent.
// rowQueryer is satisfied by both *pgxpool.Pool and pgx.Tx, so single-row
// helpers can run either standalone or inside a caller's transaction.
type rowQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

var ErrNotFound = errors.New("not found")

// ErrConflict reports a failed optimistic revision comparison.
var ErrConflict = errors.New("revision conflict")

// ErrForbidden reports authenticated access without the required workspace
// role. Shared-resource probing still uses ErrNotFound.
var ErrForbidden = errors.New("forbidden")

// ErrTitleTaken means another material in the same workspace already uses that
// title (case-insensitive, trimmed). Standalone materials are not in this set.
var ErrTitleTaken = errors.New("material title already used in this workspace")

// ErrAuthorityUnavailable means an initialized Y.Doc could not be mutated
// through the collaboration authority. Callers must fail closed with 503.
var ErrAuthorityUnavailable = errors.New("collaboration authority unavailable")

type Store struct {
	pool                *pgxpool.Pool
	collaborationURL    string
	collaborationSecret string
	collaborationHTTP   *http.Client
}

func New(ctx context.Context, dsn string) (*Store, error) {
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

func (s *Store) Close() { s.pool.Close() }

// ConfigureCollaboration enables Yjs-authoritative commands for initialized
// materials. The URL is the sidecar's internal HTTP origin.
func (s *Store) ConfigureCollaboration(rawURL, secret string) {
	s.collaborationURL = strings.TrimRight(rawURL, "/")
	s.collaborationSecret = secret
}

// Migrate applies every embedded *.sql migration in filename order. The files
// are written idempotently (IF NOT EXISTS / ON CONFLICT) so re-running is safe.
func (s *Store) Migrate(ctx context.Context) error {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".sql" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return nil
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
