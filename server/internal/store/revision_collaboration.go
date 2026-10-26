package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

const maxRelativePositionBytes = 4096

type CollaborationResource struct {
	MaterialID string
	UserID     string
}

// scanRevisionComment expects the author's name and avatar between the user id
// and the text. Mutations project them through a CTE, because RETURNING
// cannot join the author's user row on its own. A deleted comment's text is
// not served.
func scanRevisionComment(row pgx.Row) (Comment, error) {
	var comment Comment
	err := row.Scan(
		&comment.ID,
		&comment.DiscussionID,
		&comment.UserID,
		&comment.AuthorName,
		&comment.AuthorAvatarURL,
		&comment.Text,
		&comment.IsEdited,
		&comment.IsDeleted,
		&comment.CreatedAt,
		&comment.UpdatedAt,
	)
	if comment.IsDeleted {
		comment.Text = ""
	}
	return comment, err
}

// validateCommentText accepts plain text of 1 to fieldlimits.Comment
// characters that is not only whitespace (Epo 2026-10-24: comments are
// strictly validated plain text; plainField).
func validateCommentText(text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("%w: a comment needs text", materialdoc.ErrInvalid)
	}
	if utf8.RuneCountInString(text) > fieldlimits.Comment {
		return fmt.Errorf("%w: a comment is at most %d characters", materialdoc.ErrInvalid, fieldlimits.Comment)
	}
	if !plainField(text) {
		return fmt.Errorf("%w: a comment holds plain text only", materialdoc.ErrInvalid)
	}
	return nil
}

// plainField is whether a comment field (text, quote, block id) holds no
// control character but a newline or tab and no bidi override or isolate
// (U+202A-U+202E, U+2066-U+2069); zero-width joiners, which emoji and some
// scripts need, stay (Q313).
func plainField(s string) bool {
	for _, r := range s {
		if (unicode.IsControl(r) && r != '\n' && r != '\t') ||
			(r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			return false
		}
	}
	return true
}

// validateBlockID accepts a discussion's block id of 1 to 128 characters in
// plain text (Q313).
func validateBlockID(blockID *string) error {
	if blockID == nil {
		return nil
	}
	if n := utf8.RuneCountInString(*blockID); n < 1 || n > 128 || !plainField(*blockID) {
		return fmt.Errorf("%w: a block id is 1 to 128 plain characters", materialdoc.ErrInvalid)
	}
	return nil
}

func validateRelativeAnchor(start, end []byte, version int, quote string) error {
	if (len(start) == 0) != (len(end) == 0) {
		return fmt.Errorf("%w: comment anchor requires both relative positions", materialdoc.ErrInvalid)
	}
	if len(start) > maxRelativePositionBytes || len(end) > maxRelativePositionBytes {
		return fmt.Errorf("%w: comment relative position is too large", materialdoc.ErrInvalid)
	}
	if version < 1 {
		return fmt.Errorf("%w: comment anchor version must be positive", materialdoc.ErrInvalid)
	}
	if utf8.RuneCountInString(quote) > 1000 {
		return fmt.Errorf("%w: comment anchor quote is too large", materialdoc.ErrInvalid)
	}
	if !plainField(quote) {
		return fmt.Errorf("%w: a comment anchor quote holds plain text only", materialdoc.ErrInvalid)
	}
	return nil
}

