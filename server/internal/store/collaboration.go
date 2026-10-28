package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) ListWorkspaceMembers(ctx context.Context, wsID string) ([]WorkspaceMember, error) {
	rows, err := s.pool.Query(ctx, `SELECT wm.workspace_id, wm.user_id, COALESCE(NULLIF(u.name,''), u.id),
		COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,''), wm.role, wm.created_at
		FROM workspace_members wm JOIN users u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, COALESCE(NULLIF(u.name,''), u.id)`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceMember{}
	for rows.Next() {
		var member WorkspaceMember
		if err := rows.Scan(&member.WorkspaceID, &member.UserID, &member.Name,
			&member.AvatarURL, &member.Role, &member.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, member)
	}
	return out, rows.Err()
}

// ListWorkspaceCollaborators is the redacted directory behind mention
// autocomplete. It lists members only: a shared link grants access without
// leaving a row to enumerate, and someone reachable solely through a link is
// not a dependable mention target anyway.
func (s *Store) ListWorkspaceCollaborators(ctx context.Context, wsID string) ([]WorkspaceCollaborator, error) {
	rows, err := s.pool.Query(ctx, `SELECT wm.user_id, COALESCE(NULLIF(u.name,''), u.id), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url,'')
		FROM workspace_members wm JOIN users u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 ORDER BY COALESCE(NULLIF(u.name,''), u.id)`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceCollaborator{}
	for rows.Next() {
		var collaborator WorkspaceCollaborator
		if err := rows.Scan(&collaborator.UserID, &collaborator.Name, &collaborator.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, collaborator)
	}
	return out, rows.Err()
}

func (s *Store) SetWorkspaceMemberRole(ctx context.Context, actorID, wsID, memberID string, role WorkspaceRole) error {
	_, _, err := s.SetWorkspaceMemberRoleWithResult(ctx, actorID, wsID, memberID, role)
	return err
}

func (s *Store) SetWorkspaceMemberRoleWithResult(ctx context.Context, actorID, wsID, memberID string, role WorkspaceRole) (*Notification, bool, error) {
	if role != RoleEditor && role != RoleViewer {
		return nil, false, ErrForbidden
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, wsID, actorID)
	if err != nil {
		return nil, false, err
	}
	// The owner removes any member and a member leaves by removing itself
	// (Epo 2026-10-28); the owner's own row never matches the delete. An empty
	// actor is refused, never read as the owner.
	leaving := actorID != "" && memberID == actorID
	if ownerID != actorID && !leaving {
		return nil, false, ErrForbidden
	}

	var workspaceName string
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
	if roleRank(role) > roleRank(currentRole) {
		status, err := s.accountAccess(ctx, tx, ownerID)
		if err != nil {
			return nil, false, err
		}
		if err := status.Err(); err != nil {
			return nil, false, err
		}
	}

	var updatedRole WorkspaceRole
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `UPDATE workspace_members wm
		SET role=$3, updated_at=now()
		FROM workspaces w
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role<>'owner'
			AND w.id=wm.workspace_id
		RETURNING w.name, wm.role, wm.updated_at`,
		wsID, memberID, role).
		Scan(&workspaceName, &updatedRole, &updatedAt)
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
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &notification, true, nil
}

func (s *Store) RemoveWorkspaceMember(ctx context.Context, actorID, wsID, memberID string) error {
	_, _, err := s.RemoveWorkspaceMemberWithResult(ctx, actorID, wsID, memberID)
	return err
}

func (s *Store) RemoveWorkspaceMemberWithResult(ctx context.Context, actorID, wsID, memberID string) (*Notification, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, wsID, actorID)
	if err != nil {
		return nil, false, err
	}
	// The owner removes any member and a member leaves by removing itself
	// (Epo 2026-10-28); the owner's own row never matches the delete. An empty
	// actor is refused, never read as the owner.
	leaving := actorID != "" && memberID == actorID
	if ownerID != actorID && !leaving {
		return nil, false, ErrForbidden
	}

	var workspaceName string
	err = tx.QueryRow(ctx, `DELETE FROM workspace_members wm
		USING workspaces w
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role<>'owner'
			AND w.id=wm.workspace_id
		RETURNING w.name`,
		wsID, memberID).Scan(&workspaceName)
	if isNoRows(err) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if leaving {
		return nil, false, tx.Commit(ctx)
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
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &notification, true, nil
}

// CreateWorkspaceInvite stores a pending row for the address exactly as typed,
// whether or not it reaches an account, so the owner's list never tells which
// addresses have one (human authorization, 2026-10-21). Only a row that
// resolves an exact user ID or email to one eligible account (live, not the
// owner, not a member) gets a notification and an email; otherwise it is inert
// and can never be accepted. Typing the address again refreshes its row.
func (s *Store) CreateWorkspaceInvite(ctx context.Context, wsID, identifier string, role WorkspaceRole, invitedBy string) error {
	_, _, err := s.CreateWorkspaceInviteWithResult(ctx, wsID, identifier, role, invitedBy)
	return err
}

// An owner sends one invite to an address of a workspace every
// inviteResendCooldown, cancelled invites included, and at most
// InvitesPerOwnerPerDay invites and resends a UTC day. Both read the same
// whether or not the address has an account. An account invited under
// another address within the wait gets no second notification or email: the
// new row is stored inert and answered as sent, so the answer never tells the
// owner that two addresses are one account.
const (
	inviteResendCooldown  = 10 * time.Minute
	InvitesPerOwnerPerDay = 50
)

var (
	ErrInviteRecentlySent = errors.New("this address was invited moments ago")
	ErrInviteLimit        = errors.New("daily invite limit reached")
)

func (s *Store) CreateWorkspaceInviteWithResult(ctx context.Context, wsID, identifier string, role WorkspaceRole, invitedBy string) (*Notification, bool, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" || (role != RoleEditor && role != RoleViewer) {
		return nil, false, ErrForbidden
	}
	// This token is never shown: the email dispatcher replaces it with the one
	// it puts in the link (MintInviteLink), so no raw token is ever stored.
	placeholder, err := inviteToken()
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(7 * 24 * time.Hour)
	tokenHash := inviteTokenHash(placeholder)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, wsID, invitedBy)
	if err != nil {
		return nil, false, err
	}
	if ownerID != invitedBy {
		return nil, false, ErrForbidden
	}
	status, err := s.accountAccess(ctx, tx, ownerID)
	if err != nil {
		return nil, false, err
	}
	if err := status.Err(); err != nil {
		return nil, false, err
	}
	// The owner's own id or email, or a current member's user id, names someone
	// the owner already sees in the roster: such an invite sends nothing, so it
	// skips the resend wait and the daily count. An email that reaches a member
	// is counted like any other address, so the answer discloses no account.
	var known bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_members
			WHERE workspace_id=$1 AND user_id=$2)
		OR EXISTS (SELECT 1 FROM users WHERE id=$3 AND (id=$2 OR lower(email)=lower($2)))`,
		wsID, identifier, ownerID).Scan(&known); err != nil {
		return nil, false, err
	}
	if !known {
		var recent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_invites
			WHERE workspace_id=$1 AND lower(email)=lower($2)
				AND accepted_at IS NULL AND created_at > $3)`,
			wsID, identifier, now.Add(-inviteResendCooldown)).Scan(&recent); err != nil {
			return nil, false, err
		}
		if recent {
			return nil, false, ErrInviteRecentlySent
		}
		counted, err := tx.Exec(ctx, `INSERT INTO invite_usage (day, user_id, invites)
			VALUES ((now() AT TIME ZONE 'UTC')::date, $1, 1)
			ON CONFLICT (day, user_id) DO UPDATE SET invites=invite_usage.invites+1
			WHERE invite_usage.invites < $2::int`, invitedBy, InvitesPerOwnerPerDay)
		if err != nil {
			return nil, false, err
		}
		if counted.RowsAffected() == 0 {
			return nil, false, ErrInviteLimit
		}
	}

	var inviteID, invitedUserID, workspaceName, inviteEmail, locale, inviterName string
	err = tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT id FROM users WHERE id=$2
				AND deleted_at IS NULL AND deletion_requested_at IS NULL
				AND suspended_at IS NULL
			UNION ALL
			SELECT id FROM users
			WHERE lower(email)=lower($2)
				AND deleted_at IS NULL AND deletion_requested_at IS NULL
				AND suspended_at IS NULL
				AND NOT EXISTS (
					SELECT 1 FROM users WHERE id=$2
						AND deleted_at IS NULL AND deletion_requested_at IS NULL
						AND suspended_at IS NULL
				)
		),
		target AS (
			SELECT min(id) AS id FROM candidates HAVING count(*)=1
		),
		eligible AS (
			SELECT u.id FROM target
			JOIN users u ON u.id=target.id
			JOIN workspaces w ON w.id=$1
			WHERE u.id<>w.user_id
				AND NOT EXISTS (
					SELECT 1 FROM workspace_members wm
					WHERE wm.workspace_id=$1 AND wm.user_id=u.id
				)
				AND NOT EXISTS (
					SELECT 1 FROM workspace_invites recent
					WHERE recent.workspace_id=$1 AND recent.invited_user_id=u.id
						AND recent.created_at > $9
				)
		)
		INSERT INTO workspace_invites
			(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at, created_at)
		VALUES ($3,$1,(SELECT id FROM eligible),$2,$4,$5,$6,$7,$8)
		ON CONFLICT (workspace_id, lower(email))
			WHERE accepted_at IS NULL AND revoked_at IS NULL
		DO UPDATE SET invited_user_id=EXCLUDED.invited_user_id, email=EXCLUDED.email,
			role=EXCLUDED.role, token_hash=EXCLUDED.token_hash,
			invited_by=EXCLUDED.invited_by, expires_at=EXCLUDED.expires_at,
			created_at=EXCLUDED.created_at
		RETURNING id, COALESCE(invited_user_id,''),
			(SELECT name FROM workspaces WHERE id=$1),
			COALESCE((SELECT email FROM users WHERE id=workspace_invites.invited_user_id),''),
			COALESCE((SELECT locale FROM users WHERE id=workspace_invites.invited_user_id),''),
			(SELECT name FROM users WHERE id=$6)`,
		wsID, identifier, uid("inv"), role, tokenHash[:], invitedBy, expiresAt, now,
		now.Add(-inviteResendCooldown)).
		Scan(&inviteID, &invitedUserID, &workspaceName, &inviteEmail, &locale, &inviterName)
	if err != nil {
		return nil, false, err
	}
	if invitedUserID == "" {
		// Inert: a notification from when this row reached an account goes, and
		// its queued email finds the token rotated and is cancelled.
		if _, err := tx.Exec(ctx, `DELETE FROM notifications WHERE workspace_invite_id=$1`, inviteID); err != nil {
			return nil, false, err
		}
		return nil, false, tx.Commit(ctx)
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

	emailPayload, err := json.Marshal(map[string]any{
		"workspaceName": workspaceName,
		"inviterName":   inviterName,
		"role":          role,
		"inviteId":      inviteID,
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

// PendingWorkspaceInvite is one row of the owner's pending list: the address as typed,
// never whether it reaches an account.
type PendingWorkspaceInvite struct {
	ID        string    `json:"id"`
	Address   string    `json:"address"`
	SentAt    time.Time `json:"sentAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ListWorkspaceInvites lists the workspace's pending invites, newest first,
