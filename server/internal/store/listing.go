package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrInvalidCursor is a malformed or foreign page cursor: a client error.
var ErrInvalidCursor = errors.New("invalid cursor")

// Filtered, sorted, keyset-paginated listings behind the Create and Files
// pages. Both list what the caller owns or pays for: materials and files in
// their own workspaces, everything they uploaded or created wherever it sits
// (uploader pays, Sam 2026-10-18), and their standalone materials. Member
// widens that to every workspace the caller belongs to, as the dashboard
// recents do. A row in a workspace the caller no longer owns or belongs to is
// marked LostAccess and carries no preview or thumbnail: they may only delete
// it.

// liveWorkspaceSQL is true when wsCol names a workspace whose owner's account
// is live (not deleted, pending deletion or suspended); every other path
// answers such a workspace with a non-disclosing 404.
func liveWorkspaceSQL(wsCol string) string {
	return `EXISTS (SELECT 1 FROM workspaces lw JOIN users lo ON lo.id=lw.user_id WHERE lw.id=` + wsCol + `
		AND lo.deleted_at IS NULL AND lo.deletion_requested_at IS NULL AND lo.suspended_at IS NULL)`
}

// lostAccessSQL is true for a row in a workspace (wsCol, "" or NULL when
// standalone) that user can no longer open: neither owner nor reaching it
// as member, through a public share or a redeemed link (linkReachSQL), or its
// owner's account is no longer live.
func lostAccessSQL(wsCol, user string) string {
	return `COALESCE(` + wsCol + ` <> '' AND NOT EXISTS (SELECT 1 FROM workspaces la WHERE la.id=` + wsCol + `
		AND (la.user_id=` + user + ` OR ` + linkReachSQL("la", user) + `)
		AND ` + liveWorkspaceSQL("la.id") + `), false)`
}

// workspaceNameSQL hides a workspace's name once its owner's account is no
// longer live, like every other read of that workspace.
func workspaceNameSQL(wsCol, nameCol string) string {
	return `CASE WHEN COALESCE(` + wsCol + `,'') <> '' AND NOT ` + liveWorkspaceSQL(wsCol) + ` THEN '' ELSE ` + nameCol + ` END`
}

// withExtra scans a listing row's columns plus extra trailing ones.
type withExtra struct {
	row   interface{ Scan(...any) error }
	extra []any
}

func (w withExtra) Scan(dest ...any) error { return w.row.Scan(append(dest, w.extra...)...) }

// memberWorkspace is the Member predicate on a workspace id column: the
// caller ($1) is a member and the owner's account is live (not deleted,
// pending deletion or suspended), the same rule as ListWorkspaces. The query
// must JOIN users AS owner on the workspace owner.
func memberWorkspace(column string) string {
	return `EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=` + column + ` AND wm.user_id=$1)
		AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL AND owner.suspended_at IS NULL`
}

const listPageMax = 100

// listSort names the primary sort column; the row id breaks ties so a cursor
// always resumes exactly after the last row served.
type listSort struct {
	column string
	kind   string // time | text | int
}

func encodeListCursor(primary, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(primary + "|" + id))
}

func decodeListCursor(cursor string) (primary, id string, ok bool, err error) {
	if cursor == "" {
		return "", "", false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", false, ErrInvalidCursor
	}
	primary, id, found := strings.Cut(string(raw), "|")
	if !found {
		return "", "", false, ErrInvalidCursor
	}
	return primary, id, true, nil
}

// cursorClause returns the keyset predicate for one page and the typed cursor
// arguments, numbered from next.
func cursorClause(sort listSort, idColumn string, ascending bool, cursor string, next int) (string, []any, error) {
	primary, id, ok, err := decodeListCursor(cursor)
	if err != nil || !ok {
		return "", nil, err
	}
	var value any = primary
	switch sort.kind {
	case "time":
		at, err := time.Parse(time.RFC3339Nano, primary)
		if err != nil {
			return "", nil, ErrInvalidCursor
		}
		value = at
	case "int":
		var n int64
		if _, err := fmt.Sscanf(primary, "%d", &n); err != nil {
			return "", nil, ErrInvalidCursor
		}
		value = n
	}
	op := "<"
	if ascending {
		op = ">"
	}
	cast := map[string]string{"time": "timestamptz", "text": "text", "int": "bigint"}[sort.kind]
	clause := fmt.Sprintf(" AND (%s, %s) %s ($%d::%s, $%d::text)", sort.column, idColumn, op, next, cast, next+1)
	return clause, []any{value, id}, nil
}

