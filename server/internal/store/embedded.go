package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Embedded materials are quiz and flashcards rows referenced from a note by a
// material_ref block. The note owns their lifecycle: they share its workspace,
// stay private and unfiled, follow it through trash, restore, purge and clone,
// and are trashed when their reference leaves the note. Their stored name is
// a random UUID that is never displayed (embeddedName), so it never collides
// with the workspace's unique titles.

// embeddedName is the stored name of a new or copied embedded row.
func embeddedName() string { return uuid.NewString() }

// EmbeddedDraft is the authored content of a quiz or flashcard set inserted
// into a note; card ids are minted here. ID is set only when the note and its
// embedded rows are created together (an agent note). Provenance is what an
// agent wrote the item from, recorded on the item itself.
type EmbeddedDraft struct {
	ID           string
	Kind         MaterialKind
	Questions    json.RawMessage
	TimeLimitMin *int
	Cards        [][2]string
	Provenance   *Provenance
}

// CreateEmbeddedMaterial creates a quiz or flashcard set under noteID. The caller has checked edit access on
// the note; ownership and quota resolve exactly like any material in the same
// place.
func (s *Store) CreateEmbeddedMaterial(
	ctx context.Context,
	actorID, noteID string,
	draft EmbeddedDraft,
) (Material, error) {
	content, err := draft.content()
	if err != nil {
		return Material{}, err
	}
	var workspaceID, workspaceName string
	err = s.pool.QueryRow(ctx, `SELECT COALESCE(m.workspace_id,''), m.workspace_name
		FROM materials m
		WHERE m.id=$1 AND m.kind='note' AND m.parent_material_id IS NULL AND m.trashed_at IS NULL`,
		noteID).Scan(&workspaceID, &workspaceName)
	if isNoRows(err) {
		return Material{}, ErrNotFound
	}
	if err != nil {
		return Material{}, err
	}
	return s.CreateMaterial(ctx, Material{
		ID: draft.ID, CreatedBy: actorID, WorkspaceID: workspaceID, WorkspaceName: workspaceName,
		Kind: draft.Kind, Title: embeddedName(), Content: content, Privacy: "private",
		ParentMaterialID: noteID, Provenance: draft.Provenance,
	})
}