// inert rows included and indistinguishable. The caller checks ownership.
func (s *Store) ListWorkspaceInvites(ctx context.Context, wsID string) ([]PendingWorkspaceInvite, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, email, created_at, expires_at
		FROM workspace_invites
		WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()
		ORDER BY created_at DESC, id`, wsID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (PendingWorkspaceInvite, error) {
		var invite PendingWorkspaceInvite
		err := row.Scan(&invite.ID, &invite.Address, &invite.SentAt, &invite.ExpiresAt)
		return invite, err
	})
}

// CancelWorkspaceInvite revokes one pending invite. Owner-only; an invite that
// is not pending answers ErrNotFound. The recipient's bell already hides a
// revoked invite and its queued email is cancelled at send.
func (s *Store) CancelWorkspaceInvite(ctx context.Context, actorID, wsID, inviteID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, wsID, actorID)
	if err != nil {
		return err
	}
	if ownerID != actorID {
		return ErrForbidden
	}
	tag, err := tx.Exec(ctx, `UPDATE workspace_invites SET revoked_at=now()
		WHERE id=$1 AND workspace_id=$2
			AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`, inviteID, wsID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
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

// MintInviteLink gives a claimed workspace-invite email the token for its
// link, at send time, so the raw token lives only in the sent email and never
// in email_outbox.payload. The invite's hash is rotated only while the invite
// is pending and still holds this email's hash; the new hash is written back to
// the payload so a retried send can mint again. ok is false when the invite was
// accepted, cancelled, expired, re-sent or went inert since: the caller
// cancels the email rather than sending a dead link. The writes commit with the send guard.
func (g *EmailSendGuard) MintInviteLink(ctx context.Context) (path string, ok bool, err error) {
	if g == nil || g.done {
		return "", false, ErrEmailLeaseLost
	}
	var payload struct {
		InviteID  string `json:"inviteId"`
		TokenHash string `json:"tokenHash"`
	}
	if err := json.Unmarshal(g.item.Payload, &payload); err != nil {
		return "", false, err
	}
	current, err := hex.DecodeString(payload.TokenHash)
	if err != nil || len(current) != sha256.Size || payload.InviteID == "" {
		return "", false, errors.New("workspace invite email payload has no invite reference")
	}
	token, err := inviteToken()
	if err != nil {
		return "", false, err
	}
	next := inviteTokenHash(token)
	tag, err := g.tx.Exec(ctx, `UPDATE workspace_invites SET token_hash=$3
		WHERE id=$1 AND token_hash=$2 AND invited_user_id IS NOT NULL
			AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`,
		payload.InviteID, current, next[:])
	if err != nil {
		return "", false, err
	}
	if tag.RowsAffected() == 0 {
		return "", false, nil
	}
	if _, err := g.tx.Exec(ctx, `UPDATE email_outbox
		SET payload=jsonb_set(payload, '{tokenHash}', to_jsonb($2::text))
		WHERE id=$1`, g.item.ID, hex.EncodeToString(next[:])); err != nil {
		return "", false, err
	}
	return "/workspace-invites/" + token, true, nil
}

// ExpireWorkspaceInvites removes unaccepted invitations after their deadline.
// Associated in-app notifications are deleted by the foreign-key cascade.
// Queued email delivery is independent: its link may become invalid before the
// recipient opens it, and the acceptance path is the authority.
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
	result, err := s.AcceptWorkspaceInviteWithResult(ctx, reference, userID)
	return result.Member, err
}

// AcceptedInvite reports an acceptance: the new member, the recipient's invite
// notifications it removed, and the notification it created for the inviter.
type AcceptedInvite struct {
	Member                 WorkspaceMember
	RemovedNotificationIDs []string
	InviterNotification    *Notification
}

func (s *Store) AcceptWorkspaceInviteWithResult(ctx context.Context, reference, userID string) (AcceptedInvite, error) {
	member, removedIDs, inviterNotification, err := s.acceptWorkspaceInvite(ctx, reference, userID)
	return AcceptedInvite{
		Member:                 member,
		RemovedNotificationIDs: removedIDs,
		InviterNotification:    inviterNotification,
	}, err
}

func (s *Store) acceptWorkspaceInvite(ctx context.Context, reference, userID string) (WorkspaceMember, []string, *Notification, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	defer tx.Rollback(ctx)
	var invite WorkspaceInvite
	var ownerID string
	query := `SELECT wi.id, wi.workspace_id, COALESCE(wi.invited_user_id,''), wi.email,
		wi.role, wi.invited_by, wi.expires_at, wi.accepted_at, wi.revoked_at, wi.created_at,
		owner.id
		FROM workspace_invites wi
		JOIN workspaces w ON w.id=wi.workspace_id
		JOIN users owner ON owner.id=w.user_id
		WHERE wi.token_hash=$1
		  AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
		FOR UPDATE OF w, wi`
	var arg any
	if isInviteID(reference) {
		query = `SELECT wi.id, wi.workspace_id, COALESCE(wi.invited_user_id,''), wi.email,
			wi.role, wi.invited_by, wi.expires_at, wi.accepted_at, wi.revoked_at, wi.created_at,
			owner.id
			FROM workspace_invites wi
			JOIN workspaces w ON w.id=wi.workspace_id
			JOIN users owner ON owner.id=w.user_id
			WHERE wi.id=$1
			  AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
			FOR UPDATE OF w, wi`
		arg = reference
	} else {
		tokenHash := inviteTokenHash(reference)
		arg = tokenHash[:]
	}
	err = tx.QueryRow(ctx, query, arg).
		Scan(&invite.ID, &invite.WorkspaceID, &invite.InvitedUserID, &invite.Email, &invite.Role,
			&invite.InvitedBy, &invite.ExpiresAt, &invite.AcceptedAt, &invite.RevokedAt, &invite.CreatedAt,
			&ownerID)
	if isNoRows(err) {
		// A raw token can legally start with "inv_". Only an existing complete
		// invite id is treated as an id; otherwise always retry token-hash
		// lookup instead of rejecting a valid token by prefix alone.
		if isInviteID(reference) {
			tokenHash := inviteTokenHash(reference)
			err = tx.QueryRow(ctx, `SELECT wi.id, wi.workspace_id, COALESCE(wi.invited_user_id,''), wi.email,
				wi.role, wi.invited_by, wi.expires_at, wi.accepted_at, wi.revoked_at, wi.created_at,
				owner.id
				FROM workspace_invites wi
				JOIN workspaces w ON w.id=wi.workspace_id
				JOIN users owner ON owner.id=w.user_id
				WHERE wi.token_hash=$1
				  AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
					FOR UPDATE OF w, wi`, tokenHash[:]).
				Scan(&invite.ID, &invite.WorkspaceID, &invite.InvitedUserID, &invite.Email, &invite.Role,
					&invite.InvitedBy, &invite.ExpiresAt, &invite.AcceptedAt, &invite.RevokedAt, &invite.CreatedAt,
					&ownerID)
		}
	}
	if isNoRows(err) {
		return WorkspaceMember{}, nil, nil, ErrNotFound
	}
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	// The workspace lock makes ownership immutable while the owner and recipient
	// account rows are acquired in canonical ID order. Taking both accounts here
	// prevents reciprocal acceptances from locking the same pair in opposite
	// orders.
	if err := s.lockAccountSessionsTx(ctx, tx, ownerID, userID); err != nil {
		var locked *AccountLockedError
		if errors.As(err, &locked) && locked.UserID == ownerID {
			return WorkspaceMember{}, nil, nil, ErrNotFound
		}
		return WorkspaceMember{}, nil, nil, err
	}
	ownerStatus, err := s.accountAccess(ctx, tx, ownerID)
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	if ownerStatus.Err() != nil {
		// Invitation links use the same unavailable surface for an invalid token,
		// a closed workspace, and an owner whose lifecycle cannot widen access.
		return WorkspaceMember{}, nil, nil, ErrNotFound
	}
	if invite.AcceptedAt != nil || invite.RevokedAt != nil || time.Now().UTC().After(invite.ExpiresAt) {
		return WorkspaceMember{}, nil, nil, ErrNotFound
	}
	// Someone else's invite answers like a missing one, so neither an invite id
	// nor a token tells a caller which invites exist.
	if invite.InvitedUserID == "" || invite.InvitedUserID != userID {
		return WorkspaceMember{}, nil, nil, ErrNotFound
	}
	// Accepting is an edit a frozen recipient does not keep; the refusal is
	// theirs to hear about, so it stays account_over_quota.
	recipientStatus, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	if err := recipientStatus.Err(); err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	// Joining counts against the workspace cap with what it owns (Epo
	// 2026-10-28); a member already here only changes role.
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)`,
		invite.WorkspaceID, userID).Scan(&member); err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	if !member {
		if _, err := s.gateWorkspacesTx(ctx, tx, userID); err != nil {
			return WorkspaceMember{}, nil, nil, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,$3) ON CONFLICT (workspace_id,user_id)
		DO UPDATE SET role=CASE
			WHEN workspace_members.role='owner' THEN workspace_members.role
			ELSE EXCLUDED.role
		END, updated_at=now()`, invite.WorkspaceID, userID, invite.Role); err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE workspace_invites SET accepted_by=$2, accepted_at=now() WHERE id=$1`,
		invite.ID, userID); err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	// The account's other pending rows here (another address that reaches it)
	// stay listed for the owner as sent but go inert: a vanishing row would
	// tell the inviter both addresses are one account, and a second accept
	// could change the role (human authorization, 2026-10-21).
	rows, err := tx.Query(ctx, `WITH inert AS (
			UPDATE workspace_invites SET invited_user_id=NULL
			WHERE workspace_id=$1 AND invited_user_id=$2
				AND accepted_at IS NULL AND revoked_at IS NULL
			RETURNING id
		)
		DELETE FROM notifications
		WHERE workspace_invite_id=$3 OR workspace_invite_id IN (SELECT id FROM inert)
		RETURNING id`, invite.WorkspaceID, userID, invite.ID)
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	removedIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	var inviterNotification *Notification
	// Invites come from the owner; after a transfer the old owner no longer
	// manages the workspace, so only the current owner hears about it.
	if invite.InvitedBy == ownerID {
		n, err := notifyInviteAcceptedTx(ctx, tx, invite, userID)
		if err != nil {
			return WorkspaceMember{}, nil, nil, err
		}
		inviterNotification = &n
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	members, err := s.ListWorkspaceMembers(ctx, invite.WorkspaceID)
	if err != nil {
		return WorkspaceMember{}, nil, nil, err
	}
	for _, member := range members {
		if member.UserID == userID {
			return member, removedIDs, inviterNotification, nil
		}
	}
	return WorkspaceMember{}, nil, nil, ErrNotFound
}