func orderClause(sort listSort, idColumn string, ascending bool) string {
	dir := "DESC"
	if ascending {
		dir = "ASC"
	}
	return fmt.Sprintf(" ORDER BY %s %s, %s %s", sort.column, dir, idColumn, dir)
}

func cursorPrimary(sort listSort, at time.Time, text string, n int64) string {
	switch sort.kind {
	case "time":
		return at.UTC().Format(time.RFC3339Nano)
	case "int":
		return fmt.Sprintf("%d", n)
	}
	return text
}

/* ---------------------------------------------------------------- materials */

var materialListSorts = map[string]listSort{
	"updated": {column: "m.updated_at", kind: "time"},
	"created": {column: "m.created_at", kind: "time"},
	"title":   {column: "lower(m.title)", kind: "text"},
	"kind":    {column: "m.kind", kind: "text"},
	// Standalone rows have no workspace name and sort first ascending.
	"workspace": {column: "lower(m.workspace_name)", kind: "text"},
}

// materialLocations are the Locations values: rows in or outside a
// workspace. Embedded rows (parent_material_id set) are never listed; they
// open only inside their note.
var materialLocations = map[string]string{
	"workspace":  `m.workspace_id IS NOT NULL`,
	"standalone": `m.workspace_id IS NULL`,
}

// MaterialListFilter narrows the owner's materials. Empty slices mean no
// filter; Locations holds materialLocations keys.
type MaterialListFilter struct {
	Kinds        []string
	WorkspaceIDs []string
	Locations    []string
	Member       bool
	Sort         string
	Ascending    bool
	Limit        int
	Cursor       string
}

