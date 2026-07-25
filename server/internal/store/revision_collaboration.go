package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/jackc/pgx/v5"
)

type SuggestionMutation struct {
	Material      Material
	SuggestionIDs []string
	Discussions   []Discussion
}

type CollaborationResource struct {
	MaterialID string
	UserID     string
	Kind       string
	Status     SuggestionStatus
}

const revisionSuggestionColumns = `s.id, s.discussion_id, s.plate_suggestion_id,
	s.commit_revision, s.resolution_revision, s.user_id, s.status, s.reviewed_by,
	s.reviewed_at, (s.deleted_at IS NOT NULL), s.created_at, s.updated_at`

func scanRevisionSuggestion(row pgx.Row) (MaterialSuggestion, error) {
	var suggestion MaterialSuggestion
	err := row.Scan(
		&suggestion.ID,
		&suggestion.DiscussionID,
		&suggestion.PlateSuggestionID,
		&suggestion.CommitRevision,
		&suggestion.ResolutionRevision,
		&suggestion.UserID,
		&suggestion.Status,
		&suggestion.ReviewedBy,
		&suggestion.ReviewedAt,
		&suggestion.IsDeleted,
		&suggestion.CreatedAt,
		&suggestion.UpdatedAt,
	)
	return suggestion, err
}

func scanRevisionComment(row pgx.Row) (Comment, error) {
	var comment Comment
	var content []byte
	err := row.Scan(
		&comment.ID,
		&comment.DiscussionID,
		&comment.ParentCommentID,
		&comment.UserID,
		&content,
		&comment.IsEdited,
		&comment.IsDeleted,
		&comment.CreatedAt,
		&comment.UpdatedAt,
	)
	if comment.IsDeleted {
		comment.ContentRich = json.RawMessage("null")
	} else {
		comment.ContentRich = json.RawMessage(content)
	}
	comment.Replies = []Comment{}
	return comment, err
}

func validateRichContent(content json.RawMessage) error {
	var value []map[string]any
	if err := json.Unmarshal(content, &value); err != nil {
		return fmt.Errorf("%w: %v", materialdoc.ErrInvalid, err)
	}
	return materialdoc.Validate(materialdoc.Envelope{
		SchemaVersion: materialdoc.SchemaVersion,
		Value:         value,
	})
}

func validateCommentAnchor(anchor map[string]any) error {
	anchorPoint, hasAnchor := anchor["anchor"]
	focusPoint, hasFocus := anchor["focus"]
	if !hasAnchor && !hasFocus {
		return nil
	}
	startPath, startOffset, startOK := slatePoint(anchorPoint)
	endPath, endOffset, endOK := slatePoint(focusPoint)
	if !hasAnchor || !hasFocus || !startOK || !endOK {
		return fmt.Errorf("%w: discussion anchor must contain valid anchor and focus points", materialdoc.ErrInvalid)
	}
	if startOffset != endOffset || len(startPath) != len(endPath) {
		return nil
	}
	for index := range startPath {
		if startPath[index] != endPath[index] {
			return nil
		}
	}
	return fmt.Errorf("%w: discussion anchor must not be collapsed", materialdoc.ErrInvalid)
}

func slatePoint(value any) ([]int, int, bool) {
	point, ok := value.(map[string]any)
	if !ok {
		return nil, 0, false
	}
	rawPath, ok := point["path"].([]any)
	if !ok || len(rawPath) == 0 {
		return nil, 0, false
	}
	path := make([]int, len(rawPath))
	for index, rawPart := range rawPath {
		part, ok := rawPart.(float64)
		if !ok || part < 0 || part != float64(int(part)) {
			return nil, 0, false
		}
		path[index] = int(part)
	}
	rawOffset, ok := point["offset"].(float64)
	if !ok || rawOffset < 0 || rawOffset != float64(int(rawOffset)) {
		return nil, 0, false
	}
	return path, int(rawOffset), true
}

