package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Workspace notes are indexed for retrieval like files. Projection marks a
// note dirty when its content changes, or an embedded item's does (see
// ProjectMaterialContent and UpdateMaterial); the collaboration scheduler calls RequestMaterialIndex for
// dirty notes that have been idle; the ingest worker fetches the note's text
// through MaterialIndexText and writes rag_material_contents. When the job
// ends, the trigger on jobs (migrations 0082, 0083, 0098) clears index_job_id:
// a job that failed with no edit since admission counts an index failure and
// leaves the note due; the third parks it (dirty, index_error) until its next
// edit (Epo 2026-10-20), and an edit made while the job ran keeps it due.
// Standalone notes have no workspace and are never indexed.

// noteIndexDirtySQL is the SET fragment a content write appends: a workspace
// note becomes dirty (keeping an earlier dirty mark) and forgets its last
// index failures (migration 0098), so the next scheduler pass retries, and
// its pending tokens and changes are measured again (Q415).
const noteIndexDirtySQL = `index_dirty_at=CASE WHEN kind='note' AND workspace_id IS NOT NULL
	THEN COALESCE(index_dirty_at, now()) END, index_error=NULL, pending_tokens=NULL, index_failures=0,
	effects_cache=NULL`

// A dirty note is reindexed once its change since the last index reaches
// NoteIndexTokens net tokens, or once it has been dirty for NoteIndexStale
// (Epo 2026-10-17, subject to testing); the scheduler adds its idle wait.
// IMPORTANT: KEEP IN SYNC WITH NOTE_INDEX_SQL IN collaboration-rs/crates/sources/src/refresh.rs
const (
	NoteIndexTokens = 1000
	NoteIndexStale  = 10 * time.Minute
)

// MaterialIndexText is what the ingest worker chunks for a note: its text
// and the same text per top-level block (Text joins Blocks). The worker
// stores Blocks as the note's indexed_blocks when the job ends: the baseline
// note effects compare against.
type MaterialIndexText struct {
	ID       string                  `json:"id"`
	Title    string                  `json:"title"`
	Revision int64                   `json:"revision"`
	Text     string                  `json:"text"`
	Blocks   []materialdoc.NoteBlock `json:"blocks"`
}

// MaterialIndexText renders an active note of the given workspace for
// indexing, with its embedded quizzes and flashcard sets at their
// references; the workspace binds the internal caller to its own scope.
func (s *Store) MaterialIndexText(ctx context.Context, materialID, workspaceID string) (MaterialIndexText, error) {
	var out MaterialIndexText
	var content string
	err := s.pool.QueryRow(ctx, `SELECT id, title, revision, content FROM materials
		WHERE id=$1 AND workspace_id=$2 AND kind='note' AND trashed_at IS NULL`, materialID, workspaceID).
		Scan(&out.ID, &out.Title, &out.Revision, &content)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	items, err := noteItemContents(ctx, s.pool, materialID, workspaceID)
	if err != nil {
		return out, err
	}
	if out.Blocks, err = materialdoc.ExtractNoteBlocks(content, items); err != nil {
		return out, err
	}
	out.Text = materialdoc.JoinNoteBlocks(out.Blocks)
	return out, nil
}