// MaterialListItem is one Create page row: enough to render the card without
// loading the document, plus the per-kind counts the card shows.
type MaterialListItem struct {
	ID            string       `json:"id"`
	Kind          MaterialKind `json:"kind"`
	Title         string       `json:"title"`
	WorkspaceID   string       `json:"workspaceId"`
	WorkspaceName string       `json:"workspaceName"`
	ChapterID     *string      `json:"chapterId"`
	ChapterName   string       `json:"chapterName"`
	Privacy       Privacy      `json:"privacy"`
	// SharePath is the signed share link of a standalone quiz or flashcard set.
	SharePath     string          `json:"sharePath,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	SizeBytes     int64           `json:"sizeBytes"`
	QuestionCount *int            `json:"questionCount,omitempty"`
	CardCount     *int            `json:"cardCount,omitempty"`
	Preview       MaterialPreview `json:"preview,omitempty"`
	LostAccess    bool            `json:"lostAccess,omitempty" doc:"The item sits in a workspace the caller no longer owns or belongs to; they still pay for it and may only delete it"`
}

type MaterialPage struct {
	Items      []MaterialListItem `json:"items" nullable:"false"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

// ListOwnedMaterials pages through the caller's notes, quizzes and flashcard
// sets: rows they own in their own workspaces plus their standalone rows, and
// with Member the rows of every workspace they belong to. Embedded rows are
// left out.
func (s *Store) ListOwnedMaterials(ctx context.Context, ownerID string, f MaterialListFilter) (MaterialPage, error) {
	sort, ok := materialListSorts[f.Sort]
	if !ok {
		sort = materialListSorts["updated"]
	}
	if f.Limit <= 0 || f.Limit > listPageMax {
		f.Limit = listPageMax
	}
	kinds := f.Kinds
	if len(kinds) == 0 {
		kinds = []string{"note", "quiz", "flashcards"}
	}
	args := []any{ownerID, kinds}
	where := ` WHERE (m.owner_user_id=$1 OR w.user_id=$1)`
	if f.Member {
		where = ` WHERE (m.owner_user_id=$1 OR w.user_id=$1 OR (` + memberWorkspace("m.workspace_id") + `))`
	}
	where += ` AND m.trashed_at IS NULL AND m.parent_material_id IS NULL AND m.kind = ANY($2)`
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND m.workspace_id = ANY($%d)`, len(args))
	}
	if len(f.Locations) > 0 {
		preds := make([]string, 0, len(f.Locations))
		for _, location := range f.Locations {
			pred, ok := materialLocations[location]
			if !ok {
				return MaterialPage{}, fmt.Errorf("unknown material location %q", location)
			}
			preds = append(preds, pred)
		}
		where += ` AND (` + strings.Join(preds, " OR ") + `)`
	}
	clause, cursorArgs, err := cursorClause(sort, "m.id", f.Ascending, f.Cursor, len(args)+1)
	if err != nil {
		return MaterialPage{}, err
	}
	where += clause
	args = append(args, cursorArgs...)
	args = append(args, f.Limit+1)
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.kind, m.title, COALESCE(m.workspace_id,''), `+workspaceNameSQL("m.workspace_id", "m.workspace_name")+`,
			m.chapter_id, COALESCE(c.name,''),
			m.privacy, m.created_at, m.updated_at, m.size_bytes,
			CASE WHEN m.kind='quiz' THEN (SELECT (SELECT count(*) FROM jsonb_array_elements(elem->'children') child WHERE child->>'type'='quiz_question')
				FROM jsonb_array_elements(m.content->'value') elem WHERE elem->>'type'='quiz' LIMIT 1) END,
			CASE WHEN m.kind='flashcards' THEN (SELECT count(*) FROM flashcard_cards fc WHERE fc.material_id=m.id) END,
			m.preview, `+lostAccessSQL("m.workspace_id", "$1")+`
		FROM materials m
		LEFT JOIN workspaces w ON w.id=m.workspace_id
		LEFT JOIN users owner ON owner.id=w.user_id
		LEFT JOIN chapters c ON c.id=m.chapter_id`+where+
		orderClause(sort, "m.id", f.Ascending)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return MaterialPage{}, err
	}
	defer rows.Close()
	page := MaterialPage{Items: []MaterialListItem{}}
	for rows.Next() {
		var item MaterialListItem
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.WorkspaceID, &item.WorkspaceName,
			&item.ChapterID, &item.ChapterName,
			&item.Privacy, &item.CreatedAt, &item.UpdatedAt, &item.SizeBytes,
			&item.QuestionCount, &item.CardCount, &item.Preview, &item.LostAccess); err != nil {
			return MaterialPage{}, err
		}
		if item.LostAccess {
			item.Preview = nil
		}
		item.SharePath = materialSharePath(s.shareLinkSecret, string(item.Kind), item.ID, item.WorkspaceID, "")
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return MaterialPage{}, err
	}
	if len(page.Items) > f.Limit {
		last := page.Items[f.Limit-1]
		page.Items = page.Items[:f.Limit]
		at := last.UpdatedAt
		if f.Sort == "created" {
			at = last.CreatedAt
		}
		text := strings.ToLower(last.Title)
		switch f.Sort {
		case "kind":
			text = string(last.Kind)
		case "workspace":
			text = strings.ToLower(last.WorkspaceName)
		}
		page.NextCursor = encodeListCursor(cursorPrimary(sort, at, text, 0), last.ID)
	}
	return page, nil
}

/* -------------------------------------------------------------------- files */

var fileListSorts = map[string]listSort{
	"added":     {column: "f.added_at", kind: "time"},
	"name":      {column: "lower(f.name)", kind: "text"},
	"size":      {column: "f.size_bytes", kind: "int"},
	"kind":      {column: "f.kind", kind: "text"},
	"workspace": {column: "lower(w.name)", kind: "text"},
}

type FileListFilter struct {
	Kinds        []string
	WorkspaceIDs []string
	Member       bool
	Sort         string
	Ascending    bool
	Limit        int
	Cursor       string
}

