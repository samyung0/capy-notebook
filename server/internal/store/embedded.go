package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/copytext"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Embedded materials are quiz and flashcards rows referenced from a note by a
// material_ref block. The note owns their lifecycle: they share its workspace,
// stay private and unfiled, follow it through trash, restore, purge and clone,
// and are trashed when their reference leaves the note.

// EmbeddedDraft is the authored content of a quiz or flashcard set inserted
// into a note; card ids are minted here.
type EmbeddedDraft struct {
	Kind         MaterialKind
	Questions    json.RawMessage
	TimeLimitMin *int
	Cards        [][2]string
}

// CreateEmbeddedMaterial creates a quiz or flashcard set under noteID with a
// default "<note title> · Quiz" title. The caller has checked edit access on
// the note; ownership and quota resolve exactly like any material in the same
// place.
func (s *Store) CreateEmbeddedMaterial(
	ctx context.Context,
	actorID, noteID string,
	draft EmbeddedDraft,
) (Material, error) {
	var content string
	var err error
	switch draft.Kind {
	case "quiz":
		content, err = materialdoc.QuizDocument(draft.Questions, draft.TimeLimitMin)
	case "flashcards":
		cards := make([]materialdoc.Card, len(draft.Cards))
		for i, card := range draft.Cards {
			cards[i] = materialdoc.Card{ID: uid("c"), Front: card[0], Back: card[1]}
		}
		content, err = materialdoc.FlashcardsDocument(cards)
	default:
		return Material{}, ErrNotFound
	}
	if err != nil {
		return Material{}, err
	}
	var parentTitle, workspaceID, workspaceName, locale string
	err = s.pool.QueryRow(ctx, `SELECT m.title, COALESCE(m.workspace_id,''), m.workspace_name,
			COALESCE((SELECT locale FROM users WHERE id=$2),'')
		FROM materials m
		WHERE m.id=$1 AND m.kind='note' AND m.parent_material_id IS NULL AND m.trashed_at IS NULL`,
		noteID, actorID).Scan(&parentTitle, &workspaceID, &workspaceName, &locale)
	if isNoRows(err) {
		return Material{}, ErrNotFound
	}
	if err != nil {
		return Material{}, err
	}
	suffix := copytext.EmbeddedQuiz
	if draft.Kind == "flashcards" {
		suffix = copytext.EmbeddedFlashcards
	}
	title, err := s.DisambiguateMaterialTitle(ctx, workspaceID, parentTitle+" · "+copytext.T(locale, suffix))
	if err != nil {
		return Material{}, err
	}
	return s.CreateMaterial(ctx, Material{
		CreatedBy: actorID, WorkspaceID: workspaceID, WorkspaceName: workspaceName,
		Kind: draft.Kind, Title: title, Content: content, Privacy: "private",
		ParentMaterialID: noteID,
	})
}

// reconcileEmbeddedTx aligns the note's embedded rows with the references in
// its projected content. A row is first noted as referenced (reference_seen_at)
// and from then on follows its block: a referenced row that was trashed comes
// back (undo of a block removal), an unreferenced row is trashed. A row no
// projection has referenced yet is still being inserted and is left alone.
func reconcileEmbeddedTx(ctx context.Context, tx pgx.Tx, noteID, content, actorID string) error {
	refs, err := materialdoc.ExtractMaterialRefs(content)
	if err != nil {
		return err
	}
	referenced := make(map[string]bool, len(refs))
	for _, ref := range refs {
		referenced[ref.MaterialID] = true
	}
	rows, err := tx.Query(ctx, `SELECT id, trashed_at IS NOT NULL, reference_seen_at IS NOT NULL
		FROM materials WHERE parent_material_id=$1 FOR UPDATE`, noteID)
	if err != nil {
		return err
	}
	var seen, restore, trash []string
	for rows.Next() {
		var id string
		var trashed, wasSeen bool
		if err := rows.Scan(&id, &trashed, &wasSeen); err != nil {
			rows.Close()
			return err
		}
		switch {
		case referenced[id] && !wasSeen:
			seen = append(seen, id)
		case referenced[id] && trashed:
			restore = append(restore, id)
		case !referenced[id] && !trashed && wasSeen:
			trash = append(trash, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(seen) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE materials SET reference_seen_at=now() WHERE id = ANY($1)`, seen); err != nil {
			return err
		}
	}
	for _, id := range restore {
		if err := restoreEmbeddedRowTx(ctx, tx, id); err != nil {
			return err
		}
	}
	for _, id := range trash {
		if err := trashEmbeddedRowTx(ctx, tx, id, actorID, uid("trash")); err != nil {
			return err
		}
	}
	return nil
}

func trashEmbeddedRowTx(ctx context.Context, tx pgx.Tx, id, actorID, episode string) error {
	if _, err := tx.Exec(ctx, `UPDATE materials SET trashed_at=now(), trashed_by=$2, trash_episode_id=$3,
		purge_after=now() + interval '30 days'
		WHERE id=$1 AND trashed_at IS NULL`, id, nullStr(actorID), episode); err != nil {
		return err
	}
	return invalidateEditInversesTx(ctx, tx, agenttools.KindMaterial, id, "trashed")
}

// restoreEmbeddedRowTx reopens a trashed embedded row under a fresh
// collaboration incarnation, like RestoreTrashed does for any material.
func restoreEmbeddedRowTx(ctx context.Context, tx pgx.Tx, id string) error {
	if _, err := tx.Exec(ctx, `UPDATE materials SET trashed_at=NULL, trashed_by=NULL, trash_episode_id=NULL,
		purge_after=NULL, trash_restores=trash_restores+1 WHERE id=$1 AND trashed_at IS NOT NULL`, id); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE material_yjs_documents SET room_schema=room_schema+1, updated_at=now()
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
		if err := trashEmbeddedRowTx(ctx, tx, id, actorID, episode); err != nil {
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
