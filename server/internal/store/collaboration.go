package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

func (s *Store) ListWorkspaceMembers(ctx context.Context, wsID string) ([]WorkspaceMember, error) {
	rows, err := s.pool.Query(ctx, `SELECT wm.workspace_id, wm.user_id, u.name, COALESCE(u.email,''),
		COALESCE(u.avatar_url,''), wm.role, wm.created_at
		FROM workspace_members wm JOIN users u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, u.name`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceMember{}
	for rows.Next() {
		var member WorkspaceMember
		if err := rows.Scan(&member.WorkspaceID, &member.UserID, &member.Name, &member.Email,
			&member.AvatarURL, &member.Role, &member.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, member)
	}
	return out, rows.Err()
}

func (s *Store) SetWorkspaceMemberRole(ctx context.Context, wsID, memberID string, role WorkspaceRole) error {
	_, _, err := s.SetWorkspaceMemberRoleWithResult(ctx, wsID, memberID, role)
	return err
}

func (s *Store) SetWorkspaceMemberRoleWithResult(ctx context.Context, wsID, memberID string, role WorkspaceRole) (*Notification, bool, error) {
	if role != RoleEditor && role != RoleCommenter && role != RoleViewer {
		return nil, false, ErrForbidden
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	var memberEmail, locale, workspaceName string
	var currentRole WorkspaceRole
	// FOR UPDATE OF wm: an unqualified FOR UPDATE over this join would also
	// lock the users and workspaces rows, which nothing here mutates.
	err = tx.QueryRow(ctx, `SELECT wm.role
		FROM workspace_members wm
		JOIN users u ON u.id=wm.user_id
		JOIN workspaces w ON w.id=wm.workspace_id
		WHERE wm.workspace_id=$1 AND wm.user_id=$2
		FOR UPDATE OF wm`, wsID, memberID).Scan(&currentRole)
	if isNoRows(err) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if currentRole == RoleOwner {
		return nil, false, ErrForbidden
	}
	if currentRole == role {
		return nil, false, nil
	}
	// Only pending rows are dropped here. A row already claimed for sending is
	// row-locked by the dispatcher for the whole provider call, so deleting it
	// would block this request behind Resend; emailClaimActive re-derives its
	// validity from workspace_members instead and cancels it before the send.
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template IN ('workspace-role-changed','workspace-member-removed')
			AND status='pending'
			AND user_id=$2 AND payload->>'workspaceId'=$1`, wsID, memberID); err != nil {
		return nil, false, err
	}

	var updatedRole WorkspaceRole
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `UPDATE workspace_members wm
		SET role=$3, updated_at=now()
		FROM users u, workspaces w
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role<>'owner'
			AND u.id=wm.user_id AND w.id=wm.workspace_id
		RETURNING COALESCE(u.email,''), u.locale, w.name, wm.role, wm.updated_at`,
		wsID, memberID, role).
		Scan(&memberEmail, &locale, &workspaceName, &updatedRole, &updatedAt)
	if err != nil {
		return nil, false, err
	}
	data, err := json.Marshal(map[string]any{
		"workspaceId":   wsID,
		"workspaceName": workspaceName,
		"role":          updatedRole,
		"updatedAt":     updatedAt.UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	notification, err := CreateNotificationTx(ctx, tx, NotificationParams{
		UserID:      memberID,
		Kind:        NotifWorkspaceRoleChanged,
		Data:        data,
		Href:        "/workspaces/" + wsID,
		WorkspaceID: wsID,
		At:          now,
	})
	if err != nil {
		return nil, false, err
	}
	_, err = EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		UserID:         memberID,
		ToEmail:        memberEmail,
		Template:       "workspace-role-changed",
		Locale:         locale,
		Payload:        data,
		IdempotencyKey: "workspace-role:" + notification.ID,
		Category:       "membership",
	})
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &notification, true, nil
}

func (s *Store) RemoveWorkspaceMember(ctx context.Context, wsID, memberID string) error {
	_, _, err := s.RemoveWorkspaceMemberWithResult(ctx, wsID, memberID)
	return err
}

func (s *Store) RemoveWorkspaceMemberWithResult(ctx context.Context, wsID, memberID string) (*Notification, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	var memberEmail, locale, workspaceName string
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template IN ('workspace-role-changed','workspace-member-removed')
			AND status='pending'
			AND user_id=$2 AND payload->>'workspaceId'=$1`, wsID, memberID); err != nil {
		return nil, false, err
	}
	err = tx.QueryRow(ctx, `DELETE FROM workspace_members wm
		USING users u, workspaces w
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role<>'owner'
			AND u.id=wm.user_id AND w.id=wm.workspace_id
		RETURNING COALESCE(u.email,''), u.locale, w.name`,
		wsID, memberID).Scan(&memberEmail, &locale, &workspaceName)
	if isNoRows(err) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}

	now := time.Now().UTC()
	data, err := json.Marshal(map[string]any{
		"workspaceId":   wsID,
		"workspaceName": workspaceName,
		"removedAt":     now.Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, false, err
	}
	notification, err := CreateNotificationTx(ctx, tx, NotificationParams{
		UserID:      memberID,
		Kind:        NotifWorkspaceMemberRemoved,
		Data:        data,
		Href:        "/workspaces",
		WorkspaceID: wsID,
		At:          now,
	})
	if err != nil {
		return nil, false, err
	}
	_, err = EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		UserID:         memberID,
		ToEmail:        memberEmail,
		Template:       "workspace-member-removed",
		Locale:         locale,
		Payload:        data,
		IdempotencyKey: "workspace-removed:" + notification.ID,
		Category:       "membership",
	})
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &notification, true, nil
}

