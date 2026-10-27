package store

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Account chat's reach (Epo 2026-10-27, D2, D3): the caller's owned and member
// workspaces under a live owner (memberWorkspacesSQL) and their own
// standalone files and materials. An item is read with any role there and
// edited with an editor's: its workspace's effective role, or owner of a
// standalone item. Every account-scope tool call checks its target here.

// accountScopeSQL lists the scope's workspaces with their names and whether
// user may edit their content (the effective role: owner, member editor, or a
// member raised by an editor share role). It is a CTE body.
func accountScopeSQL(user string) string {
	return `SELECT w.id, w.name,
		(w.user_id=` + user + ` OR sm.role IN ('owner','editor')
			OR (w.share_role='editor' AND w.privacy IN ('link','public'))) AS can_edit
		FROM workspaces w
		LEFT JOIN workspace_members sm ON sm.workspace_id=w.id AND sm.user_id=` + user + `
		WHERE w.id IN (` + memberWorkspacesSQL(user) + `)`
}

// liveCallerSQL holds while user's account is neither deleted nor pending
// deletion, the standalone owner check FileEffectiveRole makes.
func liveCallerSQL(user string) string {
	return `EXISTS (SELECT 1 FROM users lc WHERE lc.id=` + user + `
		AND lc.deleted_at IS NULL AND lc.deletion_requested_at IS NULL)`
}

