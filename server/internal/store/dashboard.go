package store

import (
	"context"
	"time"
)

// A workspace's Dashboard (Epo 2026-11-02, boards H1 and H2): who runs it,
// how many members it has, and its latest activity. No activity log exists,
// so the activity is read from what the rows already record: each file's
// uploader and upload time, each material's creator and creation time, and
// whether the chat agent created the material. An item hidden from members
// shows only to the workspace's owners and editors, with its mark (board U1).

// dashboardActivity caps the Dashboard's Activity list.
const dashboardActivity = 5

const (
	ActivityUploaded = "uploaded"
	ActivityAdded    = "added"
	// ActivityAgent is a material the chat agent made for the caller.
	ActivityAgent = "agent"
)

type WorkspaceDashboard struct {
	// OwnerName is the owner's display name.
	OwnerName string `json:"ownerName"`
	// Members counts the workspace's members, the owner included.
	Members  int                 `json:"members"`
	Activity []WorkspaceActivity `json:"activity" nullable:"false"`
}

// WorkspaceActivity is one file uploaded or material added, newest first.
// Actor fields are empty once the account is gone.
type WorkspaceActivity struct {
	Kind           string    `json:"kind" enum:"uploaded,added,agent"`
	ActorID        string    `json:"actorId,omitempty"`
	ActorName      string    `json:"actorName,omitempty"`
	ActorAvatarURL string    `json:"actorAvatarUrl,omitempty"`
	FileID         *string   `json:"fileId,omitempty"`
	MaterialID     *string   `json:"materialId,omitempty"`
	Title          string    `json:"title"`
	At             time.Time `json:"at"`
	// Hidden: the item is hidden from members; only owners and editors get it.
	Hidden bool `json:"hidden,omitempty"`
}

func (s *Store) WorkspaceDashboard(ctx context.Context, userID, wsID string) (WorkspaceDashboard, error) {
	out := WorkspaceDashboard{Activity: []WorkspaceActivity{}}
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(u.name,''), u.id),
			(SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id=w.id)
		FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.id=$1`, wsID).
		Scan(&out.OwnerName, &out.Members); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `WITH a AS (
			(SELECT 'uploaded' AS kind, f.created_by AS actor, f.id AS file_id, NULL::text AS material_id,
				f.name AS title, f.added_at AS at, false AS agent, f.hidden AS hidden
			FROM files f WHERE f.workspace_id=$1 AND f.trashed_at IS NULL
				AND workspace_item_visible(f.hidden, f.workspace_id, $2)
			ORDER BY f.added_at DESC LIMIT $3)
			UNION ALL
			(SELECT 'added', m.created_by, NULL, m.id, m.title, m.created_at,
				EXISTS (SELECT 1 FROM agent_operations ao WHERE ao.workspace_id=m.workspace_id
					AND ao.kind='create_material' AND ao.outcome='succeeded'
					AND ao.effect->'resource'->>'id' = m.id), m.hidden
			FROM materials m WHERE m.workspace_id=$1 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
				AND workspace_item_visible(m.hidden, m.workspace_id, $2)
			ORDER BY m.created_at DESC LIMIT $3))
		SELECT CASE WHEN a.agent AND a.actor = $2 THEN 'agent' ELSE a.kind END,
			COALESCE(a.actor, ''), COALESCE(NULLIF(u.name,''), u.id, ''),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, ''),
			a.file_id, a.material_id, a.title, a.at, a.hidden
		FROM a LEFT JOIN users u ON u.id=a.actor
		ORDER BY a.at DESC LIMIT $3`, wsID, userID, dashboardActivity)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var it WorkspaceActivity
		if err := rows.Scan(&it.Kind, &it.ActorID, &it.ActorName, &it.ActorAvatarURL,
			&it.FileID, &it.MaterialID, &it.Title, &it.At, &it.Hidden); err != nil {
			return out, err
		}
		out.Activity = append(out.Activity, it)
	}
	return out, rows.Err()
}
