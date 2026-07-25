package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"time"
)

func (s *Store) ListWorkspaceMembers(ctx context.Context, wsID string) ([]WorkspaceMember, error) {
	rows, err := s.pool.Query(ctx, `SELECT wm.workspace_id, wm.user_id, u.name, u.email,
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
	if role != RoleEditor && role != RoleCommenter && role != RoleViewer {
		return ErrForbidden
	}
	ct, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role=$3, updated_at=now()
		WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'`, wsID, memberID, role)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RemoveWorkspaceMember(ctx context.Context, wsID, memberID string) error {
	ct, err := s.pool.Exec(ctx, `DELETE FROM workspace_members
		WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'`, wsID, memberID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateWorkspaceInvite resolves an exact user ID or email without revealing
// whether an eligible account exists. A nil result can therefore mean either a
// created invitation or an intentional no-op.
func (s *Store) CreateWorkspaceInvite(ctx context.Context, wsID, identifier string, role WorkspaceRole, invitedBy string) error {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" || (role != RoleEditor && role != RoleCommenter && role != RoleViewer) {
		return ErrForbidden
	}
	token, err := inviteToken()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(7 * 24 * time.Hour)
	tokenHash := inviteTokenHash(token)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var inviteID, invitedUserID, workspaceName string
	err = tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT id FROM users WHERE id=$2
			UNION ALL
			SELECT id FROM users
			WHERE lower(email)=lower($2)
				AND NOT EXISTS (SELECT 1 FROM users WHERE id=$2)
		),
		target AS (
			SELECT min(id) AS id FROM candidates HAVING count(*)=1
		)
		INSERT INTO workspace_invites
			(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at, created_at)
		SELECT $3,$1,u.id,u.email,$4,$5,$6,$7,$8
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
			(SELECT name FROM workspaces WHERE id=$1)`,
		wsID, identifier, uid("inv"), role, tokenHash[:], invitedBy, expiresAt, now).
		Scan(&inviteID, &invitedUserID, &workspaceName)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `INSERT INTO notifications
		(id, user_id, kind, title, body, at, read, href, workspace_invite_id)
		VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8)
		ON CONFLICT (workspace_invite_id) WHERE workspace_invite_id IS NOT NULL
		DO UPDATE SET user_id=EXCLUDED.user_id, kind=EXCLUDED.kind, title=EXCLUDED.title,
			body=EXCLUDED.body, at=EXCLUDED.at, read=false, href=EXCLUDED.href`,
		uid("ntf"), invitedUserID, NotifWorkspaceInvite, "Workspace invitation",
		"You've been invited to join "+workspaceName+".", now, "/workspace-invites/"+token, inviteID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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
// Associated in-app notifications are deleted by the foreign-key cascade.
func (s *Store) ExpireWorkspaceInvites(ctx context.Context) (int64, error) {
	ct, err := s.pool.Exec(ctx, `DELETE FROM workspace_invites
		WHERE accepted_at IS NULL AND expires_at<=now()`)
	if err != nil {
		return 0, err
	}
	return ct.RowsAffected(), nil
}

func (s *Store) AcceptWorkspaceInvite(ctx context.Context, token, userID string) (WorkspaceMember, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceMember{}, err
	}
	defer tx.Rollback(ctx)
	var invite WorkspaceInvite
	tokenHash := inviteTokenHash(token)
	err = tx.QueryRow(ctx, `SELECT id, workspace_id, COALESCE(invited_user_id,''), email, role, invited_by,
		expires_at, accepted_at, revoked_at, created_at
		FROM workspace_invites WHERE token_hash=$1 FOR UPDATE`, tokenHash[:]).
		Scan(&invite.ID, &invite.WorkspaceID, &invite.InvitedUserID, &invite.Email, &invite.Role,
			&invite.InvitedBy, &invite.ExpiresAt, &invite.AcceptedAt, &invite.RevokedAt, &invite.CreatedAt)
	if isNoRows(err) {
		return WorkspaceMember{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceMember{}, err
	}
	if invite.AcceptedAt != nil || invite.RevokedAt != nil || time.Now().UTC().After(invite.ExpiresAt) {
		return WorkspaceMember{}, ErrNotFound
	}
	if invite.InvitedUserID == "" || invite.InvitedUserID != userID {
		return WorkspaceMember{}, ErrForbidden
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,$3) ON CONFLICT (workspace_id,user_id)
		DO UPDATE SET role=CASE
			WHEN workspace_members.role='owner' THEN workspace_members.role
			ELSE EXCLUDED.role
		END, updated_at=now()`, invite.WorkspaceID, userID, invite.Role); err != nil {
		return WorkspaceMember{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE workspace_invites SET accepted_by=$2, accepted_at=now() WHERE id=$1`,
		invite.ID, userID); err != nil {
		return WorkspaceMember{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM notifications WHERE workspace_invite_id=$1`, invite.ID); err != nil {
		return WorkspaceMember{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceMember{}, err
	}
	members, err := s.ListWorkspaceMembers(ctx, invite.WorkspaceID)
	if err != nil {
		return WorkspaceMember{}, err
	}
	for _, member := range members {
		if member.UserID == userID {
			return member, nil
		}
	}
	return WorkspaceMember{}, ErrNotFound
}

func (s *Store) ListMaterialRevisions(ctx context.Context, materialID string) ([]MaterialRevision, error) {
	rows, err := s.pool.Query(ctx, `SELECT material_id, revision, parent_revision, event_type,
		title, content, has_pending_suggestions, event_metadata, created_by, created_at
		FROM material_revisions WHERE material_id=$1 ORDER BY revision DESC`, materialID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MaterialRevision{}
	for rows.Next() {
		var revision MaterialRevision
		if err := rows.Scan(&revision.MaterialID, &revision.Revision, &revision.ParentRevision,
			&revision.EventType, &revision.Title, &revision.Content,
			&revision.HasPendingSuggestions, &revision.EventMetadata,
			&revision.CreatedBy, &revision.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, revision)
	}
	return out, rows.Err()
}