// EnsureEmbeddedMaterial creates draft.ID under noteID unless it already
// exists there, so a retried agent edit does not create its rows twice.
func (s *Store) EnsureEmbeddedMaterial(ctx context.Context, actorID, noteID string, draft EmbeddedDraft) error {
	var parent string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(parent_material_id,'') FROM materials WHERE id=$1`, draft.ID).Scan(&parent)
	if err == nil {
		if parent != noteID {
			return ErrNotFound
		}
		return nil
	}
	if !isNoRows(err) {
		return err
	}
	_, err = s.CreateEmbeddedMaterial(ctx, actorID, noteID, draft)
	return err
}

// EmbeddedAdoption is one quiz or flashcard block pasted into a note: the
// material its reference names, and whether it needs a copy even of the
// note's own row (the same quiz is in another block of the note).
type EmbeddedAdoption struct {
	SourceID string
	Copy     bool
}

// AdoptEmbeddedMaterials makes each quiz or flashcard block pasted into noteID
// the note's own. It returns the note's material id per block, in order: the
// same id for the note's own row unless the block asks for a copy (restored
// when trashed), else a new
// embedded row with the source's questions or cards (fresh card ids) and
// copies of its images, without its attempts or review state. Each block
// asking gets its own copy. A source that is not an embedded quiz or
// flashcard set, or whose note the actor cannot read, gets "". A trashed
// source whose note is readable is copied: a cut's save may already have
// trashed it. Like CreateEmbeddedMaterial the caller has checked edit access
// on the note; a copy that does not fit the note's payer's quota gets "" and
// refused is true.
func (s *Store) AdoptEmbeddedMaterials(
	ctx context.Context,
	actorID, noteID string,
	blocks []EmbeddedAdoption,
) (adopted []string, refused bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	note := Material{ID: noteID}
	var noteProvenance []byte
	err = tx.QueryRow(ctx, `SELECT COALESCE(m.workspace_id,''), m.workspace_name, m.content, m.provenance
		FROM materials m
		WHERE m.id=$1 AND m.kind='note' AND m.parent_material_id IS NULL AND m.trashed_at IS NULL`,
		noteID).Scan(&note.WorkspaceID, &note.WorkspaceName, &note.Content, &noteProvenance)
	if isNoRows(err) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if note.Provenance, err = decodeProvenance(noteProvenance); err != nil {
		return nil, false, err
	}
	payerID, err := s.lockEditorAssetScopeTx(ctx, tx, note.WorkspaceID, noteID, actorID)
	if err != nil {
		return nil, false, err
	}
	sourceIDs := make([]string, len(blocks))
	for i, block := range blocks {
		sourceIDs[i] = block.SourceID
	}
	rows, err := tx.Query(ctx, `SELECT `+materialCols+` FROM materials WHERE id=ANY($1::text[])`, sourceIDs)
	if err != nil {
		return nil, false, err
	}
	sources := map[string]Material{}
	for rows.Next() {
		src, err := scanMaterial(rows)
		if err != nil {
			rows.Close()
			return nil, false, err
		}
		sources[src.ID] = src
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	adopted = make([]string, len(blocks))
	// The note's footer credits each copy, so a copy whose credits would put
	// two copyleft families in it is left out, as an agent write would be.
	var embeds, added []*Provenance
	loaded := false
	for i, block := range blocks {
		src, ok := sources[block.SourceID]
		if !ok || src.ParentMaterialID == "" || (src.Kind != "quiz" && src.Kind != "flashcards") {
			continue
		}
		if src.ParentMaterialID == noteID && !block.Copy {
			// Its block came back (undo, cut and paste): back out of the trash
			// at once, so the block loads it.
			if err := restoreEmbeddedRowTx(ctx, tx, src.ID); err != nil {
				return nil, false, err
			}
			adopted[i] = src.ID
			continue
		}
		// Through the parent: material access itself refuses a trashed row.
		if src.ParentMaterialID != noteID {
			if _, err := materialEffectiveAccess(ctx, tx, actorID, src.ParentMaterialID); errors.Is(err, ErrNotFound) {
				continue
			} else if err != nil {
				return nil, false, err
			}
		}
		if src.Provenance != nil {
			if !loaded {
				if embeds, err = embedSources(ctx, tx, noteID, note.Content); err != nil {
					return nil, false, err
				}
				loaded = true
			}
			if _, err := FooterLicence(note.Provenance, append(append(slices.Clone(embeds), added...), src.Provenance)); err != nil {
				continue
			}
		}
		// Each copy in a savepoint: one over the quota is left out (refused)
		// while the others land.
		copyTx, err := tx.Begin(ctx)
		if err != nil {
			return nil, false, err
		}
		id, err := s.copyEmbeddedTx(ctx, copyTx, actorID, payerID, note, src)
		var quota *QuotaExceededError
		if errors.As(err, &quota) {
			refused = true
			if err := copyTx.Rollback(ctx); err != nil {
				return nil, false, err
			}
			continue
		}
		if err != nil {
			return nil, false, err
		}
		if err := copyTx.Commit(ctx); err != nil {
			return nil, false, err
		}
		if src.Provenance != nil {
			added = append(added, src.Provenance)
		}
		adopted[i] = id
	}
	return adopted, refused, tx.Commit(ctx)
}

// copyEmbeddedTx copies src under note through the clone path: content with
// fresh card ids, its images under fresh ids charged to payerID.
func (s *Store) copyEmbeddedTx(
	ctx context.Context,
	tx pgx.Tx,
	actorID, payerID string,
	note, src Material,
) (string, error) {
	content := src.Content
	var err error
	if src.Kind == "flashcards" {
		if content, _, err = rewriteCardIDs("", content); err != nil {
			return "", err
		}
	}
	assets, assetIDs, assetBytes, err := snapshotStandaloneCloneAssets(ctx, tx, src, nil, []string{src.Content})
	if err != nil {
		return "", err
	}
	if content, err = materialdoc.RewriteClonedEditorAssetIDs(content, assetIDs); err != nil {
		return "", err
	}
	paths := make([]string, len(assets))
	for i, asset := range assets {
		paths[i] = asset.objectPath
	}
	if err := lockCloneBlobPathsTx(ctx, tx, paths); err != nil {
		return "", err
	}
	id, err := s.createMaterialTx(ctx, tx, Material{
		CreatedBy: actorID, WorkspaceID: note.WorkspaceID, WorkspaceName: note.WorkspaceName,
		Kind: src.Kind, Title: embeddedName(), Content: content, Privacy: "private", Color: src.Color,
		ParentMaterialID: note.ID,
	})
	if err != nil {
		return "", err
	}
	// The credits travel with the copy, outside the storage gate like any
	// clone's (createMaterialTx would count them).
	if src.Provenance != nil {
		provenance, err := json.Marshal(src.Provenance)
		if err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `UPDATE materials SET provenance=$2 WHERE id=$1`, id, provenance); err != nil {
			return "", err
		}
	}
	if err := s.gateStorageTx(ctx, tx, payerID, assetBytes); err != nil {
		return "", err
	}
	for _, asset := range assets {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, completed_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11,now())`,
			asset.newID, nullStr(note.WorkspaceID), id, payerID, actorID, asset.name, asset.purpose,
			asset.objectPath, asset.contentType, asset.sizeBytes, nullStr(asset.etag)); err != nil {
			return "", err
		}
	}
	return id, nil
}

