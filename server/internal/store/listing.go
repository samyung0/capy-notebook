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

// Filtered, sorted, keyset-paginated listings behind the Files page (files,
// blocks) and the dashboard's Recent. The Files page lists what the caller
// pays for, wherever it sits, and is the storage breakdown; other people's
// uploads in the caller's workspaces show inside the workspace. Member (Recent
// and pickers) lists instead what the caller can open: its own workspaces,
// those it belongs to or opened under a live owner (visibleWorkspacesSQL),
// and its standalone rows (Sam 2026-10-19). A paid-for row the caller can no longer open is marked
// LostAccess and shows only its name and size: they may only delete it.

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

// editableWorkspaceSQL is true when user may edit wsCol's content, the rule
// restore checks (lockTrashOwnerTx: owner, or an effective editor through
// membership or a reached editor share), under a live owner.
func editableWorkspaceSQL(wsCol, user string) string {
	return `EXISTS (SELECT 1 FROM workspaces ew WHERE ew.id=` + wsCol + ` AND ` + liveWorkspaceSQL("ew.id") + `
		AND (ew.user_id=` + user + `
			OR EXISTS (SELECT 1 FROM workspace_members em WHERE em.workspace_id=ew.id AND em.user_id=` + user + ` AND em.role IN ('owner','editor'))
			OR (ew.share_role='editor' AND ew.privacy IN ('link','public') AND ` + linkReachSQL("ew", user) + `)))`
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

// visibleWorkspacesSQL lists the workspaces ListWorkspaces, Search and a
// Member listing show to the caller (the parameter user names): those they
// own, those they are a member of, and a link or public one they opened
// (workspace_visits) while they can still open it as a nonmember (public, or
// link with a redeemed grant), each under a live owner (not deleted, pending
// deletion or suspended) apart from their own.
// Lists filter on it with IN, which Postgres looks up by index; the same
// conditions as an OR across the joined tables read every user's rows on each
// call (bench/gateway, 2026-10-24).
func visibleWorkspacesSQL(user string) string {
	return `SELECT id FROM workspaces WHERE user_id=` + user + `
	UNION ALL
	SELECT vm.workspace_id FROM workspace_members vm
		JOIN workspaces vw ON vw.id=vm.workspace_id JOIN users vo ON vo.id=vw.user_id
	WHERE vm.user_id=` + user + ` AND vo.deleted_at IS NULL AND vo.deletion_requested_at IS NULL AND vo.suspended_at IS NULL
	UNION ALL
	SELECT vv.workspace_id FROM workspace_visits vv
		JOIN workspaces vvw ON vvw.id=vv.workspace_id JOIN users vvo ON vvo.id=vvw.user_id
	WHERE vv.user_id=` + user + ` AND vvo.deleted_at IS NULL AND vvo.deletion_requested_at IS NULL AND vvo.suspended_at IS NULL
		AND (vvw.privacy='public' OR (vvw.privacy='link' AND EXISTS (
			SELECT 1 FROM workspace_link_grants vg WHERE vg.workspace_id=vvw.id AND vg.user_id=` + user + `)))`
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

// The updated and workspace sorts page on what a row shows: a lost row's
// update time is its creation time and a closed owner's workspace name is
// blank, so neither the order nor a cursor carries what the row hides.
var (
	lostMaterialSQL          = lostAccessSQL("m.workspace_id", "$1")
	materialWorkspaceNameSQL = workspaceNameSQL("m.workspace_id", "m.workspace_name")
)

var materialListSorts = map[string]listSort{
	"updated": {column: "(CASE WHEN " + lostMaterialSQL + " THEN m.created_at ELSE m.updated_at END)", kind: "time"},
	"created": {column: "m.created_at", kind: "time"},
	"title":   {column: "lower(m.title)", kind: "text"},
	"kind":    {column: "m.kind", kind: "text"},
	// Standalone rows have no workspace name and sort first ascending.
	"workspace": {column: "lower(" + materialWorkspaceNameSQL + ")", kind: "text"},
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
	// IDs keeps only these rows; the access filter still applies.
	IDs       []string
	Locations []string
	Member    bool
	Sort      string
	Ascending bool
	Limit     int
	Cursor    string
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
	// The Files page lists what the caller pays for; Member (dashboard
	// Recent, pickers) what it can open: its standalone rows, its own
	// workspaces and those it belongs to under a live owner (Sam 2026-10-19).
	where := ` WHERE m.owner_user_id=$1`
	if f.Member {
		where = ` WHERE m.id IN (SELECT id FROM materials WHERE workspace_id IS NULL AND owner_user_id=$1
			UNION ALL SELECT id FROM materials WHERE workspace_id IN (` + visibleWorkspacesSQL("$1") + `))`
	}
	where += ` AND m.trashed_at IS NULL AND m.parent_material_id IS NULL AND m.kind = ANY($2)`
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND m.workspace_id = ANY($%d)`, len(args))
	}
	if len(f.IDs) > 0 {
		args = append(args, f.IDs)
		where += fmt.Sprintf(` AND m.id = ANY($%d)`, len(args))
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
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.kind, m.title, COALESCE(m.workspace_id,''), `+materialWorkspaceNameSQL+`,
			m.chapter_id, COALESCE(c.name,''),
			m.privacy, m.created_at, m.updated_at, m.size_bytes,
			CASE WHEN m.kind='quiz' THEN (SELECT (SELECT count(*) FROM jsonb_array_elements(elem->'children') child WHERE child->>'type'='quiz_question')
				FROM jsonb_array_elements(m.content->'value') elem WHERE elem->>'type'='quiz' LIMIT 1) END,
			CASE WHEN m.kind='flashcards' THEN (SELECT count(*) FROM flashcard_cards fc WHERE fc.material_id=m.id) END,
			m.preview, `+lostMaterialSQL+`
		FROM materials m
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
		item.SharePath = materialSharePath(s.shareLinkSecret, string(item.Kind), item.ID, item.WorkspaceID, "")
		if item.LostAccess {
			item = lostMaterialItem(item)
		}
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
			// The shown (masked) name, as the sort uses.
			text = strings.ToLower(last.WorkspaceName)
		}
		page.NextCursor = encodeListCursor(cursorPrimary(sort, at, text, 0), last.ID)
	}
	return page, nil
}

// lostMaterialItem keeps what a payer needs to recognise and delete a row it
// can no longer open: its name and size, where it sits, and when it was
// created (Sam 2026-10-19). Chapter, counts, preview, share link and later
// activity stay hidden.
func lostMaterialItem(item MaterialListItem) MaterialListItem {
	return MaterialListItem{
		ID: item.ID, Kind: item.Kind, Title: item.Title, WorkspaceID: item.WorkspaceID,
		WorkspaceName: item.WorkspaceName, Privacy: item.Privacy, CreatedAt: item.CreatedAt,
		UpdatedAt: item.CreatedAt, SizeBytes: item.SizeBytes, LostAccess: true,
	}
}

// lostFile is lostMaterialItem for a file.
func lostFile(file File) File {
	return File{
		ID: file.ID, WorkspaceID: file.WorkspaceID, Name: file.Name, Kind: file.Kind, SizeBytes: file.SizeBytes,
		AddedAt: file.AddedAt, WorkspaceName: file.WorkspaceName, LostAccess: true,
	}
}

/* -------------------------------------------------------------------- files */

var fileListSorts = map[string]listSort{
	"added":     {column: "f.added_at", kind: "time"},
	"name":      {column: "lower(f.name)", kind: "text"},
	"size":      {column: "f.size_bytes", kind: "int"},
	"kind":      {column: "f.kind", kind: "text"},
	"workspace": {column: "lower(" + fileWorkspaceNameSQL + ")", kind: "text"},
}

// fileWorkspaceNameSQL is the shown workspace name the workspace sort pages on.
var fileWorkspaceNameSQL = "COALESCE(" + workspaceNameSQL("w.id", "w.name") + ", '')"

// fileLocations are FileListFilter.Locations' values, as materialLocations.
var fileLocations = map[string]string{
	"workspace":  `f.workspace_id IS NOT NULL`,
	"standalone": `f.workspace_id IS NULL`,
}

type FileListFilter struct {
	Kinds        []string
	WorkspaceIDs []string
	// IDs keeps only these rows; the access filter still applies.
	IDs []string
	// Locations holds fileLocations keys.
	Locations []string
	// Query keeps names holding it, any case.
	Query     string
	Member    bool
	Sort      string
	Ascending bool
	Limit     int
	Cursor    string
}

type FilePage struct {
	Items      []File `json:"items" nullable:"false"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ListOwnedFiles pages through the files the caller pays for, wherever they
// sit, or with Member the files it can open: in the workspaces it reaches and
// its own standalone files.
func (s *Store) ListOwnedFiles(ctx context.Context, ownerID string, f FileListFilter) (FilePage, error) {
	sort, ok := fileListSorts[f.Sort]
	if !ok {
		sort = fileListSorts["added"]
	}
	if f.Limit <= 0 || f.Limit > listPageMax {
		f.Limit = listPageMax
	}
	args := []any{ownerID}
	// The Files page lists what the caller pays for; Member (dashboard
	// Recent) what it can open (Sam 2026-10-19).
	where := ` WHERE f.user_id=$1 AND f.trashed_at IS NULL`
	if f.Member {
		where = ` WHERE (f.workspace_id IN (` + visibleWorkspacesSQL("$1") + `)
			OR (f.workspace_id IS NULL AND f.user_id=$1)) AND f.trashed_at IS NULL`
	}
	if len(f.Kinds) > 0 {
		args = append(args, f.Kinds)
		where += fmt.Sprintf(` AND f.kind = ANY($%d)`, len(args))
	}
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND f.workspace_id = ANY($%d)`, len(args))
	}
	if len(f.IDs) > 0 {
		args = append(args, f.IDs)
		where += fmt.Sprintf(` AND f.id = ANY($%d)`, len(args))
	}
	if f.Query != "" {
		args = append(args, f.Query)
		where += fmt.Sprintf(` AND strpos(lower(f.name), lower($%d)) > 0`, len(args))
	}
	if len(f.Locations) > 0 {
		preds := make([]string, 0, len(f.Locations))
		for _, location := range f.Locations {
			pred, ok := fileLocations[location]
			if !ok {
				return FilePage{}, fmt.Errorf("unknown file location %q", location)
			}
			preds = append(preds, pred)
		}
		where += ` AND (` + strings.Join(preds, " OR ") + `)`
	}
	clause, cursorArgs, err := cursorClause(sort, "f.id", f.Ascending, f.Cursor, len(args)+1)
	if err != nil {
		return FilePage{}, err
	}
	where += clause
	args = append(args, cursorArgs...)
	args = append(args, f.Limit+1)
	rows, err := s.pool.Query(ctx, `SELECT `+fileListCols+`, `+fileWorkspaceNameSQL+`, `+lostAccessSQL("f.workspace_id", "$1")+
		` FROM files f LEFT JOIN workspaces w ON w.id=f.workspace_id`+
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
			file = lostFile(file)
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
			// The shown (masked) name, as the sort uses.
			text = strings.ToLower(last.WorkspaceName)
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