// CreateWorkspaceInvite resolves an exact user ID or email without revealing
// whether an eligible account exists. A nil result can therefore mean either a
// created invitation or an intentional no-op.
func (s *Store) CreateWorkspaceInvite(ctx context.Context, wsID, identifier string, role WorkspaceRole, invitedBy string) error {
	_, _, err := s.CreateWorkspaceInviteWithResult(ctx, wsID, identifier, role, invitedBy)
	return err
}

func (s *Store) CreateWorkspaceInviteWithResult(ctx context.Context, wsID, identifier string, role WorkspaceRole, invitedBy string) (*Notification, bool, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" || (role != RoleEditor && role != RoleCommenter && role != RoleViewer) {
		return nil, false, ErrForbidden
	}
	token, err := inviteToken()
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(7 * 24 * time.Hour)
	tokenHash := inviteTokenHash(token)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	var inviteID, invitedUserID, workspaceName, inviteEmail, locale string
	err = tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT id FROM users WHERE id=$2 AND deleted_at IS NULL
			UNION ALL
			SELECT id FROM users
			WHERE lower(email)=lower($2) AND deleted_at IS NULL
				AND NOT EXISTS (
					SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL
				)
		),
		target AS (
			SELECT min(id) AS id FROM candidates HAVING count(*)=1
		)
		INSERT INTO workspace_invites
			(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at, created_at)
		SELECT $3,$1,u.id,COALESCE(u.email,''),$4,$5,$6,$7,$8
		FROM target
		JOIN users u ON u.id=target.id
		JOIN workspaces w ON w.id=$1
		WHERE u.id<>w.user_id
			AND NOT EXISTS (
				SELECT 1 FROM workspace_members wm
				WHERE wm.workspace_id=$1 AND wm.user_id=u.id
			)
		ON CONFLICT (workspace_id, invited_user_id)
			WHERE accepted_at IS NULL AND revoked_at IS NULL AND invited_user_id IS NOT NULL
		DO UPDATE SET email=EXCLUDED.email, role=EXCLUDED.role, token_hash=EXCLUDED.token_hash,
			invited_by=EXCLUDED.invited_by, expires_at=EXCLUDED.expires_at,
			created_at=EXCLUDED.created_at
		RETURNING id, invited_user_id,
			(SELECT name FROM workspaces WHERE id=$1),
			(SELECT COALESCE(email,'') FROM users WHERE id=workspace_invites.invited_user_id),
			(SELECT locale FROM users WHERE id=workspace_invites.invited_user_id)`,
		wsID, identifier, uid("inv"), role, tokenHash[:], invitedBy, expiresAt, now).
		Scan(&inviteID, &invitedUserID, &workspaceName, &inviteEmail, &locale)
	if isNoRows(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	data, err := json.Marshal(map[string]any{
		"workspaceId":   wsID,
		"workspaceName": workspaceName,
		"inviteId":      inviteID,
	})
	if err != nil {
		return nil, false, err
	}
	var notification Notification
	err = tx.QueryRow(ctx, `INSERT INTO notifications
		(id, user_id, kind, data, at, read_at, href, workspace_id, workspace_invite_id)
		VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)
		ON CONFLICT (workspace_invite_id) WHERE workspace_invite_id IS NOT NULL
		DO UPDATE SET user_id=EXCLUDED.user_id, kind=EXCLUDED.kind,
			data=EXCLUDED.data, at=EXCLUDED.at, read_at=NULL, href=EXCLUDED.href,
			workspace_id=EXCLUDED.workspace_id
		RETURNING id, kind, data, COALESCE(href,''), at, read_at,
			COALESCE(workspace_id,''), COALESCE(workspace_invite_id,'')`,
		uid("ntf"),
		invitedUserID,
		NotifWorkspaceInvite,
		data,
		now,
		"/workspace-invites/"+inviteID,
		wsID,
		inviteID,
	).Scan(
		&notification.ID,
		&notification.Kind,
		&notification.Data,
		&notification.Href,
		&notification.At,
		&notification.ReadAt,
		&notification.WorkspaceID,
		&notification.WorkspaceInviteID,
	)
	notification.UserID = invitedUserID
	if err != nil {
		return nil, false, err
	}

	// A re-invite invalidates any not-yet-sent email containing the old token.
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template='workspace-invite'
			AND status='pending'
			AND payload->>'inviteId'=$1`, inviteID); err != nil {
		return nil, false, err
	}
	emailPayload, err := json.Marshal(map[string]any{
		"workspaceName": workspaceName,
		"role":          role,
		"inviteId":      inviteID,
		"invitePath":    "/workspace-invites/" + token,
		"tokenHash":     hex.EncodeToString(tokenHash[:]),
	})
	if err != nil {
		return nil, false, err
	}
	_, err = EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		UserID:         invitedUserID,
		ToEmail:        inviteEmail,
		Template:       "workspace-invite",
		Locale:         locale,
		Payload:        emailPayload,
		IdempotencyKey: "workspace-invite:" + inviteID + ":" + hex.EncodeToString(tokenHash[:]),
		Category:       "workspace_invite",
	})
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &notification, true, nil
}

func inviteToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func inviteTokenHash(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token))
}

// ExpireWorkspaceInvites removes unaccepted invitations after their deadline.
// Associated in-app notifications are deleted by the foreign-key cascade, and
// pending invite emails are removed before the invite row disappears.
func (s *Store) ExpireWorkspaceInvites(ctx context.Context) (int64, error) {
	_, count, err := s.ExpireWorkspaceInvitesWithResult(ctx)
	return count, err
}

func (s *Store) ExpireWorkspaceInvitesWithResult(ctx context.Context) ([]NotificationRemoval, int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `SELECT n.user_id, n.id
		FROM notifications n
		JOIN workspace_invites wi ON wi.id=n.workspace_invite_id
		WHERE wi.accepted_at IS NULL AND wi.expires_at<=now()`)
	if err != nil {
		return nil, 0, err
	}
	removed := []NotificationRemoval{}
	for rows.Next() {
		var item NotificationRemoval
		if err := rows.Scan(&item.UserID, &item.ID); err != nil {
			rows.Close()
			return nil, 0, err
		}
		removed = append(removed, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, 0, err
	}
	rows.Close()

	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template='workspace-invite'
			AND status='pending'
			AND payload->>'inviteId' IN (
				SELECT id FROM workspace_invites
				WHERE accepted_at IS NULL AND expires_at<=now()
			)`); err != nil {
		return nil, 0, err
	}
	ct, err := tx.Exec(ctx, `DELETE FROM workspace_invites
		WHERE accepted_at IS NULL AND expires_at<=now()`)
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return removed, ct.RowsAffected(), nil
}

func (s *Store) AcceptWorkspaceInvite(ctx context.Context, reference, userID string) (WorkspaceMember, error) {
	member, _, err := s.AcceptWorkspaceInviteWithResult(ctx, reference, userID)
	return member, err
}

func (s *Store) AcceptWorkspaceInviteWithResult(ctx context.Context, reference, userID string) (WorkspaceMember, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceMember{}, "", err
	}
	defer tx.Rollback(ctx)
	var invite WorkspaceInvite
	query := `SELECT id, workspace_id, COALESCE(invited_user_id,''), email, role, invited_by,
		expires_at, accepted_at, revoked_at, created_at
		FROM workspace_invites WHERE token_hash=$1 FOR UPDATE`
	var arg any
	if isInviteID(reference) {
		query = `SELECT id, workspace_id, COALESCE(invited_user_id,''), email, role, invited_by,
			expires_at, accepted_at, revoked_at, created_at
			FROM workspace_invites WHERE id=$1 FOR UPDATE`
		arg = reference
	} else {
		tokenHash := inviteTokenHash(reference)
		arg = tokenHash[:]
	}
	err = tx.QueryRow(ctx, query, arg).
		Scan(&invite.ID, &invite.WorkspaceID, &invite.InvitedUserID, &invite.Email, &invite.Role,
			&invite.InvitedBy, &invite.ExpiresAt, &invite.AcceptedAt, &invite.RevokedAt, &invite.CreatedAt)
	if isNoRows(err) {
		// A raw token can legally start with "inv_". Only an existing complete
		// invite id is treated as an id; otherwise always retry token-hash
		// lookup instead of rejecting a valid token by prefix alone.
		if isInviteID(reference) {
			tokenHash := inviteTokenHash(reference)
			err = tx.QueryRow(ctx, `SELECT id, workspace_id, COALESCE(invited_user_id,''), email, role, invited_by,
				expires_at, accepted_at, revoked_at, created_at
				FROM workspace_invites WHERE token_hash=$1 FOR UPDATE`, tokenHash[:]).
				Scan(&invite.ID, &invite.WorkspaceID, &invite.InvitedUserID, &invite.Email, &invite.Role,
					&invite.InvitedBy, &invite.ExpiresAt, &invite.AcceptedAt, &invite.RevokedAt, &invite.CreatedAt)
		}
	}
	if isNoRows(err) {
		return WorkspaceMember{}, "", ErrNotFound
	}
	if err != nil {
		return WorkspaceMember{}, "", err
	}
	if invite.AcceptedAt != nil || invite.RevokedAt != nil || time.Now().UTC().After(invite.ExpiresAt) {
		return WorkspaceMember{}, "", ErrNotFound
	}
	if invite.InvitedUserID == "" || invite.InvitedUserID != userID {
		return WorkspaceMember{}, "", ErrForbidden
	}
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template IN ('workspace-role-changed','workspace-member-removed')
			AND status='pending'
			AND user_id=$2 AND payload->>'workspaceId'=$1`,
		invite.WorkspaceID, userID); err != nil {
		return WorkspaceMember{}, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,$3) ON CONFLICT (workspace_id,user_id)
		DO UPDATE SET role=CASE
			WHEN workspace_members.role='owner' THEN workspace_members.role
			ELSE EXCLUDED.role
		END, updated_at=now()`, invite.WorkspaceID, userID, invite.Role); err != nil {
		return WorkspaceMember{}, "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE workspace_invites SET accepted_by=$2, accepted_at=now() WHERE id=$1`,
		invite.ID, userID); err != nil {
		return WorkspaceMember{}, "", err
	}
	var notificationID string
	err = tx.QueryRow(ctx, `SELECT id FROM notifications WHERE workspace_invite_id=$1`, invite.ID).Scan(&notificationID)
	if err != nil && !isNoRows(err) {
		return WorkspaceMember{}, "", err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM notifications WHERE workspace_invite_id=$1`, invite.ID); err != nil {
		return WorkspaceMember{}, "", err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template='workspace-invite'
			AND status='pending'
			AND payload->>'inviteId'=$1`, invite.ID); err != nil {
		return WorkspaceMember{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceMember{}, "", err
	}
	members, err := s.ListWorkspaceMembers(ctx, invite.WorkspaceID)
	if err != nil {
		return WorkspaceMember{}, "", err
	}
	for _, member := range members {
		if member.UserID == userID {
			return member, notificationID, nil
		}
	}
	return WorkspaceMember{}, "", ErrNotFound
}