// ListCollaborationDiscussions returns active comment threads, each a flat list
// of comments in creation order.
func (s *Store) ListCollaborationDiscussions(ctx context.Context, materialID string) ([]Discussion, error) {
	rows, err := s.pool.Query(ctx, `SELECT d.id, d.material_id, d.block_id, d.anchor_start,
		d.anchor_end, d.anchor_version, d.anchor_quote, d.created_by,
		COALESCE(u.name,''), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,''), false,
		d.created_at, d.updated_at
		FROM material_discussions d
		LEFT JOIN users u ON u.id=d.created_by
		WHERE d.material_id=$1 AND d.deleted_at IS NULL
		ORDER BY d.created_at`, materialID)
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
			&discussion.BlockID,
			&discussion.AnchorStart,
			&discussion.AnchorEnd,
			&discussion.AnchorVersion,
			&discussion.AnchorQuote,
			&discussion.CreatedBy,
			&discussion.AuthorName,
			&discussion.AuthorAvatarURL,
			&discussion.IsDeleted,
			&discussion.CreatedAt,
			&discussion.UpdatedAt,
		); err != nil {
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

func (s *Store) listDiscussionComments(ctx context.Context, discussionID string) ([]Comment, error) {
	rows, err := s.pool.Query(ctx, `SELECT c.id, c.discussion_id, c.user_id,
		COALESCE(u.name,''), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,''), c.text, c.is_edited,
		(c.deleted_at IS NOT NULL), c.created_at, c.updated_at
		FROM material_comments c
		LEFT JOIN users u ON u.id=c.user_id
		WHERE c.discussion_id=$1
		ORDER BY c.created_at`, discussionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	comments := []Comment{}
	for rows.Next() {
		comment, err := scanRevisionComment(rows)
		if err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	return comments, rows.Err()
}

func (s *Store) DiscussionResource(ctx context.Context, id string) (CollaborationResource, error) {
	var resource CollaborationResource
	err := s.pool.QueryRow(ctx, `SELECT material_id, created_by
		FROM material_discussions WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&resource.MaterialID, &resource.UserID)
	if isNoRows(err) {
		return CollaborationResource{}, ErrNotFound
	}
	return resource, err
}

func (s *Store) CommentResource(ctx context.Context, id string) (CollaborationResource, error) {
	var resource CollaborationResource
	err := s.pool.QueryRow(ctx, `SELECT d.material_id, c.user_id
		FROM material_comments c JOIN material_discussions d ON d.id=c.discussion_id
		WHERE c.id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`, id).
		Scan(&resource.MaterialID, &resource.UserID)
	if isNoRows(err) {
		return CollaborationResource{}, ErrNotFound
	}
	return resource, err
}

// lockCommentAccountsTx is the account half of final comment admission. The
// actor must be fully active. A deleted, deletion-pending or suspended owner's
// content is not found for any other actor. Rows are locked in ID order to
// match the other multi-account write paths.
func (s *Store) lockCommentAccountsTx(
	ctx context.Context,
	tx pgx.Tx,
	ownerID, actorID string,
) error {
	if ownerID == "" || actorID == "" {
		return ErrNotFound
	}
	ids := []string{ownerID}
	if actorID != ownerID {
		ids = append(ids, actorID)
	}
	sort.Strings(ids)
	rows, err := tx.Query(ctx, `SELECT id, deleted_at, deletion_requested_at,
			suspended_at, suspended_reason
		FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id string
		var deletedAt, deletionRequestedAt, suspendedAt *time.Time
		var reason *string
		if err := rows.Scan(
			&id, &deletedAt, &deletionRequestedAt, &suspendedAt, &reason,
		); err != nil {
			return err
		}
		seen++
		if id == ownerID && (deletedAt != nil || deletionRequestedAt != nil ||
			(suspendedAt != nil && id != actorID)) {
			return ErrNotFound
		}
		if id != actorID {
			continue
		}
		state := AccountActive
		switch {
		case deletedAt != nil:
			state = AccountDeleted
		case deletionRequestedAt != nil:
			state = AccountDeletionPending
		case suspendedAt != nil:
			state = AccountSuspended
		}
		if state != AccountActive {
			locked := &AccountLockedError{UserID: actorID, State: state}
			if reason != nil {
				locked.Reason = *reason
			}
			return locked
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if seen != len(ids) {
		return ErrNotFound
	}
	return nil
}

// lockMaterialEditorTx serializes role/sharing changes with a comment
// write, then rechecks both lifecycle and effective editor permission. This
// closes the gap between the handler's initial access lookup and the INSERT or
// UPDATE without changing link/public share-role behavior. Writing a comment
// (edit) is refused when the actor or the material's payer is frozen or the
// payer is at its storage limit; deleting one is not.
func (s *Store) lockMaterialEditorTx(
	ctx context.Context,
	tx pgx.Tx,
	materialID, actorID string,
	edit bool,
) (WorkspaceRole, error) {
	var materialOwner string
	var workspaceID *string
	if err := tx.QueryRow(ctx, `SELECT owner_user_id, workspace_id
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, materialID).Scan(&materialOwner, &workspaceID); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}

	ownerID := materialOwner
	var privacy Privacy
	var shareRole *ShareRole
	if workspaceID != nil {
		if err := tx.QueryRow(ctx, `SELECT user_id, privacy, share_role
			FROM workspaces WHERE id=$1 FOR UPDATE`, *workspaceID).
			Scan(&ownerID, &privacy, &shareRole); err != nil {
			if isNoRows(err) {
				return "", ErrNotFound
			}
			return "", err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM materials
			WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`, materialID, *workspaceID).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return "", ErrNotFound
		}
	}
	if err := s.lockCommentAccountsTx(ctx, tx, ownerID, actorID); err != nil {
		return "", err
	}
	// The material's payer (its creator) gates content edits.
	if edit {
		if err := s.assertContentEditableTx(ctx, tx, materialOwner, actorID); err != nil {
			return "", err
		}
	}
	if workspaceID == nil {
		var currentOwner string
		if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM materials
			WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, materialID).Scan(&currentOwner); err != nil {
			if isNoRows(err) {
				return "", ErrNotFound
			}
			return "", err
		}
		if currentOwner != actorID {
			return "", ErrNotFound
		}
		return RoleOwner, nil
	}
	if ownerID == actorID {
		return RoleOwner, nil
	}

	var memberRole WorkspaceRole
	err := tx.QueryRow(ctx, `SELECT role FROM workspace_members
		WHERE workspace_id=$1 AND user_id=$2`, *workspaceID, actorID).Scan(&memberRole)
	if err != nil && !isNoRows(err) {
		return "", err
	}
	var linkGranted bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_link_grants
		WHERE workspace_id=$1 AND user_id=$2)`, *workspaceID, actorID).Scan(&linkGranted); err != nil {
		return "", err
	}
	// A link workspace reaches a nonmember only through a redeemed link.
	var sharedRole WorkspaceRole
	if shareRole != nil && (privacy == PrivacyPublic ||
		(privacy == PrivacyLink && (memberRole != "" || linkGranted))) {
		sharedRole = shareRole.WorkspaceRole()
	}
	role := MaxRole(memberRole, sharedRole)
	if role == "" {
		return "", ErrNotFound
	}
	if !RoleCanEdit(role) {
		return "", ErrForbidden
	}
	return role, nil
}

func (s *Store) CreateCommentDiscussion(
	ctx context.Context,
	materialID, actorID string,
	blockID *string,
	anchorStart, anchorEnd []byte,
	anchorVersion int,
	anchorQuote string,
	text string,
) (Discussion, error) {
	if err := validateCommentText(text); err != nil {
		return Discussion{}, err
	}
	if err := validateRelativeAnchor(anchorStart, anchorEnd, anchorVersion, anchorQuote); err != nil {
		return Discussion{}, err
	}
	if err := validateBlockID(blockID); err != nil {
		return Discussion{}, err
	}
	discussionID, commentID := uid("disc"), uid("com")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Discussion{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := s.lockMaterialEditorTx(ctx, tx, materialID, actorID, true); err != nil {
		return Discussion{}, err
	}
	if err := assertCommentRoomTx(ctx, tx, materialID); err != nil {
		return Discussion{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_discussions
		(id, material_id, block_id, anchor_start, anchor_end, anchor_version,
		 anchor_quote, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		discussionID, materialID, blockID, nullBytes(anchorStart), nullBytes(anchorEnd),
		anchorVersion, anchorQuote, actorID); err != nil {
		return Discussion{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_comments
		(id, discussion_id, user_id, text) VALUES ($1,$2,$3,$4)`,
		commentID, discussionID, actorID, text); err != nil {
		return Discussion{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Discussion{}, err
	}
	return s.findDiscussion(ctx, materialID, discussionID)
}

func nullBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func (s *Store) AddComment(
	ctx context.Context,
	discussionID, actorID string,
	text string,
) (Comment, error) {
	if err := validateCommentText(text); err != nil {
		return Comment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Comment{}, err
	}
	defer tx.Rollback(ctx)
	var materialID string
	if err := tx.QueryRow(ctx, `SELECT material_id FROM material_discussions
		WHERE id=$1 AND deleted_at IS NULL`, discussionID).Scan(&materialID); err != nil {
		if isNoRows(err) {
			return Comment{}, ErrNotFound
		}
		return Comment{}, err
	}
	if _, err := s.lockMaterialEditorTx(ctx, tx, materialID, actorID, true); err != nil {
		return Comment{}, err
	}
	if err := assertCommentRoomTx(ctx, tx, materialID); err != nil {
		return Comment{}, err
	}
	id := uid("com")
	comment, err := scanRevisionComment(tx.QueryRow(ctx, `WITH added AS (
			INSERT INTO material_comments
			(id, discussion_id, user_id, text)
			SELECT $1,$2,$3,$4 FROM material_discussions
			WHERE id=$2 AND deleted_at IS NULL
			RETURNING id, discussion_id, user_id, text,
			          is_edited, created_at, updated_at
		)
		SELECT a.id, a.discussion_id, a.user_id,
			COALESCE(u.name,''), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,''), a.text,
			a.is_edited, false, a.created_at, a.updated_at
		FROM added a LEFT JOIN users u ON u.id=a.user_id`,
		id, discussionID, actorID, text))
	if isNoRows(err) {
		return Comment{}, ErrNotFound
	}
	if err != nil {
		return Comment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Comment{}, err
	}
	return comment, nil
}

func (s *Store) EditOwnComment(
	ctx context.Context,
	id, actorID string,
	text string,
) (Comment, error) {
	if err := validateCommentText(text); err != nil {
		return Comment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Comment{}, err
	}
	defer tx.Rollback(ctx)
	var materialID string
	if err := tx.QueryRow(ctx, `SELECT d.material_id
		FROM material_comments c JOIN material_discussions d ON d.id=c.discussion_id
		WHERE c.id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`, id).
		Scan(&materialID); err != nil {
		if isNoRows(err) {
			return Comment{}, ErrNotFound
		}
		return Comment{}, err
	}
	if _, err := s.lockMaterialEditorTx(ctx, tx, materialID, actorID, true); err != nil {
		return Comment{}, err
	}
	comment, err := scanRevisionComment(tx.QueryRow(ctx, `WITH edited AS (
			UPDATE material_comments
			SET text=$3, is_edited=true, updated_at=now()
			WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
			RETURNING id, discussion_id, user_id, text,
			          is_edited, created_at, updated_at
		)
		SELECT e.id, e.discussion_id, e.user_id,
			COALESCE(u.name,''), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,''), e.text,
			e.is_edited, false, e.created_at, e.updated_at
		FROM edited e LEFT JOIN users u ON u.id=e.user_id`, id, actorID, text))
	if isNoRows(err) {
		return Comment{}, ErrNotFound
	}
	if err != nil {
		return Comment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Comment{}, err
	}
	return comment, nil
}

func (s *Store) SoftDeleteComment(ctx context.Context, id, actorID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var materialID, authorID string
	if err := tx.QueryRow(ctx, `SELECT d.material_id, c.user_id
		FROM material_comments c JOIN material_discussions d ON d.id=c.discussion_id
		WHERE c.id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`, id).
		Scan(&materialID, &authorID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	role, err := s.lockMaterialEditorTx(ctx, tx, materialID, actorID, false)
	if err != nil {
		return err
	}
	// Authors delete their own; only the owner deletes another user's.
	if authorID != actorID && role != RoleOwner {
		return ErrForbidden
	}
	ct, err := tx.Exec(ctx, `UPDATE material_comments
		SET deleted_at=now(), deleted_by=$2, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, id, actorID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Store) SoftDeleteDiscussion(ctx context.Context, id, actorID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var materialID, authorID string
	if err := tx.QueryRow(ctx, `SELECT material_id, created_by FROM material_discussions
		WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&materialID, &authorID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	role, err := s.lockMaterialEditorTx(ctx, tx, materialID, actorID, false)
	if err != nil {
		return err
	}
	// Authors delete their own; only the owner deletes another user's.
	if authorID != actorID && role != RoleOwner {
		return ErrForbidden
	}
	ct, err := tx.Exec(ctx, `UPDATE material_discussions
		SET deleted_at=now(), deleted_by=$2, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, id, actorID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
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
