package store

import (
	"context"

	"github.com/jackc/pgx/v5"

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

// ScopeWorkspace is one workspace of an account chat's scope: its name and
// whether the caller may edit its content.
type ScopeWorkspace struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	CanEdit bool   `json:"canEdit"`
}

// AccountScope lists the workspaces an account chat of userID reaches, sent
// with each turn so search labels its hits without asking again (Epo
// 2026-10-28); the workspace cap keeps it to at most 50.
func (s *Store) AccountScope(ctx context.Context, userID string) ([]ScopeWorkspace, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `SELECT id, name, can_edit FROM (`+accountScopeSQL("$1")+`) s ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScopeWorkspace{}
	for rows.Next() {
		var w ScopeWorkspace
		if err := rows.Scan(&w.ID, &w.Name, &w.CanEdit); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
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
	// What the item is, for an account read's Access line (Epo 2026-10-28):
	// a file's format (the handler maps FileKind as documents/list does) or a
	// material's kind.
	FileKind     string `json:"-"`
	Format       string `json:"format,omitempty"`
	MaterialKind string `json:"materialKind,omitempty"`
	// Editable is CanEdit for an item whose format can be edited (a PDF
	// cannot), which the handler fills as documents/list does.
	Editable bool `json:"editable"`
	// MovedOut marks an unreadable file the user's account chat edited, which
	// still exists out of their reach (Q468's rule, Epo 2026-10-28): the chat
	// may say it was moved; anything else stays a plain not found.
	MovedOut bool `json:"movedOut,omitempty"`
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
				COALESCE(f.name, m.title, '') AS title, COALESCE(f.kind, '') AS file_kind,
				COALESCE(m.kind, '') AS material_kind
			FROM req
			LEFT JOIN files f ON req.kind='source_file' AND f.id=req.id AND f.trashed_at IS NULL
			LEFT JOIN materials m ON req.kind='material' AND m.id=req.id AND m.trashed_at IS NULL
			LEFT JOIN materials p ON p.id=m.parent_material_id AND p.trashed_at IS NULL
			WHERE f.id IS NOT NULL OR (m.id IS NOT NULL AND (m.parent_material_id IS NULL OR p.id IS NOT NULL))
		)
		SELECT i.ord, COALESCE(sc.id, ''), COALESCE(sc.name, ''), i.title, i.file_kind, i.material_kind,
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
		if err := rows.Scan(&ord, &read.WorkspaceID, &read.WorkspaceName, &read.Title, &read.FileKind,
			&read.MaterialKind, &read.CanEdit); err != nil {
			return nil, err
		}
		read.Kind, read.ID, read.CanRead = out[ord-1].Kind, out[ord-1].ID, true
		out[ord-1] = read
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// The unreadable files this user's account chat edited, in one more query
	// for all of them (review r1 E2).
	unread := map[string][]int{}
	var unreadIDs []string
	for i, row := range out {
		if !row.CanRead && row.Kind == agenttools.KindSourceFile {
			if _, seen := unread[row.ID]; !seen {
				unreadIDs = append(unreadIDs, row.ID)
			}
			unread[row.ID] = append(unread[row.ID], i)
		}
	}
	if len(unreadIDs) == 0 {
		return out, nil
	}
	moved, err := s.accountChatEditedElsewhere(ctx, userID, unreadIDs)
	if err != nil {
		return nil, err
	}
	for _, id := range moved {
		for _, i := range unread[id] {
			out[i].MovedOut = true
		}
	}
	return out, nil
}

// accountChatEditedElsewhere lists which of these files the user's account
// chat edited and that still exist (untrashed) where they can no longer read
// them.
func (s *Store) accountChatEditedElsewhere(ctx context.Context, userID string, fileIDs []string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT f.id FROM files f
		WHERE f.id = ANY($2::text[]) AND f.trashed_at IS NULL AND EXISTS (
			SELECT 1 FROM agent_operations ao JOIN conversations c ON c.id=ao.conversation_id
			WHERE c.user_id=$1 AND c.workspace_id IS NULL AND ao.kind='edit_document'
			  AND ao.effect->'resource'->>'kind'='source_file' AND ao.effect->'resource'->>'id'=f.id)`,
		userID, fileIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// AccountDocument is one row of an account chat's file listing: a file or
// top-level material of the scope, with its workspace and chapter ("" and nil
// for No workspace), its descriptor (empty when it has none) and whether the
// caller may edit it there.
type AccountDocument struct {
	Kind          agenttools.ResourceKind
	ID, Title     string
	FileKind      string // a file's kind
	MaterialKind  string // a material's kind
	ChapterID     *string
	ChapterName   string
	WorkspaceID   string
	WorkspaceName string
	CanEdit       bool
	Descriptor    string
}

// AccountDocumentPlace is which of an account chat's items a listing reads
// (Epo 2026-10-28): one scope workspace's (WorkspaceID), or else the caller's
// items with no workspace, newest first and at most Limit.
type AccountDocumentPlace struct {
	WorkspaceID string
	Limit       int
}

// AccountDocuments lists the untrashed files, then the top-level materials, of
// place: a workspace's in its order, or with no workspace newest first. A
// workspace outside the scope lists nothing.
func (s *Store) AccountDocuments(ctx context.Context, userID string, place AccountDocumentPlace) ([]AccountDocument, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	where, order, limit := `d.ws_id = $2`, `d.part, d.position, d.at DESC`, ""
	args := []any{userID, place.WorkspaceID}
	if place.WorkspaceID == "" {
		where, order, args = `d.ws_id IS NULL`, `d.at DESC, d.id`, args[:1]
		if place.Limit > 0 {
			limit = ` LIMIT $2`
			args = append(args, place.Limit)
		}
	}
	// An item with no workspace is the caller's own, so they edit it.
	rows, err := s.pool.Query(ctx, `
		WITH scope AS (`+accountScopeSQL("$1")+`)
		SELECT d.kind, d.id, d.title, d.file_kind, d.material_kind, d.chapter_id, COALESCE(ch.name, ''),
			COALESCE(sc.id, '') AS ws, COALESCE(sc.name, '') AS ws_name, COALESCE(sc.can_edit, true),
			COALESCE(rs.descriptor, '')
		FROM (
			SELECT 0 AS part, 'source_file' AS kind, f.id, f.name AS title, f.kind AS file_kind,
				'' AS material_kind, f.chapter_id, f.workspace_id AS ws_id, f.position, f.added_at AS at,
				fc.content_id
			FROM files f LEFT JOIN rag_file_contents fc ON fc.file_id=f.id
			WHERE f.trashed_at IS NULL
				AND (f.workspace_id IN (SELECT id FROM scope) OR (f.workspace_id IS NULL AND f.user_id=$1))
			UNION ALL
			SELECT 1, 'material', m.id, m.title, '', m.kind, m.chapter_id, m.workspace_id, m.position,
				m.created_at, mc.content_id
			FROM materials m LEFT JOIN rag_material_contents mc ON mc.material_id=m.id
			WHERE m.trashed_at IS NULL AND m.parent_material_id IS NULL
				AND (m.workspace_id IN (SELECT id FROM scope) OR (m.workspace_id IS NULL AND m.owner_user_id=$1))
		) d
		LEFT JOIN scope sc ON sc.id=d.ws_id
		LEFT JOIN chapters ch ON ch.id=d.chapter_id
		LEFT JOIN rag_content_summaries rs ON rs.content_id=d.content_id
		WHERE `+liveCallerSQL("$1")+` AND `+where+`
		ORDER BY `+order+limit, args...)
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
		if err := rows.Scan(&kind, &d.ID, &d.Title, &d.FileKind, &d.MaterialKind, &d.ChapterID, &d.ChapterName,
			&d.WorkspaceID, &d.WorkspaceName, &d.CanEdit, &d.Descriptor); err != nil {
			return nil, err
		}
		d.Kind = agenttools.ResourceKind(kind)
		out = append(out, d)
	}
	return out, rows.Err()
}