// notifyInviteAcceptedTx tells the inviter, in-app and by email, that the
// invitee joined.
func notifyInviteAcceptedTx(ctx context.Context, tx pgx.Tx, invite WorkspaceInvite, memberID string) (Notification, error) {
	var workspaceName, memberName, inviterLocale string
	var inviterEmail *string
	if err := tx.QueryRow(ctx, `SELECT w.name, m.name, i.email, i.locale
		FROM workspaces w, users m, users i
		WHERE w.id=$1 AND m.id=$2 AND i.id=$3`,
		invite.WorkspaceID, memberID, invite.InvitedBy).
		Scan(&workspaceName, &memberName, &inviterEmail, &inviterLocale); err != nil {
		return Notification{}, err
	}
	data, err := json.Marshal(map[string]any{
		"code":          "workspace_invite_accepted",
		"workspaceId":   invite.WorkspaceID,
		"workspaceName": workspaceName,
		"memberId":      memberID,
		"memberName":    memberName,
		"role":          invite.Role,
	})
	if err != nil {
		return Notification{}, err
	}
	toEmail := ""
	if inviterEmail != nil {
		toEmail = *inviterEmail
	}
	result, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:         invite.InvitedBy,
		ToEmail:        toEmail,
		Locale:         inviterLocale,
		Kind:           NotifSystem,
		Data:           data,
		Href:           "/workspaces/" + invite.WorkspaceID,
		WorkspaceID:    invite.WorkspaceID,
		Template:       "workspace-invite-accepted",
		Category:       "workspace_invite",
		IdempotencyKey: "workspace-invite-accepted:" + invite.ID,
	})
	if err != nil {
		return Notification{}, err
	}
	return result.Notification, nil
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
