package store

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// TestCloneCost measures where a single file clone's time goes, for the
// bench/clone family (Epo 2026-10-27): the file row with its saved edits,
// which a clone needs to open, and the index copy, which could run as a
// tracked background step. Each part runs in its own transaction and rolls
// back, so every size is timed against the same fixture. A saved-edit log is
// timed as rows and as one folded state of the same bytes. Off unless
// CAPY_CLONE_BENCH=1; run through bench/clone/scripts/run.sh.
func TestCloneCost(t *testing.T) {
	if os.Getenv("CAPY_CLONE_BENCH") != "1" {
		t.Skip("set CAPY_CLONE_BENCH=1 (bench/clone/scripts/run.sh)")
	}
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_clone_cost")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}

	const runs = 3
	median := func(f func() error) time.Duration {
		var times []time.Duration
		for range runs {
			start := time.Now()
			if err := f(); err != nil {
				t.Fatal(err)
			}
			times = append(times, time.Since(start))
		}
		slices.Sort(times)
		return times[len(times)/2]
	}
	rolledBack := func(f func(ctx context.Context, tx pgx.Tx) error) func() error {
		return func() error {
			tx, err := s.pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			return f(ctx, tx)
		}
	}

	// Index copy: chunks with 2560-d vectors into the target's HNSW index.
	for _, chunks := range []int{500, 2000, 5000} {
		file := uploadWorkspaceFile(t, s, owner, src.ID)
		content := indexFile(t, s, file.ID, src.ID, owner, src.ID, fmt.Sprintf("h-cost-%d", chunks))
		if _, err := s.pool.Exec(ctx, `INSERT INTO rag_chunks (id, workspace_id, content_id, chunk_idx, text, indexed_text, lang, token_count)
			SELECT $1 || '_' || g, $2, $1, g, repeat('word ', 120), repeat('word ', 120), 'en', 160
			FROM generate_series(0, $3 - 1) g`, content, src.ID, chunks); err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, `INSERT INTO rag_chunk_vectors_2560 (chunk_id, workspace_id, embedding)
			SELECT c.id, c.workspace_id,
				(SELECT array_agg(random()::real) FROM generate_series(1, 2560) WHERE c.id IS NOT NULL)::vector::halfvec
			FROM rag_chunks c WHERE c.content_id=$1`, content); err != nil {
			t.Fatal(err)
		}
		var pin workspaceEmbedding
		if err := s.pool.QueryRow(ctx, `SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim
			FROM workspaces WHERE id=$1`, dst.ID).Scan(&pin.Pin.ProviderSlug, &pin.Pin.ModelSlug, &pin.Pin.Version, &pin.Dim); err != nil {
			t.Fatal(err)
		}
		d := median(rolledBack(func(ctx context.Context, tx pgx.Tx) error {
			return copyRetrievalContents(ctx, tx, dst.ID, pin.Pin, map[string]string{content: uid("rgc")})
		}))
		t.Logf("CLONECOST index chunks=%d copy=%s per_chunk=%s", chunks, d, d/time.Duration(chunks))
	}

	// File row and saved edits: the log as rows, and folded into one state of
	// the same bytes.
	for _, c := range []struct {
		name      string
		rows      int
		rowBytes  int
		stateSize int
	}{
		{"light text", 200, 2 << 10, 256 << 10},
		{"busy text", 2000, 2 << 10, 1 << 20},
		{"office", 300, 48 << 10, 4 << 20},
		{"heavy office", 1200, 48 << 10, 12 << 20},
	} {
		for _, folded := range []bool{false, true} {
			file := uploadWorkspaceFile(t, s, owner, src.ID)
			state := make([]byte, c.stateSize)
			if _, err := rand.Read(state); err != nil {
				t.Fatal(err)
			}
			rows, rowBytes := c.rows, c.rowBytes
			if folded {
				rows, rowBytes = 1, c.rows*c.rowBytes
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO source_documents (user_id, file_id, format, checkpoint, base_revision, base_blob_path, state)
				SELECT user_id, id, 'text', $2, revision, blob_path, $3 FROM files WHERE id=$1`, file.ID, rows, state); err != nil {
				t.Fatal(err)
			}
			// Random bytes, so TOAST compression does not shrink them as it
			// would not shrink a real Yjs update much either.
			updates := make([][]byte, rows)
			for i := range updates {
				updates[i] = make([]byte, rowBytes)
				if _, err := rand.Read(updates[i]); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO source_document_updates (file_id, epoch, checkpoint, update)
				SELECT $1, 1, g, u FROM unnest($2::bytea[]) WITH ORDINALITY AS t(u, g)`, file.ID, updates); err != nil {
				t.Fatal(err)
			}
			d := median(rolledBack(func(ctx context.Context, tx pgx.Tx) error {
				files, err := snapshotCloneFilesTx(ctx, tx, `f.id=$1`, file.ID)
				if err != nil || len(files) == 0 {
					return fmt.Errorf("snapshot: %v (%d)", err, len(files))
				}
				_, err = insertCloneFileTx(ctx, tx, files[0], uid("f"), dst.ID, owner, nil, "copy", time.Now().UnixMicro())
				return err
			}))
			log := float64(c.rows*c.rowBytes+c.stateSize) / (1 << 20)
			t.Logf("CLONECOST edits case=%q folded=%t rows=%d log_mib=%.1f row_copy=%s", c.name, folded, rows, log, d)
		}
	}
}
