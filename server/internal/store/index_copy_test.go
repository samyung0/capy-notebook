package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// runIndexCopies runs the copy worker until no index_copy job is due.
func runIndexCopies(t *testing.T, s *Store) []IndexCopyEvent {
	t.Helper()
	var events []IndexCopyEvent
	for {
		ran, err := s.RunIndexCopy(context.Background(), func(e IndexCopyEvent) { events = append(events, e) })
		if err != nil {
			t.Fatal(err)
		}
		if !ran {
			return events
		}
	}
}

// A clone opens at once, processing, and its index arrives from the copy
// worker in batches (Epo 2026-10-27/28): fresh passages and vectors under the
// copy's own content row, progress on the way, ready and indexed at the end.
func TestCloneIndexCopiesInTheBackgroundInBatches(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_index_copy")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file := uploadWorkspaceFile(t, s, owner, src.ID)
	content := indexFile(t, s, file.ID, src.ID, owner, src.ID, "h-index-copy")
	const chunks = indexCopyBatch*2 + 17
	if _, err := s.pool.Exec(ctx, `UPDATE rag_contents SET embedding_provider_slug=w.embedding_provider_slug,
			embedding_model_slug=w.embedding_model_slug, embedding_model_version=w.embedding_model_version,
			embedding_dim=w.embedding_dim
		FROM workspaces w WHERE rag_contents.id=$1 AND w.id=$2`, content, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_chunks (id, content_id, chunk_idx, text, indexed_text, lang)
		SELECT $1 || '_' || g, $1, g, 'p', 'p', 'en' FROM generate_series(0, $2 - 1) g`, content, chunks); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_chunk_vectors_2560 (chunk_id, content_id, embedding)
		SELECT id, content_id, array_fill(0.5::real, ARRAY[2560])::halfvec FROM rag_chunks WHERE content_id=$1`, content); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET status='ready' WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}

	clone, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: dst.ID, Name: "copy"})
	if err != nil {
		t.Fatal(err)
	}
	if clone.Status != FileProcessing || clone.Indexed {
		t.Fatalf("clone opened %s indexed=%v, want processing and not indexed", clone.Status, clone.Indexed)
	}

	events := runIndexCopies(t, s)
	got, err := s.GetFile(ctx, clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	var copied, passages, vectors int
	var copyID string
	if err := s.pool.QueryRow(ctx, `SELECT rc.id, (SELECT count(*) FROM rag_chunks c WHERE c.content_id=rc.id),
			(SELECT count(*) FROM rag_chunk_vectors_2560 v WHERE v.content_id=rc.id), 1
		FROM rag_file_contents fc JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready' AND rc.workspace_id=$2
		WHERE fc.file_id=$1`, clone.ID, dst.ID).Scan(&copyID, &passages, &vectors, &copied); err != nil {
		t.Fatalf("copy not served: %v", err)
	}
	if got.Status != FileReady || !got.Indexed || copyID == content || passages != chunks || vectors != chunks {
		t.Fatalf("copy %s indexed=%v content=%s passages=%d vectors=%d, want ready, indexed, its own %d",
			got.Status, got.Indexed, copyID, passages, vectors, chunks)
	}
	if len(events) != 3 || events[0].Stage != "copy_index" || events[0].Pct != indexCopyBatch*100/chunks ||
		events[2].Status != "ready" || events[2].Indexed == nil || !*events[2].Indexed {
		t.Fatalf("events = %+v, want two batch steps then ready", events)
	}
}

// A copy whose source index is gone before it runs is ingested instead, one
// whose claim a finished same-content upload took is served by that upload's
// content, and one whose workspace is deleted ends with nothing left behind.
func TestCloneIndexCopyFallsBackOrEnds(t *testing.T) {
	// The fallback ingest pins its models from the registry.
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_index_copy_fallback")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	clone := func(hash string) (File, File) {
		t.Helper()
		dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target " + hash, Tags: []TagRef{}})
		if err != nil {
			t.Fatal(err)
		}
		file := uploadWorkspaceFile(t, s, owner, src.ID)
		indexFile(t, s, file.ID, src.ID, owner, src.ID, hash)
		if _, err := s.pool.Exec(ctx, `UPDATE files SET status='ready', kind='pdf', name=$2, parse_mode='fast' WHERE id=$1`,
			file.ID, fmt.Sprintf("%s.pdf", hash)); err != nil {
			t.Fatal(err)
		}
		copied, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: dst.ID, Name: "copy.pdf"})
		if err != nil {
			t.Fatal(err)
		}
		return file, copied
	}

	gone, ingested := clone("h-source-gone")
	if _, err := s.pool.Exec(ctx, `DELETE FROM rag_file_contents WHERE file_id=$1`, gone.ID); err != nil {
		t.Fatal(err)
	}
	// A same-content upload into the target took the claim and finished.
	_, taken := clone("h-claim-taken")
	if _, err := s.pool.Exec(ctx, `UPDATE rag_contents SET claim_job_id=NULL, status='ready'
		WHERE workspace_id=$1 AND status='processing'`, taken.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	_, ended := clone("h-target-gone")
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, ended.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	runIndexCopies(t, s)

	var jobType string
	if err := s.pool.QueryRow(ctx, `SELECT type FROM jobs WHERE payload->>'fileId'=$1 AND status='pending'`, ingested.ID).Scan(&jobType); err != nil {
		t.Fatalf("no ingest queued for the copy whose source went: %v", err)
	}
	if got, err := s.GetFile(ctx, taken.ID); err != nil || got.Status != FileReady || !got.Indexed {
		t.Fatalf("copy whose claim was taken = %+v (%v), want served by the ready content", got, err)
	}
	var leftover int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM rag_contents WHERE status='processing'`).Scan(&leftover); err != nil || leftover != 0 {
		t.Fatalf("claimed copies left = %d (%v), want none", leftover, err)
	}
}

// A clone's edits publish once its index has copied (Epo 2026-10-28, D4):
// a refresh request waits while the copy job is queued, then goes through.
func TestCloneEditsPublishOnceItsIndexCopied(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_copy_publish")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "edited")
	job := uid("job")
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1, 'index_copy', jsonb_build_object('fileId', $2::text, 'fileIds', jsonb_build_array($2::text)))`,
		job, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestSourceRefresh(ctx, owner, file.ID, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("refresh while copying = %v, want a conflict", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='done' WHERE id=$1`, job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
		t.Fatalf("refresh after the copy: %v", err)
	}
}
