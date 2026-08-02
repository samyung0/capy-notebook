package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	defaultNotificationLimit = 50
	maxNotificationLimit     = 100
)

type NotificationPage struct {
	Items []Notification `json:"items" nullable:"false"`
	Next  string         `json:"next,omitempty"`
}

type NotificationRemoval struct {
	UserID string
	ID     string
}

type notificationCursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func encodeNotificationCursor(at time.Time, id string) string {
	raw, err := json.Marshal(notificationCursor{At: at.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeNotificationCursor(value string) (notificationCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return notificationCursor{}, fmt.Errorf("invalid notification cursor")
	}
	var cursor notificationCursor
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.ID == "" || cursor.At.IsZero() {
		return notificationCursor{}, fmt.Errorf("invalid notification cursor")
	}
	return cursor, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

type NotificationParams struct {
	UserID            string
	Kind              NotificationKind
	Data              json.RawMessage
	Href              string
	WorkspaceID       string
	WorkspaceInviteID string
	At                time.Time
}

// ListNotifications returns the newest notifications first. The cursor is an
// opaque encoding of the complete (at,id) ordering tuple, so rows sharing a
// timestamp cannot be skipped or repeated when new notifications arrive.
func (s *Store) ListNotifications(ctx context.Context, userID string, limit int, before string) (NotificationPage, error) {
	if limit <= 0 {
		limit = defaultNotificationLimit
	}
	if limit > maxNotificationLimit {
		limit = maxNotificationLimit
	}

	var cursorAt any
	cursorID := ""
	if before != "" {
		cursor, err := decodeNotificationCursor(before)
		if err != nil {
			return NotificationPage{}, err
		}
		cursorAt = cursor.At
		cursorID = cursor.ID
	}

	rows, err := s.pool.Query(ctx, `SELECT n.id, n.kind, n.data, COALESCE(n.href,''),
			n.at, n.read_at, COALESCE(n.workspace_id,''), COALESCE(n.workspace_invite_id,'')
		FROM notifications n
		WHERE n.user_id=$1
			AND ($2::timestamptz IS NULL OR (n.at,n.id) < ($2::timestamptz,$3::text))
			AND (
				n.workspace_invite_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workspace_invites wi
					WHERE wi.id=n.workspace_invite_id
						AND wi.accepted_at IS NULL
						AND wi.revoked_at IS NULL
						AND wi.expires_at>now()
				)
			)
		ORDER BY n.at DESC, n.id DESC
		LIMIT $4`, userID, cursorAt, cursorID, limit+1)
	if err != nil {
		return NotificationPage{}, err
	}
	defer rows.Close()

	out := make([]Notification, 0, limit)
	for rows.Next() {
		var n Notification
		if err := rows.Scan(
			&n.ID,
			&n.Kind,
			&n.Data,
			&n.Href,
			&n.At,
			&n.ReadAt,
			&n.WorkspaceID,
			&n.WorkspaceInviteID,
		); err != nil {
			return NotificationPage{}, err
		}
		n.UserID = userID
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return NotificationPage{}, err
	}
	page := NotificationPage{Items: out}
	if len(out) > limit {
		page.Items = out[:limit]
		last := page.Items[len(page.Items)-1]
		page.Next = encodeNotificationCursor(last.At, last.ID)
	}
	return page, nil
}

// Notifications is retained as the compatibility helper used by store callers
// that do not need cursor pagination.
func (s *Store) Notifications(ctx context.Context, userID string) ([]Notification, error) {
	page, err := s.ListNotifications(ctx, userID, maxNotificationLimit, "")
	return page.Items, err
}

func (s *Store) UnreadNotificationCount(ctx context.Context, userID string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT count(*)
		FROM notifications n
		WHERE n.user_id=$1 AND n.read_at IS NULL
			AND (
				n.workspace_invite_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workspace_invites wi
					WHERE wi.id=n.workspace_invite_id
						AND wi.accepted_at IS NULL
						AND wi.revoked_at IS NULL
						AND wi.expires_at>now()
				)
			)`, userID).Scan(&count)
	return count, err
}

func (s *Store) MarkNotificationRead(ctx context.Context, userID, notificationID string) (bool, error) {
	var id string
	err := s.pool.QueryRow(ctx, `UPDATE notifications
		SET read_at=COALESCE(read_at, now())
		WHERE id=$1 AND user_id=$2 AND read_at IS NULL
		RETURNING id`, notificationID, userID).Scan(&id)
	if isNoRows(err) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) MarkAllNotificationsRead(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `UPDATE notifications
		SET read_at=now()
		WHERE user_id=$1 AND read_at IS NULL
		RETURNING id`, userID)
	if err != nil {
		return nil, err
	}
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

// MarkNotificationsRead is the legacy bulk-mark helper.
func (s *Store) MarkNotificationsRead(ctx context.Context, userID string) error {
	_, err := s.MarkAllNotificationsRead(ctx, userID)
	return err
}

func CreateNotificationTx(ctx context.Context, tx pgx.Tx, params NotificationParams) (Notification, error) {
	data := params.Data
	if len(data) == 0 {
		data = json.RawMessage(`{}`)
	}
	at := params.At
	if at.IsZero() {
		at = time.Now().UTC()
	}

	var n Notification
	err := tx.QueryRow(ctx, `INSERT INTO notifications
			(id, user_id, kind, data, href, workspace_id, workspace_invite_id, at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id, kind, data, COALESCE(href,''), at, read_at,
			COALESCE(workspace_id,''), COALESCE(workspace_invite_id,'')`,
		uid("ntf"),
		params.UserID,
		params.Kind,
		data,
		nullableString(params.Href),
		nullableString(params.WorkspaceID),
		nullableString(params.WorkspaceInviteID),
		at,
	).Scan(
		&n.ID,
		&n.Kind,
		&n.Data,
		&n.Href,
		&n.At,
		&n.ReadAt,
		&n.WorkspaceID,
		&n.WorkspaceInviteID,
	)
	n.UserID = params.UserID
	return n, err
}

func (s *Store) GetNotificationPrefs(ctx context.Context, userID string) (NotificationPrefs, error) {
	var prefs NotificationPrefs
	err := s.pool.QueryRow(ctx, `SELECT
			COALESCE(email_workspace_invite, true),
			COALESCE(email_membership, true)
		FROM notification_prefs
		WHERE user_id=$1`, userID).Scan(
		&prefs.EmailWorkspaceInvite,
		&prefs.EmailMembership,
	)
	if isNoRows(err) {
		return NotificationPrefs{
			EmailWorkspaceInvite: true,
			EmailMembership:      true,
		}, nil
	}
	return prefs, err
}

func (s *Store) SetNotificationPrefs(ctx context.Context, userID string, prefs NotificationPrefs) (NotificationPrefs, error) {
	_, err := s.pool.Exec(ctx, `INSERT INTO notification_prefs
			(user_id, email_workspace_invite, email_membership, updated_at)
		VALUES ($1,$2,$3,now())
		ON CONFLICT (user_id) DO UPDATE SET
			email_workspace_invite=EXCLUDED.email_workspace_invite,
			email_membership=EXCLUDED.email_membership,
			updated_at=now()`,
		userID, prefs.EmailWorkspaceInvite, prefs.EmailMembership)
	return prefs, err
}

// DisableNotificationCategory changes exactly one category. Keeping this
// update atomic avoids a concurrent unsubscribe for another category being
// overwritten by a stale read-modify-write of the full preference row.
func (s *Store) DisableNotificationCategory(ctx context.Context, userID, category string) error {
	var column string
	switch category {
	case "workspace_invite":
		column = "email_workspace_invite"
	case "membership":
		column = "email_membership"
	default:
		return fmt.Errorf("invalid notification category %q", category)
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO notification_prefs
			(user_id, email_workspace_invite, email_membership, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (user_id) DO UPDATE SET `+column+`=false, updated_at=now()`,
		userID, category == "membership", category == "workspace_invite")
	return err
}

func notificationEmailEnabled(ctx context.Context, tx pgx.Tx, userID, category string) (bool, error) {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT CASE
			WHEN $2='workspace_invite' THEN COALESCE(email_workspace_invite, true)
			WHEN $2='membership' THEN COALESCE(email_membership, true)
			ELSE true
		END
		FROM users u
		LEFT JOIN notification_prefs p ON p.user_id=u.id
		WHERE u.id=$1`, userID, category).Scan(&enabled)
	return enabled, err
}