// AccountScopeWorkspaces lists the ids of the workspaces an account chat of
// userID searches.
func (s *Store) AccountScopeWorkspaces(ctx context.Context, userID string) ([]string, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT id FROM (`+memberWorkspacesSQL("$1")+`) s(id) ORDER BY id`, userID)
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

// AccountScopeEditable says whether wsID is in userID's account scope with an
// editor's role, where an account chat may create.
func (s *Store) AccountScopeEditable(ctx context.Context, userID, wsID string) (bool, error) {
	var editable bool
	err := s.pool.QueryRow(ctx, `WITH scope AS (`+accountScopeSQL("$1")+`)
		SELECT COALESCE((SELECT can_edit FROM scope WHERE id=$2), false)`, userID, wsID).Scan(&editable)
	return editable, err
}

// DocumentAccess is the caller's access to one file or material in their
// account scope. An item they cannot read carries no workspace.
type DocumentAccess struct {
	Kind          agenttools.ResourceKind `json:"kind" enum:"source_file,material"`
	ID            string                  `json:"id"`
	WorkspaceID   string                  `json:"workspaceId"`
	WorkspaceName string                  `json:"workspaceName"`
	CanRead       bool                    `json:"canRead"`
	CanEdit       bool                    `json:"canEdit"`
	// Title is the item's name, for the made-from line of what is created
	// from it.
	Title string `json:"-"`
}

// AccountDocumentAccess answers each item in order, in one query: a file or
// top-level material (an embedded one as its note) of a scope workspace, with
// that workspace's role, or the caller's own standalone item. Trashed and
// missing items are unreadable.
func (s *Store) AccountDocumentAccess(ctx context.Context, userID string, items []agenttools.ResourceRef) ([]DocumentAccess, error) {
	out := make([]DocumentAccess, len(items))
	if len(items) == 0 {
		return out, nil
	}
	kinds, ids := make([]string, len(items)), make([]string, len(items))
	for i, item := range items {
		kinds[i], ids[i] = string(item.Kind), item.ID
		out[i] = DocumentAccess{Kind: item.Kind, ID: item.ID}
	}
	rows, err := s.pool.Query(ctx, `
		WITH scope AS (`+accountScopeSQL("$1")+`),
		req AS (SELECT kind, id, ord FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS r(kind, id, ord)),
		item AS (
			SELECT req.ord,
				CASE WHEN req.kind='source_file' THEN f.workspace_id ELSE COALESCE(p.workspace_id, m.workspace_id) END AS ws,
				CASE WHEN req.kind='source_file' THEN f.user_id ELSE COALESCE(p.owner_user_id, m.owner_user_id) END AS owner,
				COALESCE(f.name, m.title, '') AS title
			FROM req
			LEFT JOIN files f ON req.kind='source_file' AND f.id=req.id AND f.trashed_at IS NULL
			LEFT JOIN materials m ON req.kind='material' AND m.id=req.id AND m.trashed_at IS NULL
			LEFT JOIN materials p ON p.id=m.parent_material_id AND p.trashed_at IS NULL
			WHERE f.id IS NOT NULL OR (m.id IS NOT NULL AND (m.parent_material_id IS NULL OR p.id IS NOT NULL))
		)
		SELECT i.ord, COALESCE(sc.id, ''), COALESCE(sc.name, ''), i.title,
			COALESCE(sc.can_edit, i.ws IS NULL AND i.owner=$1)
		FROM item i LEFT JOIN scope sc ON sc.id=i.ws
		WHERE `+liveCallerSQL("$1")+` AND (sc.id IS NOT NULL OR (i.ws IS NULL AND i.owner=$1))`,
		userID, kinds, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			ord  int64
			read DocumentAccess
		)
		if err := rows.Scan(&ord, &read.WorkspaceID, &read.WorkspaceName, &read.Title, &read.CanEdit); err != nil {
			return nil, err
		}
		row := &out[ord-1]
		row.WorkspaceID, row.WorkspaceName, row.Title, row.CanEdit = read.WorkspaceID, read.WorkspaceName, read.Title, read.CanEdit
		row.CanRead = true
	}
	return out, rows.Err()
}

// AccountDocument is one row of an account chat's file listing: a file or
// top-level material of the scope, with its workspace ("" for No workspace)
// and whether the caller may edit it there.
type AccountDocument struct {
	Kind          agenttools.ResourceKind
	ID, Title     string
	FileKind      string // a file's kind
	MaterialKind  string // a material's kind
	ChapterID     *string
	WorkspaceID   string
	WorkspaceName string
	CanEdit       bool
}

// AccountDocuments lists the untrashed files, then the top-level materials, of
// userID's account scope and their standalone ones, each by workspace name
// (No workspace first) and then in workspace order.
func (s *Store) AccountDocuments(ctx context.Context, userID string) ([]AccountDocument, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		WITH scope AS (`+accountScopeSQL("$1")+`)
		SELECT kind, id, title, file_kind, material_kind, chapter_id, ws, ws_name, can_edit FROM (
			SELECT 0 AS part, 'source_file' AS kind, f.id, f.name AS title, f.kind AS file_kind,
				'' AS material_kind, f.chapter_id, COALESCE(sc.id, '') AS ws, COALESCE(sc.name, '') AS ws_name,
				COALESCE(sc.can_edit, true) AS can_edit, f.position, f.added_at AS at
			FROM files f LEFT JOIN scope sc ON sc.id=f.workspace_id
			WHERE f.trashed_at IS NULL AND (sc.id IS NOT NULL OR (f.workspace_id IS NULL AND f.user_id=$1))
			UNION ALL
			SELECT 1, 'material', m.id, m.title, '', m.kind, m.chapter_id, COALESCE(sc.id, ''),
				COALESCE(sc.name, ''), COALESCE(sc.can_edit, true), m.position, m.created_at
			FROM materials m LEFT JOIN scope sc ON sc.id=m.workspace_id
			WHERE m.trashed_at IS NULL AND m.parent_material_id IS NULL
				AND (sc.id IS NOT NULL OR (m.workspace_id IS NULL AND m.owner_user_id=$1))
		) d
		WHERE `+liveCallerSQL("$1")+`
		ORDER BY part, ws_name, ws, position, at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccountDocument{}
	for rows.Next() {
		var (
			d    AccountDocument
			kind string
		)
		if err := rows.Scan(&kind, &d.ID, &d.Title, &d.FileKind, &d.MaterialKind, &d.ChapterID,
			&d.WorkspaceID, &d.WorkspaceName, &d.CanEdit); err != nil {
			return nil, err
		}
		d.Kind = agenttools.ResourceKind(kind)
		out = append(out, d)
	}
	return out, rows.Err()
}