func isInviteID(reference string) bool {
	if len(reference) != len("inv_")+10 || !strings.HasPrefix(reference, "inv_") {
		return false
	}
	for _, ch := range reference[len("inv_"):] {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func (s *Store) ListMaterialRevisions(ctx context.Context, materialID string) ([]MaterialRevision, error) {
	rows, err := s.pool.Query(ctx, `WITH retention AS (
		SELECT CASE WHEN u.plan_tier = 'pro'
			THEN $2::bigint ELSE $3::bigint
		END AS revision_limit
		FROM materials m
		JOIN users u ON u.id=m.owner_user_id
		WHERE m.id=$1
	)
		SELECT material_id, revision, parent_revision, event_type,
		title, content, event_metadata, created_by, created_at
		FROM material_revisions
		WHERE material_id=$1
		ORDER BY version_date DESC
		LIMIT COALESCE((SELECT revision_limit FROM retention), $3)`,
		materialID,
		premiumMaterialRevisionLimit,
		freeMaterialRevisionLimit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MaterialRevision{}
	for rows.Next() {
		var revision MaterialRevision
		if err := rows.Scan(&revision.MaterialID, &revision.Revision, &revision.ParentRevision,
			&revision.EventType, &revision.Title, &revision.Content,
			&revision.EventMetadata,
			&revision.CreatedBy, &revision.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, revision)
	}
	return out, rows.Err()
}