// noteBlocks are a note's index blocks now and at its last index
// (indexed_blocks; none when it was never indexed).
func noteBlocks(ctx context.Context, q rowsQueryer, materialID, workspaceID, content string, baseline []byte) (before, now []materialdoc.NoteBlock, err error) {
	items, err := noteItemContents(ctx, q, materialID, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	if now, err = materialdoc.ExtractNoteBlocks(content, items); err != nil {
		return nil, nil, err
	}
	if len(baseline) > 0 {
		if err := json.Unmarshal(baseline, &before); err != nil {
			return nil, nil, fmt.Errorf("indexed blocks of %s: %w", materialID, err)
		}
	}
	return before, now, nil
}

// noteEffectsFormat versions cached note changes (Q435): raise it when the
// index text or the note effects change, and every cached entry is read
// again.
const noteEffectsFormat = 1

// NotePending is one note's changes since its last index, for chat.
type NotePending struct {
	MaterialID string                   `json:"materialId"`
	Title      string                   `json:"title"`
	Revision   int64                    `json:"revision"`
	Changes    []materialdoc.NoteEffect `json:"changes"`
}

// NotePendingChanges reads the changes of the workspace's notes the index
// does not hold as they stand (dirty, being indexed or failed), from their
// stored content: the per-turn read of Epo 2026-10-17 (the live room comes
// later). A note's changes are computed once per revision and kept in its
// effects_cache (Q415): a cached note reads neither its content nor its
// baseline. materialIDs narrows the notes when not nil.
func (s *Store) NotePendingChanges(ctx context.Context, workspaceID string, materialIDs []string) ([]NotePending, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, title, revision, xmin::text, cached,
			CASE WHEN cached IS NULL THEN content END, CASE WHEN cached IS NULL THEN indexed_blocks END
		FROM (SELECT *, xmin, CASE WHEN effects_cache->'at'=jsonb_build_object('revision', revision, 'format', $3::int)
				THEN effects_cache->'effects' END AS cached
			FROM materials
			WHERE workspace_id=$1 AND kind='note' AND trashed_at IS NULL
			  AND (index_dirty_at IS NOT NULL OR index_job_id IS NOT NULL OR index_error IS NOT NULL)
			  AND ($2::text[] IS NULL OR id=ANY($2::text[]))) m
		ORDER BY id`, workspaceID, materialIDs, noteEffectsFormat)
	if err != nil {
		return nil, err
	}
	type note struct {
		pending  NotePending
		xmin     string
		cached   []byte
		content  *string
		baseline []byte
	}
	var notes []note
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.pending.MaterialID, &n.pending.Title, &n.pending.Revision, &n.xmin, &n.cached,
			&n.content, &n.baseline); err != nil {
			rows.Close()
			return nil, err
		}
		notes = append(notes, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []NotePending{}
	for _, n := range notes {
		if n.cached != nil {
			err := json.Unmarshal(n.cached, &n.pending.Changes)
			if err == nil {
				if len(n.pending.Changes) > 0 {
					out = append(out, n.pending)
				}
				continue
			}
			// An entry that no longer decodes is a miss (Q435): the note is
			// read and its changes computed again.
			obs.Log(ctx).Warn("note changes cache unreadable", "material_id", n.pending.MaterialID, "error", err)
			n.pending.Changes = nil
			if err := s.pool.QueryRow(ctx, `SELECT content, indexed_blocks FROM materials WHERE id=$1`,
				n.pending.MaterialID).Scan(&n.content, &n.baseline); err != nil {
				return nil, err
			}
		}
		before, now, err := noteBlocks(ctx, s.pool, n.pending.MaterialID, workspaceID, *n.content, n.baseline)
		if errors.Is(err, materialdoc.ErrInvalid) {
			// A stored note the rules refuse is unreadable: it gives no
			// changes, and the rest of the workspace still does.
			obs.Log(ctx).Warn("note changes skipped: content unreadable", "material_id", n.pending.MaterialID, "error", err)
			continue
		}
		if err != nil {
			return nil, err
		}
		n.pending.Changes, _ = materialdoc.NoteChanges(before, now)
		s.cacheNoteChanges(ctx, n.pending.MaterialID, n.pending.Revision, n.xmin, n.pending.Changes)
		if len(n.pending.Changes) > 0 {
			out = append(out, n.pending)
		}
	}
	return out, nil
}

// cacheNoteChanges keeps a note's changes for the revision they were
// computed at, unless its row changed since it was read (xmin): an embedded
// item's write and the index clear the cache without a new revision. A
// failed write is logged: the changes were computed and still answer (Q435).
func (s *Store) cacheNoteChanges(ctx context.Context, materialID string, revision int64, xmin string, changes []materialdoc.NoteEffect) {
	if changes == nil {
		changes = []materialdoc.NoteEffect{}
	}
	raw, err := json.Marshal(changes)
	if err == nil {
		_, err = s.pool.Exec(ctx, `UPDATE materials
			SET effects_cache=jsonb_build_object('at', jsonb_build_object('revision', revision, 'format', $5::int), 'effects', $4::jsonb)
			WHERE id=$1 AND revision=$2 AND xmin::text=$3`, materialID, revision, xmin, raw, noteEffectsFormat)
	}
	if err != nil {
		obs.Log(ctx).Warn("note changes cache write failed", "material_id", materialID, "error", err)
	}
}

// NoteChangeText is one note block's index text at the last index and now,
// for a data placeholder's resolve_source_change. Index text holds no answer
// keys (Epo 2026-10-18).
type NoteChangeText struct {
	Before string `json:"before"`
	After  string `json:"after"`
}

// ResolveNoteChange reads one block's text on both sides; a side without the
// block reads "".
func (s *Store) ResolveNoteChange(ctx context.Context, workspaceID, materialID, blockID string) (NoteChangeText, error) {
	var content string
	var baseline []byte
	err := s.pool.QueryRow(ctx, `SELECT content, indexed_blocks FROM materials
		WHERE id=$1 AND workspace_id=$2 AND kind='note' AND trashed_at IS NULL`, materialID, workspaceID).
		Scan(&content, &baseline)
	if isNoRows(err) {
		return NoteChangeText{}, ErrNotFound
	}
	if err != nil {
		return NoteChangeText{}, err
	}
	before, now, err := noteBlocks(ctx, s.pool, materialID, workspaceID, content, baseline)
	if err != nil {
		return NoteChangeText{}, err
	}
	var out NoteChangeText
	found := false
	for _, block := range before {
		if block.ID == blockID {
			out.Before, found = block.Text, true
		}
	}
	for _, block := range now {
		if block.ID == blockID {
			out.After, found = block.Text, true
		}
	}
	if !found || blockID == "" {
		return NoteChangeText{}, ErrNotFound
	}
	return out, nil
}

// noteItemContents are the stored contents of a note's active embedded
// items by id; the extraction reads those the note references.
func noteItemContents(ctx context.Context, q rowsQueryer, noteID, workspaceID string) (map[string]string, error) {
	rows, err := q.Query(ctx, `SELECT id, content FROM materials
		WHERE parent_material_id=$1 AND workspace_id=$2 AND trashed_at IS NULL`, noteID, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := map[string]string{}
	for rows.Next() {
		var id, content string
		if err := rows.Scan(&id, &content); err != nil {
			return nil, err
		}
		items[id] = content
	}
	return items, rows.Err()
}

// markParentNoteDirtyTx marks the note an item is embedded in dirty, with
// the rule its own content writes use: the item's text is part of the
// note's index text. A note's projection takes the workspace (or account)
// lock before its children's rows, as an item's write does, so the two
// never wait on each other's rows.
func markParentNoteDirtyTx(ctx context.Context, tx pgx.Tx, itemID string) error {
	_, err := tx.Exec(ctx, `UPDATE materials SET `+noteIndexDirtySQL+`
		WHERE id=(SELECT parent_material_id FROM materials WHERE id=$1) AND trashed_at IS NULL`, itemID)
	return err
}

// measureNoteChange is the net tokens of a dirty note's change since its
// last index when admission must measure them (not stale, not measured since
// its last content write), with the revision they were measured at; nil
// otherwise. An embedded item's write clears the measure without a new
// revision, so one landing mid-measure can leave an older count until the
// note goes stale.
func (s *Store) measureNoteChange(ctx context.Context, materialID string) (*int64, int64, error) {
	var workspaceID, xmin string
	var revision int64
	var content *string
	var baseline []byte
	err := s.pool.QueryRow(ctx, `SELECT workspace_id, revision, xmin::text,
			CASE WHEN due THEN content END, CASE WHEN due THEN indexed_blocks END
		FROM (SELECT *, xmin, index_dirty_at IS NOT NULL AND pending_tokens IS NULL
				AND index_dirty_at >= now()-make_interval(secs => $2) AS due
			FROM materials
			WHERE id=$1 AND kind='note' AND workspace_id IS NOT NULL AND trashed_at IS NULL) m`,
		materialID, NoteIndexStale.Seconds()).Scan(&workspaceID, &revision, &xmin, &content, &baseline)
	if isNoRows(err) {
		return nil, 0, ErrNotFound
	}
	if err != nil || content == nil {
		return nil, 0, err
	}
	before, now, err := noteBlocks(ctx, s.pool, materialID, workspaceID, *content, baseline)
	if err != nil {
		return nil, 0, err
	}
	// The changes it computes are the next read's (Q415).
	changes, tokens := materialdoc.NoteChanges(before, now)
	s.cacheNoteChanges(ctx, materialID, revision, xmin, changes)
	return &tokens, revision, nil
}

// RequestMaterialIndex turns a dirty, idle, not yet queued workspace note into
// one ingest job paid by the workspace owner. ErrConflict means the note is
// not due: the scheduler treats it as a skip, not a failure.
func (s *Store) RequestMaterialIndex(ctx context.Context, materialID string) (string, error) {
	// The measure runs before the workspace and account locks: a large
	// note's diff would hold them. A stored note the rules refuse fails here
	// with materialdoc.ErrInvalid (a 422 that parks it).
	measured, measuredRevision, err := s.measureNoteChange(ctx, materialID)
	if err != nil {
		return "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// Workspace, owner account, then material: the order every workspace write
	// and projection takes. Locking the material (or the account) first
	// deadlocked against them.
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM materials
		WHERE id=$1 AND kind='note' AND workspace_id IS NOT NULL AND trashed_at IS NULL`, materialID).
		Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, workspaceID, "")
	if err != nil {
		return "", err
	}
	var autoProcess, dirty, stale bool
	var runningJob, indexError *string
	var revision int64
	var pendingTokens *int64
	if err := tx.QueryRow(ctx, `SELECT w.auto_process, m.index_dirty_at IS NOT NULL,
			COALESCE(m.index_dirty_at < now()-make_interval(secs => $3), false),
			m.index_job_id, m.index_error, m.revision, m.pending_tokens
		FROM materials m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.id=$1 AND m.workspace_id=$2 AND m.kind='note' AND m.trashed_at IS NULL FOR UPDATE OF m`,
		materialID, workspaceID, NoteIndexStale.Seconds()).
		Scan(&autoProcess, &dirty, &stale, &runningJob, &indexError, &revision, &pendingTokens); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if !autoProcess || !dirty || runningJob != nil || indexError != nil {
		return "", ErrConflict
	}
	// A small change is not due until it goes stale. Its measure is kept
	// until the next content write clears it, so the scheduler skips the
	// note meanwhile instead of measuring it again.
	if !stale {
		if pendingTokens == nil {
			// Written since the measure: not due now, measured on the next pass.
			if measured == nil || measuredRevision != revision {
				return "", ErrConflict
			}
			if _, err := tx.Exec(ctx, `UPDATE materials SET pending_tokens=$2 WHERE id=$1`, materialID, *measured); err != nil {
				return "", err
			}
			pendingTokens = measured
		}
		if *pendingTokens < NoteIndexTokens {
			if err := tx.Commit(ctx); err != nil {
				return "", err
			}
			return "", ErrConflict
		}
	}
	jobID, err := s.queueNoteIndexTx(ctx, tx, ownerID, workspaceID, materialID, revision, true)
	if err != nil {
		return "", err
	}
	return jobID, tx.Commit(ctx)
}

