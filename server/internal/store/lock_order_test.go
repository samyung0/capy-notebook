package store

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

// holdWorkspaceThenAccount plays a source checkpoint or access check
// (sourceLockTx): it locks the workspace, waits until run is blocked behind
// it, then locks the owner account. A run that took the account before the
// workspace deadlocks here (40P01) instead of finishing after the commit.
func holdWorkspaceThenAccount(t *testing.T, s *Store, workspaceID, accountID string, run func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	waitBlockedBy(t, ctx, s, writer)
	if _, err := writer.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE`, accountID); err != nil {
		t.Fatalf("workspace writer: %v", err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("run after the workspace writer: %v", err)
	}
}

func waitBlockedBy(t *testing.T, ctx context.Context, s *Store, tx pgx.Tx) {
	t.Helper()
	pid := tx.Conn().PgConn().PID()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var blocked bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1::int=ANY(pg_blocking_pids(a.pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("run never waited on the workspace writer")
		}
	}
}

func TestNoteIndexRequestLocksWorkspaceBeforeAccount(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_index_order")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Indexed", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Note",
		Content: "# Heading\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	holdWorkspaceThenAccount(t, s, ws.ID, ownerID, func(ctx context.Context) error {
		_, err := s.RequestMaterialIndex(ctx, note.ID)
		return err
	})
}

func TestProviderSessionLocksWorkspaceBeforeAccount(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, WorkspaceCreate{Name: "Chat", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	llm, embed := platformSessionRates()
	holdWorkspaceThenAccount(t, s, ws.ID, userID, func(ctx context.Context) error {
		_, err := s.BeginProviderSession(ctx, userID, ws.ID, SurfaceChat, models.PaidByPlatform, llm, embed, "")
		return err
	})
}

// Enqueueing holds workspace and account locks; a read on a second pool
// connection could wait behind requests that wait on those locks. With one
// connection, that wait never ends.
func TestIngestJobPayloadStaysOnItsTransaction(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	config := s.pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	single := NewWithPool(pool)
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	single.SetModelRegistry(reg)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := single.ingestJobPayload(ctx, tx, "u_actor", map[string]any{"fileId": "f_1"}); err != nil {
		t.Fatalf("payload inside the only connection's transaction: %v", err)
	}
}