func (draft EmbeddedDraft) content() (string, error) {
	switch draft.Kind {
	case "quiz":
		return materialdoc.QuizDocument(draft.Questions, draft.TimeLimitMin)
	case "flashcards":
		cards := make([]materialdoc.Card, len(draft.Cards))
		for i, card := range draft.Cards {
			cards[i] = materialdoc.Card{ID: uid("c"), Front: card[0], Back: card[1]}
		}
		return materialdoc.FlashcardsDocument(cards)
	}
	return "", ErrNotFound
}

// createEmbeddedTx creates a new note's embedded rows in the note's own
// transaction.
func (s *Store) createEmbeddedTx(ctx context.Context, tx pgx.Tx, note Material, drafts []EmbeddedDraft) error {
	for _, draft := range drafts {
		content, err := draft.content()
		if err != nil {
			return err
		}
		if _, err := s.createMaterialTx(ctx, tx, Material{
			ID: draft.ID, CreatedBy: note.CreatedBy, WorkspaceID: note.WorkspaceID,
			WorkspaceName: note.WorkspaceName, Kind: draft.Kind, Title: embeddedName(), Content: content,
			Privacy: "private", ParentMaterialID: note.ID, Provenance: draft.Provenance,
		}); err != nil {
			return err
		}
	}
	return nil
}

// EmbedSources reads the credits of the note's live embeds: its own quiz and
// flashcard rows that are not trashed and that content references, in the
// order content references them. A note is parsed only when one of its rows
// has credits.
func (s *Store) EmbedSources(ctx context.Context, noteID, content string) ([]*Provenance, error) {
	return embedSources(ctx, s.pool, noteID, content)
}

// CheckFooterLicence refuses a write that would put two copyleft families in a
// note's footer (FooterLicence): note's own record as the write leaves it, its
// live embeds' and the records the write adds to an embed. The code is the
// tool error code (lifecycle_rejected).
func (s *Store) CheckFooterLicence(ctx context.Context, note Material, added ...*Provenance) (string, error) {
	embeds, err := s.EmbedSources(ctx, note.ID, note.Content)
	if err != nil {
		return "", err
	}
	if _, err := FooterLicence(note.Provenance, append(embeds, added...)); err != nil {
		return "lifecycle_rejected", err
	}
	return "", nil
}