// ListCollaborationDiscussions returns active parent threads with suggestion
// metadata and one-level comments nested under each root comment.
func (s *Store) ListCollaborationDiscussions(ctx context.Context, materialID string) ([]Discussion, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, material_id, kind, block_id, anchor,
		created_by, is_resolved, false, created_at, updated_at
		FROM material_discussions
		WHERE material_id=$1 AND deleted_at IS NULL
		ORDER BY created_at`, materialID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Discussion{}
	for rows.Next() {
		var discussion Discussion
		if err := rows.Scan(
			&discussion.ID,
			&discussion.MaterialID,
			&discussion.Kind,
			&discussion.BlockID,
			&discussion.Anchor,
			&discussion.CreatedBy,
			&discussion.IsResolved,
			&discussion.IsDeleted,
			&discussion.CreatedAt,
			&discussion.UpdatedAt,
		); err != nil {
			return nil, err
		}
		discussion.Suggestions, err = s.listDiscussionSuggestions(ctx, discussion.ID)
		if err != nil {
			return nil, err
		}
		discussion.Comments, err = s.listDiscussionComments(ctx, discussion.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, discussion)
	}
	return out, rows.Err()
}

func (s *Store) listDiscussionSuggestions(ctx context.Context, discussionID string) ([]MaterialSuggestion, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+revisionSuggestionColumns+`
		FROM material_suggestions s WHERE s.discussion_id=$1 ORDER BY s.created_at`, discussionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MaterialSuggestion{}
	for rows.Next() {
		suggestion, err := scanRevisionSuggestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, suggestion)
	}
	return out, rows.Err()
}

func (s *Store) listDiscussionComments(ctx context.Context, discussionID string) ([]Comment, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, discussion_id, parent_comment_id, user_id,
		content_rich, is_edited, (deleted_at IS NOT NULL), created_at, updated_at
		FROM material_comments WHERE discussion_id=$1
		ORDER BY created_at`, discussionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roots := []Comment{}
	replies := map[string][]Comment{}
	for rows.Next() {
		comment, err := scanRevisionComment(rows)
		if err != nil {
			return nil, err
		}
		if comment.ParentCommentID == nil {
			roots = append(roots, comment)
		} else {
			replies[*comment.ParentCommentID] = append(replies[*comment.ParentCommentID], comment)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range roots {
		roots[i].Replies = replies[roots[i].ID]
		if roots[i].Replies == nil {
			roots[i].Replies = []Comment{}
		}
	}
	return roots, nil
}

func (s *Store) CommitMaterialSuggestions(
	ctx context.Context,
	materialID, actorID, markedContent string,
	expectedRevision int64,
) (SuggestionMutation, error) {
	if expectedRevision < 1 {
		return SuggestionMutation{}, ErrConflict
	}
	changes, err := materialdoc.ScanSuggestions(markedContent)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if len(changes) == 0 {
		return SuggestionMutation{}, fmt.Errorf("%w: suggestion commit contains no suggestion metadata", materialdoc.ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SuggestionMutation{}, err
	}
	defer tx.Rollback(ctx)

	var kind, title, currentContent string
	var currentRevision int64
	err = tx.QueryRow(ctx, `SELECT kind, title, content, revision
		FROM materials WHERE id=$1 FOR UPDATE`, materialID).
		Scan(&kind, &title, &currentContent, &currentRevision)
	if isNoRows(err) {
		return SuggestionMutation{}, ErrNotFound
	}
	if err != nil {
		return SuggestionMutation{}, err
	}
	if currentRevision != expectedRevision {
		return SuggestionMutation{}, ErrConflict
	}
	if err := materialdoc.ValidateKind(markedContent, kind); err != nil {
		return SuggestionMutation{}, err
	}
	// SOURCE: The row lock and the two reject projections form one optimistic
	// concurrency boundary. The submitted marked head may extend existing
	// pending suggestions, but its clean base must remain byte-semantically
	// equivalent to the locked head's clean base. The pending-ID containment
	// check below separately prevents a commenter from silently resolving or
	// deleting someone else's review items.
	rejected, err := materialdoc.RejectProjection(markedContent)
	if err != nil {
		return SuggestionMutation{}, err
	}
	currentRejected, err := materialdoc.RejectProjection(currentContent)
	if err != nil {
		return SuggestionMutation{}, err
	}
	equal, err := equivalentMaterialDocuments(currentRejected, rejected)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if !equal {
		return SuggestionMutation{}, fmt.Errorf("%w: suggestion reject projection differs from current review base", ErrConflict)
	}
	currentChanges, err := materialdoc.ScanSuggestions(currentContent)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if !containsAllSuggestionIDs(uniquePlateSuggestionIDs(changes), uniquePlateSuggestionIDs(currentChanges)) {
		return SuggestionMutation{}, fmt.Errorf("%w: suggestion commit removed pending review IDs", ErrConflict)
	}

	revision := currentRevision + 1
	ids := uniquePlateSuggestionIDs(changes)
	metadata := encodeEventMetadata(map[string]any{"suggestionIds": ids})
	if _, err := tx.Exec(ctx, `UPDATE materials
		SET content=$2, revision=$3, has_pending_suggestions=true,
		    updated_at=now(), updated_by=$4
		WHERE id=$1`, materialID, json.RawMessage(markedContent), revision, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_revisions
		(material_id, revision, parent_revision, event_type, title, content,
		 has_pending_suggestions, event_metadata, created_by)
		VALUES ($1,$2,$3,'suggestion_commit',$4,$5,true,$6,$7)`,
		materialID, revision, currentRevision, title, json.RawMessage(markedContent), metadata, actorID); err != nil {
		return SuggestionMutation{}, err
	}

	type existingSuggestion struct {
		ID      string
		PlateID string
		BlockID string
	}
	existingByPair := map[string]existingSuggestion{}
	rows, err := tx.Query(ctx, `SELECT s.id, s.plate_suggestion_id,
		d.block_id
		FROM material_suggestions s
		JOIN material_discussions d ON d.id=s.discussion_id
		WHERE d.material_id=$1 AND d.deleted_at IS NULL
		  AND s.status='pending' AND s.deleted_at IS NULL
		  AND s.plate_suggestion_id = ANY($2)
		ORDER BY s.created_at`, materialID, ids)
	if err != nil {
		return SuggestionMutation{}, err
	}
	for rows.Next() {
		var existing existingSuggestion
		if err := rows.Scan(&existing.ID, &existing.PlateID, &existing.BlockID); err != nil {
			rows.Close()
			return SuggestionMutation{}, err
		}
		existingByPair[suggestionPairKey(existing.PlateID, existing.BlockID)] = existing
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SuggestionMutation{}, err
	}
	rows.Close()

	existingUpdates := map[string]bool{}
	newChanges := make([]materialdoc.SuggestionChange, 0, len(changes))
	for _, change := range changes {
		existing, found := existingByPair[suggestionPairKey(change.PlateSuggestionID, change.BlockID)]
		if found {
			existingUpdates[existing.ID] = true
			continue
		}
		newChanges = append(newChanges, change)
	}
	for suggestionID := range existingUpdates {
		if _, err := tx.Exec(ctx, `UPDATE material_suggestions
			SET updated_at=now()
			WHERE id=$1 AND status='pending' AND deleted_at IS NULL`,
			suggestionID); err != nil {
			return SuggestionMutation{}, err
		}
	}
	for _, change := range newChanges {
		discussionID := uid("disc")
		anchor := encodeEventMetadata(map[string]any{"blockId": change.BlockID})
		if _, err := tx.Exec(ctx, `INSERT INTO material_discussions
			(id, material_id, kind, block_id, anchor, created_by)
			VALUES ($1,$2,'suggestion',$3,$4,$5)`,
			discussionID, materialID, change.BlockID, anchor, actorID); err != nil {
			return SuggestionMutation{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO material_suggestions
			(id, discussion_id, plate_suggestion_id, commit_revision, user_id)
			VALUES ($1,$2,$3,$4,$5)`,
			uid("sug"), discussionID, change.PlateSuggestionID, revision, actorID); err != nil {
			return SuggestionMutation{}, err
		}
	}
	if kind == "flashcards" {
		cardIDs, err := flashcardIDs(markedContent)
		if err != nil {
			return SuggestionMutation{}, err
		}
		if err := syncCardStatsTx(ctx, tx, materialID, cardIDs); err != nil {
			return SuggestionMutation{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SuggestionMutation{}, err
	}
	return s.suggestionMutationResult(ctx, materialID, ids)
}

func (s *Store) ReviewMaterialSuggestions(
	ctx context.Context,
	materialID, actorID string,
	decision materialdoc.SuggestionDecision,
	suggestionIDs []string,
	expectedRevision int64,
) (SuggestionMutation, error) {
	return s.reviewMaterialSuggestions(
		ctx,
		materialID,
		actorID,
		decision,
		suggestionIDs,
		expectedRevision,
		false,
		"",
	)
}

func (s *Store) reviewMaterialSuggestions(
	ctx context.Context,
	materialID, actorID string,
	decision materialdoc.SuggestionDecision,
	suggestionIDs []string,
	expectedRevision int64,
	withdraw bool,
	deleteDiscussionID string,
) (SuggestionMutation, error) {
	if expectedRevision < 1 {
		return SuggestionMutation{}, ErrConflict
	}
	eventType := RevisionSuggestionAccept
	status := SuggestionAccepted
	if decision == materialdoc.RejectSuggestions {
		eventType = RevisionSuggestionReject
		status = SuggestionRejected
	} else if decision != materialdoc.AcceptSuggestions {
		return SuggestionMutation{}, fmt.Errorf("%w: invalid suggestion decision", materialdoc.ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SuggestionMutation{}, err
	}
	defer tx.Rollback(ctx)
	var kind, title, content string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT kind, title, content, revision
		FROM materials WHERE id=$1 FOR UPDATE`, materialID).
		Scan(&kind, &title, &content, &revision)
	if isNoRows(err) {
		return SuggestionMutation{}, ErrNotFound
	}
	if err != nil {
		return SuggestionMutation{}, err
	}
	if revision != expectedRevision {
		return SuggestionMutation{}, ErrConflict
	}
	// SOURCE: Resolve the Plate IDs from the locked document itself rather than
	// treating material_suggestions as authoritative. Relational rows are a
	// searchable projection and can be absent for legacy/raw Plate metadata;
	// the marked revision head is the source of truth. All document, revision,
	// projection-row, and discussion updates stay in this transaction.
	projected, resolvedIDs, pending, err := materialdoc.ResolveSuggestions(content, suggestionIDs, decision)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if len(resolvedIDs) == 0 || !containsAllSuggestionIDs(resolvedIDs, suggestionIDs) {
		return SuggestionMutation{}, ErrNotFound
	}
	if err := materialdoc.ValidateKind(projected, kind); err != nil {
		return SuggestionMutation{}, err
	}
	nextRevision := revision + 1
	metadata := encodeEventMetadata(map[string]any{
		"decision":      decision,
		"suggestionIds": resolvedIDs,
	})
	if _, err := tx.Exec(ctx, `UPDATE materials
		SET content=$2, revision=$3, has_pending_suggestions=$4,
		    updated_at=now(), updated_by=$5
		WHERE id=$1`, materialID, json.RawMessage(projected), nextRevision, pending, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_revisions
		(material_id, revision, parent_revision, event_type, title, content,
		 has_pending_suggestions, event_metadata, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		materialID, nextRevision, revision, eventType, title, json.RawMessage(projected),
		pending, metadata, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE material_suggestions s
		SET status=$3, resolution_revision=$4, reviewed_by=$5, reviewed_at=now(), updated_at=now()
		FROM material_discussions d
		WHERE s.discussion_id=d.id AND d.material_id=$1
		  AND s.plate_suggestion_id = ANY($2) AND s.status='pending'
		  AND s.deleted_at IS NULL`,
		materialID, resolvedIDs, status, nextRevision, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE material_discussions d
		SET is_resolved=NOT EXISTS (
			SELECT 1 FROM material_suggestions s
			WHERE s.discussion_id=d.id AND s.status='pending' AND s.deleted_at IS NULL
		), updated_at=now()
		WHERE d.material_id=$1 AND d.kind='suggestion' AND d.deleted_at IS NULL`, materialID); err != nil {
		return SuggestionMutation{}, err
	}
	if withdraw {
		if _, err := tx.Exec(ctx, `UPDATE material_suggestions s
			SET status='withdrawn', reviewed_by=NULL, reviewed_at=NULL,
			    deleted_at=now(), deleted_by=$3, updated_at=now()
			FROM material_discussions d
			WHERE s.discussion_id=d.id AND d.material_id=$1
			  AND s.plate_suggestion_id = ANY($2)
			  AND s.resolution_revision=$4`,
			materialID, resolvedIDs, actorID, nextRevision); err != nil {
			return SuggestionMutation{}, err
		}
	}
	if deleteDiscussionID != "" {
		if _, err := tx.Exec(ctx, `UPDATE material_discussions
			SET deleted_at=now(), deleted_by=$2, is_resolved=true, updated_at=now()
			WHERE id=$1 AND material_id=$3 AND deleted_at IS NULL`,
			deleteDiscussionID, actorID, materialID); err != nil {
			return SuggestionMutation{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE material_suggestions
			SET status=CASE WHEN resolution_revision=$3 THEN 'withdrawn' ELSE status END,
			    reviewed_by=CASE WHEN resolution_revision=$3 THEN NULL ELSE reviewed_by END,
			    reviewed_at=CASE WHEN resolution_revision=$3 THEN NULL ELSE reviewed_at END,
			    deleted_at=now(), deleted_by=$2, updated_at=now()
			WHERE discussion_id=$1 AND deleted_at IS NULL`,
			deleteDiscussionID, actorID, nextRevision); err != nil {
			return SuggestionMutation{}, err
		}
	}
	if kind == "flashcards" {
		cardIDs, err := flashcardIDs(projected)
		if err != nil {
			return SuggestionMutation{}, err
		}
		if err := syncCardStatsTx(ctx, tx, materialID, cardIDs); err != nil {
			return SuggestionMutation{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SuggestionMutation{}, err
	}
	return s.suggestionMutationResult(ctx, materialID, resolvedIDs)
}

func (s *Store) SuggestionResource(ctx context.Context, id string) (CollaborationResource, error) {
	var resource CollaborationResource
	err := s.pool.QueryRow(ctx, `SELECT d.material_id, s.user_id, d.kind, s.status
		FROM material_suggestions s
		JOIN material_discussions d ON d.id=s.discussion_id
		WHERE s.id=$1 AND s.deleted_at IS NULL AND d.deleted_at IS NULL`, id).
		Scan(&resource.MaterialID, &resource.UserID, &resource.Kind, &resource.Status)
	if isNoRows(err) {
		return CollaborationResource{}, ErrNotFound
	}
	return resource, err
}

func (s *Store) DiscussionResource(ctx context.Context, id string) (CollaborationResource, error) {
	var resource CollaborationResource
	err := s.pool.QueryRow(ctx, `SELECT material_id, created_by, kind
		FROM material_discussions WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&resource.MaterialID, &resource.UserID, &resource.Kind)
	if isNoRows(err) {
		return CollaborationResource{}, ErrNotFound
	}
	return resource, err
}

func (s *Store) CommentResource(ctx context.Context, id string) (CollaborationResource, error) {
	var resource CollaborationResource
	err := s.pool.QueryRow(ctx, `SELECT d.material_id, c.user_id, d.kind
		FROM material_comments c JOIN material_discussions d ON d.id=c.discussion_id
		WHERE c.id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`, id).
		Scan(&resource.MaterialID, &resource.UserID, &resource.Kind)
	if isNoRows(err) {
		return CollaborationResource{}, ErrNotFound
	}
	return resource, err
}

func (s *Store) WithdrawMaterialSuggestion(
	ctx context.Context,
	id, actorID string,
	expectedRevision int64,
) (SuggestionMutation, error) {
	resource, err := s.SuggestionResource(ctx, id)
	if err != nil {
		return SuggestionMutation{}, err
	}
	var plateID string
	if err := s.pool.QueryRow(ctx, `SELECT plate_suggestion_id FROM material_suggestions WHERE id=$1`, id).
		Scan(&plateID); err != nil {
		return SuggestionMutation{}, err
	}
	return s.reviewMaterialSuggestions(
		ctx,
		resource.MaterialID,
		actorID,
		materialdoc.RejectSuggestions,
		[]string{plateID},
		expectedRevision,
		true,
		"",
	)
}

func (s *Store) CreateCommentDiscussion(
	ctx context.Context,
	materialID, actorID string,
	blockID *string,
	anchor, content json.RawMessage,
) (Discussion, error) {
	if err := validateRichContent(content); err != nil {
		return Discussion{}, err
	}
	if len(anchor) == 0 || string(anchor) == "null" {
		anchor = json.RawMessage("{}")
	}
	var anchorObject map[string]any
	if err := json.Unmarshal(anchor, &anchorObject); err != nil || anchorObject == nil {
		return Discussion{}, fmt.Errorf("%w: discussion anchor must be an object", materialdoc.ErrInvalid)
	}
	if err := validateCommentAnchor(anchorObject); err != nil {
		return Discussion{}, err
	}
	discussionID, commentID := uid("disc"), uid("com")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Discussion{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO material_discussions
		(id, material_id, kind, block_id, anchor, created_by)
		VALUES ($1,$2,'comment',$3,$4,$5)`,
		discussionID, materialID, blockID, anchor, actorID); err != nil {
		return Discussion{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_comments
		(id, discussion_id, user_id, content_rich) VALUES ($1,$2,$3,$4)`,
		commentID, discussionID, actorID, content); err != nil {
		return Discussion{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Discussion{}, err
	}
	return s.findDiscussion(ctx, materialID, discussionID)
}

func (s *Store) AddNestedComment(
	ctx context.Context,
	discussionID, actorID string,
	parentCommentID *string,
	content json.RawMessage,
) (Comment, error) {
	if err := validateRichContent(content); err != nil {
		return Comment{}, err
	}
	if parentCommentID != nil {
		var parentParent *string
		err := s.pool.QueryRow(ctx, `SELECT parent_comment_id FROM material_comments
			WHERE id=$1 AND discussion_id=$2 AND deleted_at IS NULL`,
			*parentCommentID, discussionID).Scan(&parentParent)
		if isNoRows(err) {
			return Comment{}, ErrNotFound
		}
		if err != nil {
			return Comment{}, err
		}
		if parentParent != nil {
			return Comment{}, fmt.Errorf("%w: replies may only be nested one level", materialdoc.ErrInvalid)
		}
	}
	id := uid("com")
	comment, err := scanRevisionComment(s.pool.QueryRow(ctx, `INSERT INTO material_comments
		(id, discussion_id, parent_comment_id, user_id, content_rich)
		SELECT $1,$2,$3,$4,$5 FROM material_discussions
		WHERE id=$2 AND deleted_at IS NULL
		RETURNING id, discussion_id, parent_comment_id, user_id, content_rich,
		          is_edited, false, created_at, updated_at`,
		id, discussionID, parentCommentID, actorID, content))
	if isNoRows(err) {
		return Comment{}, ErrNotFound
	}
	return comment, err
}

func (s *Store) EditOwnComment(
	ctx context.Context,
	id, actorID string,
	content json.RawMessage,
) (Comment, error) {
	if err := validateRichContent(content); err != nil {
		return Comment{}, err
	}
	comment, err := scanRevisionComment(s.pool.QueryRow(ctx, `UPDATE material_comments
		SET content_rich=$3, is_edited=true, updated_at=now()
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
		RETURNING id, discussion_id, parent_comment_id, user_id, content_rich,
		          is_edited, false, created_at, updated_at`, id, actorID, content))
	if isNoRows(err) {
		return Comment{}, ErrNotFound
	}
	return comment, err
}

func (s *Store) SoftDeleteComment(ctx context.Context, id, actorID string) error {
	ct, err := s.pool.Exec(ctx, `UPDATE material_comments
		SET deleted_at=now(), deleted_by=$2, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, id, actorID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetCollaborationDiscussionResolved(ctx context.Context, id string, resolved bool) error {
	ct, err := s.pool.Exec(ctx, `UPDATE material_discussions
		SET is_resolved=$2, updated_at=now()
		WHERE id=$1 AND kind='comment' AND deleted_at IS NULL`, id, resolved)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SoftDeleteDiscussion(
	ctx context.Context,
	id, actorID string,
	expectedRevision *int64,
) (SuggestionMutation, error) {
	resource, err := s.DiscussionResource(ctx, id)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if resource.Kind == "suggestion" {
		if expectedRevision == nil {
			return SuggestionMutation{}, ErrConflict
		}
		rows, err := s.pool.Query(ctx, `SELECT plate_suggestion_id
			FROM material_suggestions
			WHERE discussion_id=$1 AND status='pending' AND deleted_at IS NULL`, id)
		if err != nil {
			return SuggestionMutation{}, err
		}
		var ids []string
		for rows.Next() {
			var plateID string
			if err := rows.Scan(&plateID); err != nil {
				rows.Close()
				return SuggestionMutation{}, err
			}
			ids = append(ids, plateID)
		}
		rows.Close()
		if len(ids) > 0 {
			return s.reviewMaterialSuggestions(
				ctx,
				resource.MaterialID,
				actorID,
				materialdoc.RejectSuggestions,
				ids,
				*expectedRevision,
				false,
				id,
			)
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SuggestionMutation{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE material_discussions
		SET deleted_at=now(), deleted_by=$2, is_resolved=true, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, id, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE material_suggestions
		SET deleted_at=now(), deleted_by=$2, updated_at=now()
		WHERE discussion_id=$1 AND deleted_at IS NULL`, id, actorID); err != nil {
		return SuggestionMutation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SuggestionMutation{}, err
	}
	return s.suggestionMutationResult(ctx, resource.MaterialID, []string{})
}

func (s *Store) findDiscussion(ctx context.Context, materialID, discussionID string) (Discussion, error) {
	discussions, err := s.ListCollaborationDiscussions(ctx, materialID)
	if err != nil {
		return Discussion{}, err
	}
	for _, discussion := range discussions {
		if discussion.ID == discussionID {
			return discussion, nil
		}
	}
	return Discussion{}, ErrNotFound
}

func (s *Store) suggestionMutationResult(
	ctx context.Context,
	materialID string,
	ids []string,
) (SuggestionMutation, error) {
	material, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return SuggestionMutation{}, err
	}
	discussions, err := s.ListCollaborationDiscussions(ctx, materialID)
	if err != nil {
		return SuggestionMutation{}, err
	}
	if ids == nil {
		ids = []string{}
	}
	return SuggestionMutation{
		Material: material, SuggestionIDs: ids, Discussions: discussions,
	}, nil
}

func equivalentMaterialDocuments(left, right string) (bool, error) {
	var leftValue, rightValue any
	if err := json.Unmarshal([]byte(left), &leftValue); err != nil {
		return false, err
	}
	if err := json.Unmarshal([]byte(right), &rightValue); err != nil {
		return false, err
	}
	return reflect.DeepEqual(leftValue, rightValue), nil
}

func uniquePlateSuggestionIDs(changes []materialdoc.SuggestionChange) []string {
	seen := map[string]bool{}
	for _, change := range changes {
		seen[change.PlateSuggestionID] = true
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func suggestionPairKey(plateID, blockID string) string {
	return plateID + "\x00" + blockID
}

func containsAllSuggestionIDs(found, requested []string) bool {
	if len(requested) == 0 {
		return true
	}
	set := map[string]bool{}
	for _, id := range found {
		set[id] = true
	}
	for _, id := range requested {
		if !set[id] {
			return false
		}
	}
	return true
}

func encodeEventMetadata(value map[string]any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func flashcardIDs(content string) ([]string, error) {
	cards, err := materialdoc.ExtractFlashcards(content)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(cards))
	for i, card := range cards {
		ids[i] = card.ID
	}
	return ids, nil
}
