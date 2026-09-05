package store

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

type pausingCloneStarter struct {
	starter cloneTxStarter
	reached chan struct{}
	proceed chan struct{}
	pauseOn string
}

func (s pausingCloneStarter) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	tx, err := s.starter.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &pausingCloneTx{
		Tx: tx, reached: s.reached, proceed: s.proceed, pauseOn: s.pauseOn,
	}, nil
}

type pausingCloneTx struct {
	pgx.Tx
	reached chan struct{}
	proceed chan struct{}
	pauseOn string
	once    sync.Once
}

func (tx *pausingCloneTx) Query(
	ctx context.Context,
	sql string,
	args ...any,
) (pgx.Rows, error) {
	pauseOn := tx.pauseOn
	if pauseOn == "" {
		pauseOn = "FROM users WHERE id=ANY"
	}
	if strings.Contains(sql, pauseOn) {
		tx.once.Do(func() {
			close(tx.reached)
			select {
			case <-tx.proceed:
			case <-ctx.Done():
			}
		})
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestWorkspaceCloneRejectsAPathReapedAfterItsSnapshot(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_blob_fence_source")
	targetID := newBlobTestUser(t, s, "u_clone_blob_fence_target")
	source, err := s.CreateWorkspace(ctx, ownerID, "Blob fence", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	path := "sources/" + uid("clone-fence")
	file, err := s.CreateSourceReady(
		ctx, source.ID, ownerID, "source.pdf", "pdf", nil, "", 128, path,
	)
	if err != nil {
		t.Fatal(err)
	}

	reached := make(chan struct{})
	proceed := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, cloneErr := s.cloneWorkspaceOnce(ctx, pausingCloneStarter{
			starter: s.pool, reached: reached, proceed: proceed,
			pauseOn: "FROM blobs",
		}, targetID, source.ID)
		result <- cloneErr
	}()
	<-reached
	if _, err := s.pool.Exec(ctx, `DELETE FROM files WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE pending_blob_deletions
		SET not_before='-infinity' WHERE object_path=$1`, path); err != nil {
		t.Fatal(err)
	}
	claims, err := s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].ObjectPath != path {
		t.Fatalf("blob claims = %#v, want %q", claims, path)
	}
	if err := s.FinishBlobDeletions(ctx, claims); err != nil {
		t.Fatal(err)
	}
	close(proceed)
	if err := <-result; !isRetryableTransactionError(err) {
		t.Fatalf("clone error = %v, want retryable path teardown race", err)
	}
	if got := blobRefCount(t, s, path); got != 0 {
		t.Fatalf("deleted path refcount = %d, want 0", got)
	}
}

func TestMaterialCloneCounterCleanupWaitsForCloneFence(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_counter_fence")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Counter fence", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	lockKey := "clone-source:material:" + source.ID
	cloneConn, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cloneConn.Release()
	if _, err := cloneConn.Exec(ctx,
		`SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			_, _ = cloneConn.Exec(context.Background(),
				`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, lockKey)
		}
	}()

	deleteConn, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deleteConn.Release()
	var deletePID int
	if err := deleteConn.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&deletePID); err != nil {
		t.Fatal(err)
	}
	deleteResult := make(chan error, 1)
	go func() {
		_, deleteErr := deleteConn.Exec(ctx, `DELETE FROM materials WHERE id=$1`, source.ID)
		deleteResult <- deleteErr
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted
		)`, deletePID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("material delete did not wait for the clone counter fence")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := cloneConn.Exec(ctx, `INSERT INTO material_clone_counts
		(material_id, clone_count) VALUES ($1,1)`, source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := cloneConn.Exec(ctx,
		`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, lockKey); err != nil {
		t.Fatal(err)
	}
	locked = false
	if err := <-deleteResult; err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM material_clone_counts
		WHERE material_id=$1`, source.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("orphan material clone counters = %d, want 0", remaining)
	}
}

func assertAccountRowRemainsUnlocked(
	t *testing.T,
	s *Store,
	ctx context.Context,
	userID string,
) {
	t.Helper()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx,
		`SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT`, userID,
	); err != nil {
		t.Fatalf("delete locked account before clone fence: %v", err)
	}
}

func TestMaterialDeleteTakesCloneFenceBeforeAccountLock(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_material_delete_lock_order")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Material hierarchy", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Delete lock order",
		Content: content, WorkspaceID: workspace.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, unlock, err := s.lockWorkspaceCloneSource(ctx, workspace.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()

	started := make(chan struct{})
	deleted := make(chan error, 1)
	go func() {
		close(started)
		deleted <- s.DeleteMaterial(ctx, ownerID, source.ID)
	}()
	<-started
	time.Sleep(100 * time.Millisecond)
	assertAccountRowRemainsUnlocked(t, s, ctx, ownerID)

	unlock()
	locked = false
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceDeleteTakesCloneFenceBeforeAccountLock(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_workspace_delete_lock_order")
	source, err := s.CreateWorkspace(ctx, ownerID, "Delete lock order", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Contained clone fence",
		Content: content, WorkspaceID: source.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, unlock, err := s.lockMaterialCloneSource(ctx, material.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()

	started := make(chan struct{})
	deleted := make(chan error, 1)
	go func() {
		close(started)
		deleted <- s.DeleteWorkspace(ctx, ownerID, source.ID)
	}()
	<-started
	time.Sleep(100 * time.Millisecond)
	assertAccountRowRemainsUnlocked(t, s, ctx, ownerID)

	unlock()
	locked = false
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
}

func TestUninitializedContentCommandBootstrapsThroughCollaboration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	current, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"Before","correct":true}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	desired := strings.Replace(current, "Before", "After", 1)
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: "u_owner", Kind: "quiz", Title: "Quiz", Content: current,
	})
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan struct{}, 1)
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/commands" || r.Header.Get("X-Collaboration-Secret") != "command-secret" {
			http.Error(w, "bad command", http.StatusBadRequest)
			return
		}
		seen <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"applied"}`))
	}))
	t.Cleanup(sidecar.Close)
	s.ConfigureCollaboration(sidecar.URL, "command-secret")

	handled, err := s.applyAuthoritativeContentCommand(
		ctx, material.ID, "u_owner", current, desired,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !handled {
		t.Fatal("uninitialized material fell back to SQL instead of bootstrapping through collaboration")
	}
	select {
	case <-seen:
	default:
		t.Fatal("collaboration command was not sent")
	}
}