// ProcessNoteChanges is a note's Process in the Indexing tab: it queues the
// note's index job now, whatever its threshold or the auto process switch
// (Epo 2026-10-21), also for a note parked after failed jobs. Owner-only and
// paid by the owner, like a file's Process. ErrProcessingStarted means a job
// is already queued or running; ErrNothingToProcess, that the index is current.
func (s *Store) ProcessNoteChanges(ctx context.Context, actor, materialID string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM materials
		WHERE id=$1 AND kind='note' AND workspace_id IS NOT NULL AND trashed_at IS NULL`, materialID).
		Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	// Workspace, accounts, then material, as RequestMaterialIndex.
	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actor)
	if err != nil {
		return "", err
	}
	if actor != ownerID {
		return "", ErrForbidden
	}
	var dirty, queued bool
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT index_dirty_at IS NOT NULL, index_job_id IS NOT NULL, revision
		FROM materials WHERE id=$1 AND workspace_id=$2 AND kind='note' AND trashed_at IS NULL FOR UPDATE`,
		materialID, workspaceID).Scan(&dirty, &queued, &revision); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if queued {
		return "", ErrProcessingStarted
	}
	if !dirty {
		return "", ErrNothingToProcess
	}
	jobID, err := s.queueNoteIndexTx(ctx, tx, ownerID, workspaceID, materialID, revision, false)
	if err != nil {
		return "", err
	}
	return jobID, tx.Commit(ctx)
}

// queueNoteIndexTx reserves ingest credits on the workspace owner and queues
// the note's index job. Admission clears the dirty mark and any parked
// error; a failed job sets them again (release_note_index_job).
func (s *Store) queueNoteIndexTx(ctx context.Context, tx pgx.Tx, ownerID, workspaceID, materialID string, revision int64, automatic bool) (string, error) {
	reservation, err := s.beginIngestSpendTx(ctx, tx, ownerID, workspaceID)
	if err != nil {
		return "", err
	}
	payload, err := s.ingestJobPayload(ctx, tx, ownerID, map[string]any{
		"materialId": materialID, "workspaceId": workspaceID, "revision": revision,
		"reservationId": reservation, "automatic": automatic,
	})
	if err != nil {
		return "", err
	}
	jobID := uid("job")
	if _, err := tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,'ingest',$2)`, jobID, payload); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET index_job_id=$2, index_dirty_at=NULL, index_error=NULL WHERE id=$1`,
		materialID, jobID); err != nil {
		return "", err
	}
	return jobID, nil
}