type FilePage struct {
	Items      []File `json:"items" nullable:"false"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ListOwnedFiles pages through the files of every workspace the caller owns
// and every file they pay for, or with Member also every workspace they
// belong to.
func (s *Store) ListOwnedFiles(ctx context.Context, ownerID string, f FileListFilter) (FilePage, error) {
	sort, ok := fileListSorts[f.Sort]
	if !ok {
		sort = fileListSorts["added"]
	}
	if f.Limit <= 0 || f.Limit > listPageMax {
		f.Limit = listPageMax
	}
	args := []any{ownerID}
	where := ` WHERE (w.user_id=$1 OR f.user_id=$1) AND f.trashed_at IS NULL`
	if f.Member {
		where = ` WHERE (w.user_id=$1 OR f.user_id=$1 OR (` + memberWorkspace("w.id") + `)) AND f.trashed_at IS NULL`
	}
	if len(f.Kinds) > 0 {
		args = append(args, f.Kinds)
		where += fmt.Sprintf(` AND f.kind = ANY($%d)`, len(args))
	}
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND f.workspace_id = ANY($%d)`, len(args))
	}
	clause, cursorArgs, err := cursorClause(sort, "f.id", f.Ascending, f.Cursor, len(args)+1)
	if err != nil {
		return FilePage{}, err
	}
	where += clause
	args = append(args, cursorArgs...)
	args = append(args, f.Limit+1)
	rows, err := s.pool.Query(ctx, `SELECT `+fileListCols+`, `+workspaceNameSQL("w.id", "w.name")+`, `+lostAccessSQL("f.workspace_id", "$1")+
		` FROM files f JOIN workspaces w ON w.id=f.workspace_id JOIN users owner ON owner.id=w.user_id`+
		where+orderClause(sort, "f.id", f.Ascending)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return FilePage{}, err
	}
	defer rows.Close()
	page := FilePage{Items: []File{}}
	for rows.Next() {
		var workspaceName string
		var lost bool
		file, err := scanFile(withExtra{rows, []any{&workspaceName, &lost}})
		if err != nil {
			return FilePage{}, err
		}
		file.WorkspaceName = workspaceName
		if lost {
			file.LostAccess, file.ThumbnailKey, file.Preview = true, "", nil
		}
		page.Items = append(page.Items, file)
	}
	if err := rows.Err(); err != nil {
		return FilePage{}, err
	}
	if len(page.Items) > f.Limit {
		last := page.Items[f.Limit-1]
		page.Items = page.Items[:f.Limit]
		text := strings.ToLower(last.Name)
		switch f.Sort {
		case "kind":
			text = string(last.Kind)
		case "workspace":
			// A file row carries no workspace name; read it as the sort does.
			if err := s.pool.QueryRow(ctx, `SELECT lower(name) FROM workspaces WHERE id=$1`, last.WorkspaceID).Scan(&text); err != nil {
				return FilePage{}, err
			}
		}
		page.NextCursor = encodeListCursor(cursorPrimary(sort, last.AddedAt, text, last.SizeBytes), last.ID)
	}
	return page, nil
}

// WorkspaceRecent is a workspace's newest files and materials with their
// thumbnails and previews: the empty viewer's quick-open grid. Each list holds
// at most the requested count; the client merges and cuts the pair.
type WorkspaceRecent struct {
	Files     []File             `json:"files" nullable:"false"`
	Materials []MaterialListItem `json:"materials" nullable:"false"`
}

// ListWorkspaceRecent returns the newest live files (by added time) and
// top-level materials (by created time) of one workspace. Callers check read
// access first; the rows carry no share links.
func (s *Store) ListWorkspaceRecent(ctx context.Context, wsID string, limit int) (WorkspaceRecent, error) {
	out := WorkspaceRecent{Files: []File{}, Materials: []MaterialListItem{}}
	rows, err := s.pool.Query(ctx, `SELECT `+fileListCols+` FROM files f
		WHERE f.workspace_id=$1 AND f.trashed_at IS NULL
		ORDER BY f.added_at DESC, f.id LIMIT $2`, wsID, limit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			rows.Close()
			return out, err
		}
		out.Files = append(out.Files, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `SELECT m.id, m.kind, m.title, m.workspace_id, m.workspace_name,
			m.chapter_id, m.privacy, m.created_at, m.updated_at, m.size_bytes, m.preview
		FROM materials m
		WHERE m.workspace_id=$1 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
		ORDER BY m.created_at DESC, m.id LIMIT $2`, wsID, limit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item MaterialListItem
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.WorkspaceID, &item.WorkspaceName,
			&item.ChapterID, &item.Privacy, &item.CreatedAt, &item.UpdatedAt, &item.SizeBytes, &item.Preview); err != nil {
			return out, err
		}
		out.Materials = append(out.Materials, item)
	}
	return out, rows.Err()
}
