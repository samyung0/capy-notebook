package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// The Files page's one list (Epo 2026-11-09): to the user a file is any of
// them, so uploaded files, handed-in submissions, blocks (notes, quizzes,
// flashcard sets) and embedded images and audio page, sort and filter
// together. A narrow UNION ALL picks the page by a shared sort key; each row
// is then read whole by its own listing (by IDs), as Recent reads its opens.
// Drawn answers keep their own list.

type ItemType string

const (
	ItemFile       ItemType = "file"
	ItemSubmission ItemType = "submission"
	ItemMaterial   ItemType = "material"
	ItemEmbed      ItemType = "embed"
)

// Item is one row of the list: exactly the field its Type names is set.
type Item struct {
	Type       ItemType          `json:"type" enum:"file,submission,material,embed"`
	File       *File             `json:"file,omitempty"`
	Submission *SubmittedPaper   `json:"submission,omitempty"`
	Material   *MaterialListItem `json:"material,omitempty"`
	Embed      *EditorAssetItem  `json:"embed,omitempty"`
}

type ItemPage struct {
	Items      []Item `json:"items" nullable:"false"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ItemListFilter narrows the list; empty slices mean no filter.
type ItemListFilter struct {
	// Kinds are file kinds, material kinds (note, quiz, flashcards, canvas) and an
	// embed's image or audio, which match image and audio files too.
	Kinds        []string
	WorkspaceIDs []string
	// Locations holds "workspace" and "standalone"; a submission sits in its
	// assignment's workspace.
	Locations []string
	// Query keeps rows whose shown name holds it, any case.
	Query string
	// All adds the files and blocks of the caller's own and member workspaces
	// it does not pay for, and a hidden quiz assigned to it while that
	// assignment is open, as Recent lists it; submissions and embeds are
	// always its own.
	All       bool
	Sort      string
	Ascending bool
	Limit     int
	Cursor    string
}

// itemMaterialKinds are the blocks the list holds. A canvas is its owner's
// alone: it has no workspace_id, so only the owner's own branch finds it.
var itemMaterialKinds = []string{"note", "quiz", "flashcards", "canvas"}

// Every branch yields the same columns: the row's type and id, a key unique
// across tables for the cursor, then the sort and filter values as shown.
var itemListSorts = map[string]listSort{
	"added":     {column: "u.at", kind: "time"},
	"name":      {column: "u.name", kind: "text"},
	"size":      {column: "u.size", kind: "int"},
	"kind":      {column: "u.kind", kind: "text"},
	"workspace": {column: "u.ws_name", kind: "text"},
}

var itemLocations = map[string]string{
	"workspace":  `u.workspace_id IS NOT NULL`,
	"standalone": `u.workspace_id IS NULL`,
}

// itemUnionSQL is the four tables as one, for the caller $1. All files reads
// the caller's own rows and its workspaces' others' rows as separate branches,
// each on its own index (TestItemsCost, 2026-11-09).
func itemUnionSQL(all bool) string {
	fileBranch := func(scope string) string {
		return `SELECT 'file' AS type, f.id, 'file:' || f.id AS key, f.added_at AS at, lower(f.name) AS name,
			f.size_bytes AS size, f.kind::text AS kind, lower(` + fileWorkspaceNameSQL + `) AS ws_name,
			NULLIF(f.workspace_id, '') AS workspace_id
		FROM files f LEFT JOIN workspaces w ON w.id=f.workspace_id
		WHERE ` + scope + ` AND f.trashed_at IS NULL AND f.submission_position IS NULL`
	}
	materialBranch := func(scope string) string {
		return `SELECT 'material', m.id, 'material:' || m.id, m.created_at, lower(m.title),
			` + materialListSizeSQL + `, m.kind::text, lower(` + materialListWorkspaceNameSQL + `), ` + materialListWorkspaceIDSQL + `
		FROM materials m
		WHERE ` + scope + ` AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
			AND m.kind IN ('note','quiz','flashcards','canvas')`
	}
	files := fileBranch(`f.user_id=$1`)
	materials := materialBranch(`m.owner_user_id=$1`)
	if all {
		files = fileBranch(`f.user_id=$1 AND workspace_item_visible(f.hidden, f.workspace_id, $1)`) + `
	UNION ALL
	` + fileBranch(`f.workspace_id IN (`+memberWorkspacesSQL("$1")+`) AND f.user_id<>$1
			AND workspace_item_visible(f.hidden, f.workspace_id, $1)`)
		materials = materialBranch(`m.owner_user_id=$1 AND workspace_item_visible(m.hidden, m.workspace_id, $1)`) + `
	UNION ALL
	` + materialBranch(`m.workspace_id IN (`+memberWorkspacesSQL("$1")+`) AND m.owner_user_id<>$1
			AND (workspace_item_visible(m.hidden, m.workspace_id, $1) OR `+quizAssignedToSQL("m.id", "$1")+` IS NOT NULL)`)
	}
	return files + `
	UNION ALL
	SELECT 'submission', f.id, 'submission:' || f.id, f.added_at, lower(f.name),
			f.size_bytes, f.kind::text, lower(COALESCE(t.workspace_name, w.name, '')),
			NULLIF(COALESCE(t.workspace_id, h.workspace_id, ''), '')
		FROM files f LEFT JOIN attempts t ON t.id = f.attempt_id
			LEFT JOIN assignments h ON h.id = f.hand_in_assignment_id LEFT JOIN workspaces w ON w.id = h.workspace_id
		WHERE f.user_id=$1 AND f.submission_position IS NOT NULL AND ` + submittedDeletableSQL + `
	UNION ALL
	` + materials + `
	UNION ALL
	SELECT 'embed', a.id, 'embed:' || a.id, a.created_at, lower(` + workspaceNameSQL("top.workspace_id", "top.title") + `),
			a.size_bytes, a.purpose::text, lower(COALESCE((SELECT cw.name FROM workspaces cw WHERE cw.id=top.canvas_workspace_id),
				` + workspaceNameSQL("top.workspace_id", "COALESCE(top.workspace_name,'')") + `)),
			COALESCE(NULLIF(top.workspace_id, ''), top.canvas_workspace_id)
		FROM editor_assets a
		-- Each asset's note by its key; as plain joins the planner hashes
		-- the whole materials table twice (OFFSET 0 keeps the lookup per row).
		CROSS JOIN LATERAL (SELECT m.trashed_at AS asset_trashed_at, top.title, top.workspace_id,
				top.workspace_name, top.trashed_at, top.canvas_workspace_id
			FROM materials m JOIN materials top ON top.id=COALESCE(m.parent_material_id, m.id)
			WHERE m.id=a.material_id OFFSET 0) top
		WHERE a.user_id=$1 AND a.status='ready' AND a.trashed_at IS NULL AND a.purpose IN ('image','audio')
			AND (` + lostAccessSQL("top.workspace_id", "$1") + ` OR (top.asset_trashed_at IS NULL AND top.trashed_at IS NULL))`
}

// ListItems pages through the Files page's list: what the caller pays for,
// or with All also what its workspaces hold, newest first by default.
func (s *Store) ListItems(ctx context.Context, userID string, f ItemListFilter) (ItemPage, error) {
	sort, ok := itemListSorts[f.Sort]
	if !ok {
		sort = itemListSorts["added"]
	}
	if f.Limit <= 0 || f.Limit > listPageMax {
		f.Limit = listPageMax
	}
	args := []any{userID}
	where := ` WHERE true`
	if len(f.Kinds) > 0 {
		args = append(args, f.Kinds)
		where += fmt.Sprintf(` AND u.kind = ANY($%d)`, len(args))
	}
	if len(f.WorkspaceIDs) > 0 {
		args = append(args, f.WorkspaceIDs)
		where += fmt.Sprintf(` AND u.workspace_id = ANY($%d)`, len(args))
	}
	if f.Query != "" {
		args = append(args, f.Query)
		where += fmt.Sprintf(` AND strpos(u.name, lower($%d)) > 0`, len(args))
	}
	if len(f.Locations) > 0 {
		preds := make([]string, 0, len(f.Locations))
		for _, location := range f.Locations {
			pred, ok := itemLocations[location]
			if !ok {
				return ItemPage{}, fmt.Errorf("unknown item location %q", location)
			}
			preds = append(preds, pred)
		}
		where += ` AND (` + strings.Join(preds, " OR ") + `)`
	}
	clause, cursorArgs, err := cursorClause(sort, "u.key", f.Ascending, f.Cursor, len(args)+1)
	if err != nil {
		return ItemPage{}, err
	}
	where += clause
	args = append(args, cursorArgs...)
	args = append(args, f.Limit+1)
	rows, err := s.pool.Query(ctx, `SELECT u.type, u.id, u.key, u.at, u.name, u.size, u.kind, u.ws_name
		FROM (`+itemUnionSQL(f.All)+`) u`+where+
		orderClause(sort, "u.key", f.Ascending)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return ItemPage{}, err
	}
	type picked struct {
		typ                   ItemType
		id, key               string
		at                    time.Time
		name, kind, workspace string
		size                  int64
	}
	var page []picked
	for rows.Next() {
		var p picked
		if err := rows.Scan(&p.typ, &p.id, &p.key, &p.at, &p.name, &p.size, &p.kind, &p.workspace); err != nil {
			rows.Close()
			return ItemPage{}, err
		}
		page = append(page, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ItemPage{}, err
	}
	out := ItemPage{Items: []Item{}}
	if len(page) > f.Limit {
		page = page[:f.Limit]
		last := page[f.Limit-1]
		text := last.name
		switch f.Sort {
		case "kind":
			text = last.kind
		case "workspace":
			text = last.workspace
		}
		out.NextCursor = encodeListCursor(cursorPrimary(sort, last.at, text, last.size), last.key)
	}

	ids := map[ItemType][]string{}
	for _, p := range page {
		ids[p.typ] = append(ids[p.typ], p.id)
	}
	files := map[string]*File{}
	if len(ids[ItemFile]) > 0 {
		res, err := s.ListOwnedFiles(ctx, userID, FileListFilter{IDs: ids[ItemFile], All: f.All, Limit: len(ids[ItemFile])})
		if err != nil {
			return ItemPage{}, err
		}
		for i := range res.Items {
			files[res.Items[i].ID] = &res.Items[i]
		}
	}
	submissions := map[string]*SubmittedPaper{}
	if len(ids[ItemSubmission]) > 0 {
		res, err := s.SubmittedPapers(ctx, userID, ids[ItemSubmission])
		if err != nil {
			return ItemPage{}, err
		}
		for i := range res {
			submissions[res[i].ID] = &res[i]
		}
	}
	materials := map[string]*MaterialListItem{}
	if len(ids[ItemMaterial]) > 0 {
		res, err := s.ListOwnedMaterials(ctx, userID, MaterialListFilter{
			IDs: ids[ItemMaterial], Kinds: itemMaterialKinds, All: f.All, Limit: len(ids[ItemMaterial]),
		})
		if err != nil {
			return ItemPage{}, err
		}
		for i := range res.Items {
			materials[res.Items[i].ID] = &res.Items[i]
		}
	}
	embeds := map[string]*EditorAssetItem{}
	if len(ids[ItemEmbed]) > 0 {
		res, err := s.ListEditorAssets(ctx, userID, EditorAssetFilter{IDs: ids[ItemEmbed], Limit: len(ids[ItemEmbed])})
		if err != nil {
			return ItemPage{}, err
		}
		for i := range res.Items {
			embeds[res.Items[i].ID] = &res.Items[i]
		}
	}
	// A row gone between the two reads (deleted, trashed) is skipped.
	for _, p := range page {
		item := Item{Type: p.typ}
		switch p.typ {
		case ItemFile:
			item.File = files[p.id]
		case ItemSubmission:
			item.Submission = submissions[p.id]
		case ItemMaterial:
			item.Material = materials[p.id]
		case ItemEmbed:
			item.Embed = embeds[p.id]
		}
		if item.File != nil || item.Submission != nil || item.Material != nil || item.Embed != nil {
			out.Items = append(out.Items, item)
		}
	}
	return out, nil
}
