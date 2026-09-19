package store

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// Owner-scoped, filtered, sorted, keyset-paginated listings behind the Create
// and Files pages. Both list only what the caller owns: materials and files in
// their own workspaces plus their standalone materials.

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
		return "", "", false, fmt.Errorf("%w: invalid cursor", ErrNotFound)
	}
	primary, id, found := strings.Cut(string(raw), "|")
	if !found {
		return "", "", false, fmt.Errorf("%w: invalid cursor", ErrNotFound)
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
			return "", nil, fmt.Errorf("%w: invalid cursor", ErrNotFound)
		}
		value = at
	case "int":
		var n int64
		if _, err := fmt.Sscanf(primary, "%d", &n); err != nil {
			return "", nil, fmt.Errorf("%w: invalid cursor", ErrNotFound)
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
}

// MaterialListFilter narrows the owner's materials. Empty slices mean no
// filter; Location is "", "workspace", "embedded" or "standalone".
type MaterialListFilter struct {
	Kinds        []string
	WorkspaceIDs []string
	Location     string
	Sort         string
	Ascending    bool
	Limit        int
	Cursor       string
}

// MaterialListItem is one Create page row: enough to render the card without
// loading the document, plus the per-kind counts the card shows.
type MaterialListItem struct {
	ID               string       `json:"id"`
	Kind             MaterialKind `json:"kind"`
	Title            string       `json:"title"`
	WorkspaceID      string       `json:"workspaceId"`
	WorkspaceName    string       `json:"workspaceName"`
	ChapterID        *string      `json:"chapterId"`
	ChapterName      string       `json:"chapterName"`
	ParentMaterialID string       `json:"parentMaterialId"`
	ParentTitle      string       `json:"parentTitle"`
	Privacy          Privacy      `json:"privacy"`
	CreatedAt        time.Time    `json:"createdAt"`
	UpdatedAt        time.Time    `json:"updatedAt"`
	SizeBytes        int64        `json:"sizeBytes"`
	QuestionCount    *int         `json:"questionCount,omitempty"`
	TimeLimitMin     *int         `json:"timeLimitMin,omitempty"`
	CardCount        *int         `json:"cardCount,omitempty"`
	KnownPct         *int         `json:"knownPct,omitempty"`
	DueCount         *int         `json:"dueCount,omitempty"`
}

type MaterialPage struct {
	Items      []MaterialListItem `json:"items" nullable:"false"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

// ListOwnedMaterials pages through the caller's notes, quizzes and flashcard
// sets: rows they own in their own workspaces plus their standalone rows.
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
	where := ` WHERE m.owner_user_id=$1 AND m.trashed_at IS NULL AND m.kind = ANY($2)`
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND m.workspace_id = ANY($%d)`, len(args))
	}
	switch f.Location {
	case "workspace":
		where += ` AND m.workspace_id IS NOT NULL AND m.parent_material_id IS NULL`
	case "embedded":
		where += ` AND m.parent_material_id IS NOT NULL`
	case "standalone":
		where += ` AND m.workspace_id IS NULL AND m.parent_material_id IS NULL`
	}
	clause, cursorArgs, err := cursorClause(sort, "m.id", f.Ascending, f.Cursor, len(args)+1)
	if err != nil {
		return MaterialPage{}, err
	}
	where += clause
	args = append(args, cursorArgs...)
	args = append(args, f.Limit+1)
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.kind, m.title, COALESCE(m.workspace_id,''), m.workspace_name,
			m.chapter_id, COALESCE(c.name,''), COALESCE(m.parent_material_id,''), COALESCE(p.title,''),
			m.privacy, m.created_at, m.updated_at, m.size_bytes,
			CASE WHEN m.kind='quiz' THEN (SELECT jsonb_array_length(elem->'children')
				FROM jsonb_array_elements(m.content->'value') elem WHERE elem->>'type'='quiz' LIMIT 1) END,
			CASE WHEN m.kind='quiz' THEN (SELECT (elem->>'timeLimitMin')::int
				FROM jsonb_array_elements(m.content->'value') elem WHERE elem->>'type'='quiz' LIMIT 1) END,
			CASE WHEN m.kind='flashcards' THEN (SELECT count(*) FROM card_stats cs WHERE cs.material_id=m.id) END,
			CASE WHEN m.kind='flashcards' THEN COALESCE((SELECT round(100.0*count(*) FILTER (WHERE cs.known)/NULLIF(count(*),0))::int
				FROM card_stats cs WHERE cs.material_id=m.id), 0) END,
			CASE WHEN m.kind='flashcards' THEN (SELECT count(*) FROM card_stats cs
				WHERE cs.material_id=m.id AND (cs.srs->>'due')::timestamptz <= now()) END
		FROM materials m
		LEFT JOIN chapters c ON c.id=m.chapter_id
		LEFT JOIN materials p ON p.id=m.parent_material_id`+where+
		orderClause(sort, "m.id", f.Ascending)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return MaterialPage{}, err
	}
	defer rows.Close()
	page := MaterialPage{Items: []MaterialListItem{}}
	for rows.Next() {
		var item MaterialListItem
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.WorkspaceID, &item.WorkspaceName,
			&item.ChapterID, &item.ChapterName, &item.ParentMaterialID, &item.ParentTitle,
			&item.Privacy, &item.CreatedAt, &item.UpdatedAt, &item.SizeBytes,
			&item.QuestionCount, &item.TimeLimitMin, &item.CardCount, &item.KnownPct, &item.DueCount); err != nil {
			return MaterialPage{}, err
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
		if f.Sort == "kind" {
			text = string(last.Kind)
		}
		page.NextCursor = encodeListCursor(cursorPrimary(sort, at, text, 0), last.ID)
	}
	return page, nil
}

/* -------------------------------------------------------------------- files */

var fileListSorts = map[string]listSort{
	"added": {column: "f.added_at", kind: "time"},
	"name":  {column: "lower(f.name)", kind: "text"},
	"size":  {column: "f.size_bytes", kind: "int"},
	"kind":  {column: "f.kind", kind: "text"},
}

type FileListFilter struct {
	Kinds        []string
	WorkspaceIDs []string
	Sort         string
	Ascending    bool
	Limit        int
	Cursor       string
}

type FilePage struct {
	Items      []File `json:"items" nullable:"false"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ListOwnedFiles pages through the files of every workspace the caller owns.
func (s *Store) ListOwnedFiles(ctx context.Context, ownerID string, f FileListFilter) (FilePage, error) {
	sort, ok := fileListSorts[f.Sort]
	if !ok {
		sort = fileListSorts["added"]
	}
	if f.Limit <= 0 || f.Limit > listPageMax {
		f.Limit = listPageMax
	}
	args := []any{ownerID}
	where := ` WHERE w.user_id=$1 AND f.trashed_at IS NULL`
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
	rows, err := s.pool.Query(ctx, `SELECT `+fileListCols+` FROM files f JOIN workspaces w ON w.id=f.workspace_id`+
		where+orderClause(sort, "f.id", f.Ascending)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return FilePage{}, err
	}
	defer rows.Close()
	page := FilePage{Items: []File{}}
	for rows.Next() {
		file, err := scanFile(rows)
		if err != nil {
			return FilePage{}, err
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
		if f.Sort == "kind" {
			text = string(last.Kind)
		}
		page.NextCursor = encodeListCursor(cursorPrimary(sort, last.AddedAt, text, last.SizeBytes), last.ID)
	}
	return page, nil
}