func embedSources(ctx context.Context, q rowsQueryer, noteID, content string) ([]*Provenance, error) {
	rows, err := q.Query(ctx, `SELECT id, provenance FROM materials
		WHERE parent_material_id=$1 AND trashed_at IS NULL AND provenance IS NOT NULL`, noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	credited := map[string]*Provenance{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		if credited[id], err = decodeProvenance(raw); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil || len(credited) == 0 {
		return nil, err
	}
	refs, err := materialdoc.ExtractMaterialRefs(content)
	if err != nil {
		return nil, err
	}
	sources := []*Provenance{}
	for _, ref := range refs {
		if p, ok := credited[ref.MaterialID]; ok {
			sources = append(sources, p)
			delete(credited, ref.MaterialID) // a row referenced twice counts once
		}
	}
	return sources, nil
}

// DiscardEmbeddedDrafts trashes the rows a refused agent edit created under
// noteID at once, rather than at the note's next save. A row the note's
// content already references (a retry of an edit that committed) is kept.
func (s *Store) DiscardEmbeddedDrafts(ctx context.Context, noteID string, ids []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var content string
	if err := tx.QueryRow(ctx, `SELECT content FROM materials WHERE id=$1 FOR UPDATE`, noteID).Scan(&content); err != nil {
		return err
	}
	refs, err := materialdoc.ExtractMaterialRefs(content)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM materials WHERE id = ANY($1) AND parent_material_id=$2
		AND trashed_at IS NULL FOR UPDATE`, ids, noteID)
	if err != nil {
		return err
	}
	live, err := scanIDs(rows)
	if err != nil {
		return err
	}
	referenced := make(map[string]bool, len(refs))
	for _, ref := range refs {
		referenced[ref.MaterialID] = true
	}
	for _, id := range live {
		if referenced[id] {
			continue
		}
		if err := trashEmbeddedRowTx(ctx, tx, id, "", uid("trash"), unreferencedRetention); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// reconcileEmbeddedTx aligns the note's embedded rows with the references in
// its new content (materialdoc's MaterialRefs), like pruneMaterialAssetsTx
// does for its assets: a
// referenced row that was trashed comes back (undo of a block removal), an
// unreferenced row created over 60 seconds ago is trashed. The minute lets a
// new row's block reach the note; a row whose block never lands (the tab
// closed, an undo before the save) goes at a later save.
func reconcileEmbeddedTx(ctx context.Context, tx pgx.Tx, noteID string, refs []materialdoc.MaterialRef, actorID string) error {
	referenced := make(map[string]bool, len(refs))
	for _, ref := range refs {
		referenced[ref.MaterialID] = true
	}
	rows, err := tx.Query(ctx, `SELECT id, trashed_at IS NOT NULL, created_at < now() - interval '60 seconds'
		FROM materials WHERE parent_material_id=$1 FOR UPDATE`, noteID)
	if err != nil {
		return err
	}
	var restore, trash []string
	for rows.Next() {
		var id string
		var trashed, settled bool
		if err := rows.Scan(&id, &trashed, &settled); err != nil {
			rows.Close()
			return err
		}
		switch {
		// Also a row a refused agent edit discarded before a retry of the
		// same call referenced it (DiscardEmbeddedDrafts).
		case referenced[id] && trashed:
			restore = append(restore, id)
		case !referenced[id] && !trashed && settled:
			trash = append(trash, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range restore {
		if err := restoreEmbeddedRowTx(ctx, tx, id); err != nil {
			return err
		}
	}
	for _, id := range trash {
		if err := trashEmbeddedRowTx(ctx, tx, id, actorID, uid("trash"), unreferencedRetention); err != nil {
			return err
		}
	}
	return nil
}

// Retention of an embedded row: one its note stopped referencing comes back
// within a day (undo, cut and paste, a replayed draft), one trashed with its
// note follows the note's 30 days.
const (
	unreferencedRetention = "1 day"
	withNoteRetention     = "30 days"
)

// trashEmbeddedRowTx trashes an embedded row, hidden from the trash listing,
// purged after retention unless a save references it again.
func trashEmbeddedRowTx(ctx context.Context, tx pgx.Tx, id, actorID, episode, retention string) error {
	if _, err := tx.Exec(ctx, `UPDATE materials SET trashed_at=now(), trashed_by=$2, trash_episode_id=$3,
		purge_after=now() + $4::interval
		WHERE id=$1 AND trashed_at IS NULL`, id, nullStr(actorID), episode, retention); err != nil {
		return err
	}
	return invalidateEditInversesTx(ctx, tx, agenttools.KindMaterial, id, "trashed")
}

// restoreEmbeddedRowTx reopens a trashed embedded row under a fresh
// collaboration incarnation, like RestoreTrashed does for any material. A row
// that is not trashed is left alone.
func restoreEmbeddedRowTx(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `UPDATE materials SET trashed_at=NULL, trashed_by=NULL, trash_episode_id=NULL,
		purge_after=NULL, trash_restores=trash_restores+1 WHERE id=$1 AND trashed_at IS NOT NULL`, id)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE material_yjs_documents SET room_schema=room_schema+1, updated_at=now()
		WHERE material_id=$1`, id)
	return err
}

// trashEmbeddedChildrenTx trashes a note's embedded rows in the note's own
// trash episode, so restoring the note brings exactly them back.
func trashEmbeddedChildrenTx(ctx context.Context, tx pgx.Tx, noteID, actorID, episode string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM materials WHERE parent_material_id=$1 AND trashed_at IS NULL`, noteID)
	if err != nil {
		return err
	}
	ids, err := scanIDs(rows)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := trashEmbeddedRowTx(ctx, tx, id, actorID, episode, withNoteRetention); err != nil {
			return err
		}
	}
	return nil
}

func restoreEmbeddedChildrenTx(ctx context.Context, tx pgx.Tx, noteID, episode string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM materials
		WHERE parent_material_id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL`, noteID, episode)
	if err != nil {
		return err
	}
	ids, err := scanIDs(rows)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := restoreEmbeddedRowTx(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

func scanIDs(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