func TestConcurrentMaterialClonesBothComplete(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_lock_source")
	targets := []string{
		newBlobTestUser(t, s, "u_clone_lock_target_1"),
		newBlobTestUser(t, s, "u_clone_lock_target_2"),
		newBlobTestUser(t, s, "u_clone_lock_target_3"),
		newBlobTestUser(t, s, "u_clone_lock_target_4"),
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Concurrent clone",
		Content: content, Privacy: PrivacyPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, len(targets))
	for _, targetID := range targets {
		go func() {
			_, cloneErr := s.CloneMaterial(ctx, targetID, source.ID)
			errs <- cloneErr
		}()
	}
	for range targets {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent material clone: %v", err)
		}
	}
	var cloneCount int
	if err := s.pool.QueryRow(ctx, `SELECT clone_count FROM material_clone_counts WHERE material_id=$1`, source.ID).
		Scan(&cloneCount); err != nil {
		t.Fatal(err)
	}
	if cloneCount != len(targets) {
		t.Fatalf("material clone_count=%d, want %d", cloneCount, len(targets))
	}
}

func TestMaterialCloneDoesNotWaitForSourceRow(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_unlocked_material_source")
	targetID := newBlobTestUser(t, s, "u_clone_unlocked_material_target")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Unlocked clone",
		Content: content, Privacy: PrivacyPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT id FROM materials WHERE id=$1 FOR UPDATE`, source.ID); err != nil {
		t.Fatal(err)
	}

	cloneCtx, cloneCancel := context.WithTimeout(ctx, 2*time.Second)
	defer cloneCancel()
	if _, err := s.CloneMaterial(cloneCtx, targetID, source.ID); err != nil {
		t.Fatalf("clone waited for source material row: %v", err)
	}
}

func TestCloneSourceWaitersDoNotExhaustPool(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_pool_source")
	targetID := newBlobTestUser(t, s, "u_clone_pool_target")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Clone pool",
		Content: content, Privacy: PrivacyPublic,
	})
	if err != nil {
		t.Fatal(err)
	}

	blocker, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			_, _ = blocker.Exec(context.Background(),
				`SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
				"clone-source:material:"+source.ID)
		}
		blocker.Release()
	}()
	if _, err := blocker.Exec(ctx,
		`SELECT pg_advisory_lock(hashtextextended($1, 0))`,
		"clone-source:material:"+source.ID); err != nil {
		t.Fatal(err)
	}

	waiterCount := int(s.pool.Config().MaxConns) * 2
	errs := make(chan error, waiterCount)
	for range waiterCount {
		go func() {
			_, cloneErr := s.CloneMaterial(ctx, targetID, source.ID)
			errs <- cloneErr
		}()
	}
	time.Sleep(100 * time.Millisecond)
	queryCtx, queryCancel := context.WithTimeout(ctx, 2*time.Second)
	defer queryCancel()
	var one int
	if err := s.pool.QueryRow(queryCtx, `SELECT 1`).Scan(&one); err != nil {
		t.Fatalf("clone waiters exhausted connection pool: %v", err)
	}
	if one != 1 {
		t.Fatalf("unrelated query returned %d", one)
	}

	if _, err := blocker.Exec(ctx,
		`SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
		"clone-source:material:"+source.ID); err != nil {
		t.Fatal(err)
	}
	locked = false
	for range waiterCount {
		if err := <-errs; err != nil {
			t.Fatalf("waiting clone: %v", err)
		}
	}
}

func TestConcurrentWorkspaceClonesBothComplete(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_workspace_clone_lock_source")
	targets := []string{
		newBlobTestUser(t, s, "u_workspace_clone_lock_target_1"),
		newBlobTestUser(t, s, "u_workspace_clone_lock_target_2"),
		newBlobTestUser(t, s, "u_workspace_clone_lock_target_3"),
		newBlobTestUser(t, s, "u_workspace_clone_lock_target_4"),
	}
	source, err := s.CreateWorkspace(ctx, ownerID, "Concurrent workspace clone", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, len(targets))
	for _, targetID := range targets {
		go func() {
			_, cloneErr := s.CloneWorkspace(ctx, targetID, source.ID)
			errs <- cloneErr
		}()
	}
	for range targets {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent workspace clone: %v", err)
		}
	}
	var cloneCount int
	if err := s.pool.QueryRow(ctx, `SELECT clone_count FROM workspace_clone_counts WHERE workspace_id=$1`, source.ID).
		Scan(&cloneCount); err != nil {
		t.Fatal(err)
	}
	if cloneCount != len(targets) {
		t.Fatalf("workspace clone_count=%d, want %d", cloneCount, len(targets))
	}
}

func TestWorkspaceCloneDoesNotWaitForSourceRow(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_clone_unlocked_workspace_source")
	targetID := newBlobTestUser(t, s, "u_clone_unlocked_workspace_target")
	source, err := s.CreateWorkspace(ctx, ownerID, "Unlocked workspace clone", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: source.ID, Kind: "note",
		Title: "Locked projected material", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, `SELECT id FROM materials WHERE id=$1 FOR UPDATE`, material.ID); err != nil {
		t.Fatal(err)
	}

	cloneCtx, cloneCancel := context.WithTimeout(ctx, 2*time.Second)
	defer cloneCancel()
	if _, err := s.CloneWorkspace(cloneCtx, targetID, source.ID); err != nil {
		t.Fatalf("clone waited for source workspace row: %v", err)
	}
}

func TestWorkspaceCloneSerializesHistorySelectionWithTargetDowngrade(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sourceOwnerID := newBlobTestUser(t, s, "u_workspace_history_source")
	targetID := newBlobTestUser(t, s, "u_workspace_history_target")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET plan_tier='pro',
		subscription_status='active' WHERE id=$1`, sourceOwnerID); err != nil {
		t.Fatal(err)
	}
	targetSubscription := proSubscription(targetID, uid("sub"), 1_000)
	if err := s.UpsertSubscription(ctx, targetSubscription); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateWorkspace(
		ctx, sourceOwnerID, "History race source", ColorBlue, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`,
		workspace.ID); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: sourceOwnerID, WorkspaceID: workspace.ID,
		WorkspaceName: workspace.Name, Kind: "note", Title: "History",
		Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM material_revisions WHERE material_id=$1`,
		material.ID); err != nil {
		t.Fatal(err)
	}
	historyTx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lastDay := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 10; index++ {
		revision := int64(index + 1)
		if err := s.upsertMaterialRevisionTx(ctx, historyTx, MaterialRevision{
			MaterialID: material.ID, Revision: revision, EventType: RevisionEdit,
			Title: material.Title, Content: content, EventMetadata: []byte(`{}`),
			CreatedBy: &sourceOwnerID, CreatedAt: lastDay.AddDate(0, 0, index-9),
		}); err != nil {
			_ = historyTx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := historyTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	reached := make(chan struct{})
	proceed := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, cloneErr := s.cloneWorkspaceOnce(ctx, pausingCloneStarter{
			starter: s.pool, reached: reached, proceed: proceed,
		}, targetID, workspace.ID)
		result <- cloneErr
	}()
	<-reached
	targetSubscription.Status = "canceled"
	targetSubscription.StripeEventCreated = 2_000
	if err := s.UpsertSubscription(ctx, targetSubscription); err != nil {
		t.Fatal(err)
	}
	close(proceed)
	if err := <-result; !isRetryableTransactionError(err) {
		t.Fatalf("raced clone error=%v, want retryable serialization failure", err)
	}

	cloned, err := s.CloneWorkspace(ctx, targetID, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	var clonedMaterialID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM materials WHERE workspace_id=$1`,
		cloned.ID).Scan(&clonedMaterialID); err != nil {
		t.Fatal(err)
	}
	versions, err := s.ListMaterialRevisions(ctx, clonedMaterialID)
	if err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).MaterialRevisions
	if len(versions) != freeLimit {
		t.Fatalf("downgraded workspace clone retained %d versions, want %d",
			len(versions), freeLimit)
	}
}

func TestSuspendedSourceOwnerDoesNotHideSharedCloneSources(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_clone_suspended_source")
	targetID := newBlobTestUser(t, s, "u_clone_suspended_target")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Suspended source", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE workspaces SET privacy='public' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
		Kind: "note", Title: "Suspended shared material", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='operator hold' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}

	materialClone, err := s.CloneMaterial(ctx, targetID, source.ID)
	if err != nil {
		t.Fatalf("material clone from suspended shared owner: %v", err)
	}
	if materialClone.WorkspaceID != "" || materialClone.Privacy != PrivacyPrivate {
		t.Fatalf("material clone workspace=%q privacy=%q",
			materialClone.WorkspaceID, materialClone.Privacy)
	}
	workspaceClone, err := s.CloneWorkspace(ctx, targetID, workspace.ID)
	if err != nil {
		t.Fatalf("workspace clone from suspended shared owner: %v", err)
	}
	if workspaceClone.Privacy != PrivacyPrivate {
		t.Fatalf("workspace clone privacy=%q", workspaceClone.Privacy)
	}
}

func TestRewriteCardIDs(t *testing.T) {
	source, err := materialdoc.FlashcardsDocument([]materialdoc.Card{
		{ID: "c_old_1", Front: "A", Back: "B"},
		{ID: "c_old_2", Front: "C", Back: "D"},
	})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := materialdoc.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	flashcards := doc.Value[0]
	card := flashcards["children"].([]any)[0].(map[string]any)
	front := card["children"].([]any)[0].(map[string]any)
	front["children"] = []any{map[string]any{"text": "A", "comment": "disc_1"}}
	source, err = materialdoc.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	cloned, ids, err := rewriteCardIDs("FlashcardSet", source)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] == "c_old_1" || ids[1] == "c_old_2" || ids[0] == ids[1] {
		t.Fatalf("expected two fresh unique ids, got %#v", ids)
	}
	cards, err := materialdoc.ExtractFlashcards(cloned)
	if err != nil {
		t.Fatal(err)
	}
	if cards[0].ID != ids[0] || cards[0].Front != "A" || cards[0].Back != "B" {
		t.Fatalf("cloned card content changed: %#v", cards[0])
	}
	if strings.Contains(cloned, `"comment":"disc_1"`) {
		t.Fatalf("cloning persisted a runtime comment decoration: %s", cloned)
	}
}

func TestCloneMaterialUsesTargetTierForDailyVersionRetention(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx := context.Background()
	sourceUserID := uid("u_clone_source")
	targetUserID := uid("u_clone_target")
	for _, user := range []struct {
		id   string
		tier PlanTier
	}{
		{id: sourceUserID, tier: PlanPro},
		{id: targetUserID, tier: PlanFree},
	} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO users
			(id,name,email,plan_tier,subscription_status)
			VALUES ($1,'Clone Revision Test',$2,$3,'active')`,
			user.id,
			fmt.Sprintf("%s@example.test", user.id),
			user.tier,
		); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`,
			[]string{sourceUserID, targetUserID})
	})

	content, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{
		ID: "source-card", Front: "front", Back: "back",
	}})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: sourceUserID, Kind: "flashcards", Title: "Clone retention",
		Content: content, Privacy: PrivacyPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM material_revisions WHERE material_id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	lastDay := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 10; i++ {
		revision := int64(i + 1)
		var parent *int64
		if revision > 1 {
			value := revision - 1
			parent = &value
		}
		if err := s.upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
			MaterialID: source.ID, Revision: revision, ParentRevision: parent,
			EventType: RevisionEdit, Title: source.Title, Content: content,
			EventMetadata: []byte(`{"changedFields":["content"]}`),
			CreatedBy:     &sourceUserID,
			CreatedAt:     lastDay.AddDate(0, 0, i-9),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET revision=10 WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	cloned, err := s.CloneMaterial(ctx, targetUserID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := s.ListMaterialRevisions(ctx, cloned.ID)
	if err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).MaterialRevisions
	if len(versions) != freeLimit {
		t.Fatalf("free clone retained %d versions, want %d", len(versions), freeLimit)
	}
	clonedCards, err := materialdoc.ExtractFlashcards(cloned.Content)
	if err != nil {
		t.Fatal(err)
	}
	if len(clonedCards) != 1 || clonedCards[0].ID == "source-card" {
		t.Fatalf("clone current content card IDs were not rewritten: %#v", clonedCards)
	}
	for _, version := range versions {
		cards, err := materialdoc.ExtractFlashcards(version.Content)
		if err != nil {
			t.Fatal(err)
		}
		if len(cards) != 1 || cards[0].ID != clonedCards[0].ID {
			t.Fatalf("clone version card IDs diverged from current content: %#v", cards)
		}
	}
}

func TestCloneMaterialUsesProjectionAndRehomesReferencedAssets(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx := context.Background()
	sourceUserID := uid("u_clone_media_source")
	targetUserID := uid("u_clone_media_target")
	for _, id := range []string{sourceUserID, targetUserID} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO users (id,name,email)
			VALUES ($1,'Clone Media Test',$2)`, id, fmt.Sprintf("%s@example.test", id)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`,
			[]string{sourceUserID, targetUserID})
	})

	workspace, err := s.CreateWorkspace(ctx, sourceUserID, "Shared media", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	sourceAssetID := uid("asset")
	objectPath := "editor-assets/" + sourceAssetID + ".png"
	if _, err := s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id,workspace_id,user_id,created_by,name,purpose,object_path,content_type,
		 size_bytes,status,etag,completed_at)
		VALUES ($1,$2,$3,$3,'diagram.png','image',$4,'image/png',128,'ready','etag',now())`,
		sourceAssetID, workspace.ID, sourceUserID, objectPath); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{
		SchemaVersion: materialdoc.SchemaVersion,
		Value: []map[string]any{{
			"type": "img", "id": "media", "assetId": sourceAssetID,
			"children": []any{map[string]any{"text": ""}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		CreatedBy: sourceUserID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
		Kind: "note", Title: "Media note", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Durable Yjs is ahead of the SQL projection. Cloning intentionally reads
	// materials.content and must neither wait for nor inspect this row.
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id,state,stored_version,projected_version)
		VALUES ($1,$2,2,1)`, source.ID, []byte{1}); err != nil {
		t.Fatal(err)
	}

	cloned, err := s.CloneMaterial(ctx, targetUserID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cloned.WorkspaceID != "" || cloned.Privacy != PrivacyPrivate {
		t.Fatalf("clone workspace=%q privacy=%q, want standalone private", cloned.WorkspaceID, cloned.Privacy)
	}
	if strings.Contains(cloned.Content, sourceAssetID) {
		t.Fatalf("clone retained source workspace asset id: %s", cloned.Content)
	}
	var clonedAssetID, clonedWorkspaceID, clonedMaterialID, clonedPath string
	if err := s.pool.QueryRow(ctx, `SELECT id, COALESCE(workspace_id,''),
		COALESCE(material_id,''), object_path FROM editor_assets WHERE material_id=$1`,
		cloned.ID).Scan(&clonedAssetID, &clonedWorkspaceID, &clonedMaterialID, &clonedPath); err != nil {
		t.Fatal(err)
	}
	if clonedAssetID == sourceAssetID || clonedWorkspaceID != "" ||
		clonedMaterialID != cloned.ID || clonedPath != objectPath ||
		!strings.Contains(cloned.Content, clonedAssetID) {
		t.Fatalf("standalone asset id=%q workspace=%q material=%q path=%q content=%s",
			clonedAssetID, clonedWorkspaceID, clonedMaterialID, clonedPath, cloned.Content)
	}
	var clonedYjs bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM material_yjs_documents WHERE material_id=$1)`, cloned.ID).Scan(&clonedYjs); err != nil {
		t.Fatal(err)
	}
	if clonedYjs {
		t.Fatal("clone eagerly created durable Yjs state")
	}
	versions, err := s.ListMaterialRevisions(ctx, cloned.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range versions {
		if strings.Contains(version.Content, sourceAssetID) || !strings.Contains(version.Content, clonedAssetID) {
			t.Fatalf("cloned revision retained the wrong asset id: %s", version.Content)
		}
	}
}
