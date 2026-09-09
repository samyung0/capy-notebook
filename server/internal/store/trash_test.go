package store

import (
	"context"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

func trashFixture(t *testing.T, s *Store) (ownerID, editorID string, ws Workspace, file File, mt Material) {
	t.Helper()
	ctx := context.Background()
	ownerID = newBlobTestUser(t, s, "u_trash_owner")
	editorID = newBlobTestUser(t, s, "u_trash_editor")
	var err error
	ws, err = s.CreateWorkspace(ctx, ownerID, "Trash workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`,
		ws.ID, editorID); err != nil {
		t.Fatal(err)
	}
	file, err = s.CreateSourceReady(ctx, ws.ID, editorID, "notes.md", "md", nil, "", 4096, "sources/"+uid("blob")+"/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	mt, err = s.CreateMaterial(ctx, Material{
		CreatedBy: editorID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Trash note",
		Content: "# Trash note\n\nbody", Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	return ownerID, editorID, ws, file, mt
}

// userUsedBytes is the effective usage: the folded counter plus pending deltas.
func userUsedBytes(t *testing.T, s *Store, userID string) int64 {
	t.Helper()
	var used int64
	if err := s.pool.QueryRow(context.Background(), `SELECT COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1),0)
		+ COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1),0)`, userID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	return used
}

func fileCount(t *testing.T, s *Store, wsID string, includeTrashed bool) int {
	t.Helper()
	q := `SELECT count(*) FROM files WHERE workspace_id=$1`
	if !includeTrashed {
		q += ` AND trashed_at IS NULL`
	}
	var n int
	if err := s.pool.QueryRow(context.Background(), q, wsID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// An editor may trash workspace content; only the current owner sees, restores
// or purges it. Trashed rows leave every active read but keep their bytes.
func TestTrashLifecycleAuthorityAndVisibility(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID, editorID, ws, file, mt := trashFixture(t, s)
	// A source editing session exists so restore has an epoch to advance.
	if _, err := s.pool.Exec(ctx, `INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,base_source_sha256) VALUES($1,'text',1,'p','')`, file.ID); err != nil {
		t.Fatal(err)
	}

	usedBefore := userUsedBytes(t, s, ownerID)
	trashed, err := s.TrashFile(ctx, editorID, file.ID, AgentOperation{ID: "req_trash_1", RequestHash: "h1"})
	if err != nil {
		t.Fatal(err)
	}
	if trashed.Effect == nil || trashed.Effect.Operation != agenttools.EffectTrashed || trashed.Effect.TrashEpisodeID == "" {
		t.Fatalf("effect = %+v", trashed.Effect)
	}
	if _, err := s.TrashMaterial(ctx, editorID, mt.ID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}

	// Active reads stop at the trash boundary; accounting does not.
	if _, err := s.GetFile(ctx, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetFile after trash = %v", err)
	}
	if _, err := s.GetMaterial(ctx, mt.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetMaterial after trash = %v", err)
	}
	files, err := s.ListFiles(ctx, "", ws.ID)
	if err != nil || len(files) != 0 {
		t.Fatalf("ListFiles = %v, %v", files, err)
	}
	refs, err := s.ListMaterialRefs(ctx, ws.ID)
	if err != nil || len(refs) != 0 {
		t.Fatalf("ListMaterialRefs = %v, %v", refs, err)
	}
	if got := userUsedBytes(t, s, ownerID); got != usedBefore {
		t.Fatalf("used bytes changed on trash: %d -> %d", usedBefore, got)
	}
	if fileCount(t, s, ws.ID, true) != 1 || fileCount(t, s, ws.ID, false) != 0 {
		t.Fatal("trashed file must keep its slot in the physical count only")
	}

	// Replay of the same trash request returns the recorded receipt.
	again, err := s.TrashFile(ctx, editorID, file.ID, AgentOperation{ID: "req_trash_1", RequestHash: "h1"})
	if err != nil || again.Effect.TrashEpisodeID != trashed.Effect.TrashEpisodeID {
		t.Fatalf("replay = %+v, %v", again, err)
	}
	if _, err := s.TrashFile(ctx, editorID, file.ID, AgentOperation{ID: "req_trash_1", RequestHash: "other"}); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("different request under same id = %v", err)
	}
	if _, err := s.TrashFile(ctx, editorID, file.ID, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second trash without a receipt = %v", err)
	}

	// The editor who trashed it cannot see or restore the shared bin.
	page, err := s.ListTrash(ctx, editorID, ws.ID, 50, "")
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("editor trash listing = %+v, %v", page, err)
	}
	if _, err := s.RestoreTrashed(ctx, editorID, agenttools.KindSourceFile, file.ID, trashed.Effect.TrashEpisodeID, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("editor restore = %v", err)
	}
	page, err = s.ListTrash(ctx, ownerID, ws.ID, 50, "")
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("owner trash listing = %+v, %v", page, err)
	}

	// Restore keeps identity and charges, and reopens under a fresh incarnation.
	restored, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindSourceFile, file.ID, trashed.Effect.TrashEpisodeID, AgentOperation{ID: "req_restore_1", RequestHash: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Effect == nil || restored.Effect.Operation != agenttools.EffectRestored || restored.Effect.Resource.ID != file.ID {
		t.Fatalf("restore effect = %+v", restored.Effect)
	}
	var epoch int64
	if err := s.pool.QueryRow(ctx, `SELECT epoch FROM source_documents WHERE file_id=$1`, file.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if epoch != 2 {
		t.Fatalf("source epoch after restore = %d, want 2", epoch)
	}
	if got, err := s.GetFile(ctx, file.ID); err != nil || got.ID != file.ID {
		t.Fatalf("GetFile after restore = %+v, %v", got, err)
	}
	if got := userUsedBytes(t, s, ownerID); got != usedBefore {
		t.Fatalf("used bytes changed on restore: %d -> %d", usedBefore, got)
	}
	// A stale purge for the finished episode must not touch the restored file.
	if _, err := s.PurgeTrashed(ctx, ownerID, agenttools.KindSourceFile, file.ID, trashed.Effect.TrashEpisodeID, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale purge = %v", err)
	}
	// A fresh trash starts a new episode.
	retrashed, err := s.TrashFile(ctx, ownerID, file.ID, AgentOperation{})
	if err != nil || retrashed.Effect.TrashEpisodeID == trashed.Effect.TrashEpisodeID {
		t.Fatalf("re-trash = %+v, %v", retrashed, err)
	}

	// Never-bootstrapped material: restore advances the implicit room so an old
	// token cannot reconnect at schema 1.
	items := page.Items
	var materialEpisode string
	for _, item := range items {
		if item.Kind == agenttools.KindMaterial {
			materialEpisode = item.EpisodeID
		}
	}
	if _, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindMaterial, mt.ID, materialEpisode, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	room, err := s.MaterialRoom(ctx, mt.ID)
	if err != nil || room != "material:"+mt.ID+":schema:2" {
		t.Fatalf("material room after restore = %q, %v", room, err)
	}

	// Owner purge deletes the still-trashed episode and releases the bytes.
	if _, err := s.PurgeTrashed(ctx, ownerID, agenttools.KindSourceFile, file.ID, retrashed.Effect.TrashEpisodeID, AgentOperation{ID: "req_purge_1", RequestHash: "p1"}); err != nil {
		t.Fatal(err)
	}
	if fileCount(t, s, ws.ID, true) != 0 {
		t.Fatal("purge left the file row")
	}
	if got := userUsedBytes(t, s, ownerID); got >= usedBefore {
		t.Fatalf("used bytes not released by purge: %d -> %d", usedBefore, got)
	}
}

// Retention is measured by the database from the trash transition: restore at
// or after purge_after is refused even before the sweep, and the sweep deletes
// only due episodes.
func TestTrashExpiryAndSweep(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID, _, ws, file, mt := trashFixture(t, s)
	trashed, err := s.TrashFile(ctx, ownerID, file.ID, AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashMaterial(ctx, ownerID, mt.ID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	var purgeAfterIsFuture bool
	if err := s.pool.QueryRow(ctx, `SELECT purge_after > now() + interval '29 days' AND purge_after <= now() + interval '30 days' FROM files WHERE id=$1`, file.ID).Scan(&purgeAfterIsFuture); err != nil {
		t.Fatal(err)
	}
	if !purgeAfterIsFuture {
		t.Fatal("purge_after is not 30 days from the trash transition")
	}
	// Nothing is due yet.
	if n, err := s.SweepDueTrash(ctx, 10); err != nil || n != 0 {
		t.Fatalf("early sweep = %d, %v", n, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET purge_after=now() - interval '1 second' WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindSourceFile, file.ID, trashed.Effect.TrashEpisodeID, AgentOperation{}); !errors.Is(err, ErrTrashExpired) {
		t.Fatalf("restore after expiry = %v", err)
	}
	if n, err := s.SweepDueTrash(ctx, 10); err != nil || n != 1 {
		t.Fatalf("sweep = %d, %v", n, err)
	}
	if fileCount(t, s, ws.ID, true) != 0 {
		t.Fatal("sweep left the expired file")
	}
	var materialStillTrashed bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM materials WHERE id=$1 AND trashed_at IS NOT NULL)`, mt.ID).Scan(&materialStillTrashed); err != nil {
		t.Fatal(err)
	}
	if !materialStillTrashed {
		t.Fatal("sweep deleted a material that was not due")
	}
}

// Trashing a file cancels its pending pipeline work and enqueues the source
// room eviction, the same fences a hard delete provides.
func TestTrashFencesJobsAndRooms(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID, _, _, file, _ := trashFixture(t, s)
	jobID := uid("job")
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id,type,payload,status,attempts)
		VALUES ($1,'ingest',jsonb_build_object('fileId',$2::text),'pending',0)`, jobID, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,base_source_sha256) VALUES($1,'text',1,'p','')`, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashFile(ctx, ownerID, file.ID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM jobs WHERE id=$1`, jobID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status == "pending" || status == "running" {
		t.Fatalf("job still %s after trash", status)
	}
	var evictions int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM collaboration_eviction_outbox
		WHERE payload->>'fileId'=$1 AND payload->>'mode'='discard'`, file.ID).Scan(&evictions); err != nil {
		t.Fatal(err)
	}
	if evictions == 0 {
		t.Fatal("trash did not enqueue the source room eviction")
	}
}
