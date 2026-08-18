package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/models"
)

/* ------------------------------------------------------------------ patches */

type WorkspacePatch struct {
	Name  *string    `json:"name"`
	Color *UserColor `json:"color"`
	Tags  *[]TagRef  `json:"tags"`
}
type ChapterPatch struct {
	Name  *string `json:"name"`
	Order *int    `json:"order"`
}
type QuizPatch struct {
	Name         *string          `json:"name"`
	Chapters     *[]string        `json:"chapters"`
	Questions    *json.RawMessage `json:"questions"`
	Privacy      *Privacy         `json:"privacy"`
	TimeLimitMin *int             `json:"timeLimitMin"`
}
type CardPatch struct {
	Front *string          `json:"front"`
	Back  *string          `json:"back"`
	Known *bool            `json:"known"`
	Srs   *json.RawMessage `json:"srs"`
}
type TaskPatch struct {
	Title *string `json:"title"`
	Meta  *string `json:"meta"`
	Done  *bool   `json:"done"`
}
type EventPatch struct {
	Title    *string    `json:"title"`
	Start    *time.Time `json:"start"`
	End      *time.Time `json:"end"`
	LabelIDs *[]string  `json:"labelIds"`
	Location *string    `json:"location"`
	Note     *string    `json:"note"`
}
type LabelPatch struct {
	Name  *string    `json:"name"`
	Color *UserColor `json:"color"`
}

/* --------------------------------------------------------------- me / shell */

func (s *Store) Search(ctx context.Context, userID, q string) ([]SearchResult, error) {
	out := []SearchResult{}
	like := "%" + strings.ToLower(q) + "%"

	rows, err := s.pool.Query(ctx, `SELECT w.id, w.name,
			COALESCE((SELECT array_agg(t.name) FROM entity_tags et JOIN tags t ON t.id=et.tag_id
				WHERE et.workspace_id=w.id), '{}')
		FROM workspaces w
		WHERE (w.user_id=$2 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=$2))
			AND (lower(w.name) LIKE $1
			OR EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id=et.tag_id
				WHERE et.workspace_id=w.id AND lower(t.name) LIKE $1))`, like, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name string
		var tags []string
		if err := rows.Scan(&id, &name, &tags); err != nil {
			return nil, err
		}
		out = append(out, SearchResult{ID: id, Kind: "workspace", Title: name, Subtitle: strings.Join(tags, " · "), Href: "/workspaces/" + id})
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT f.id, f.name, f.workspace_id, w.name FROM files f
		JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$2 AND lower(f.name) LIKE $1`, like, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name, wsID, wsName string
		if err := rows.Scan(&id, &name, &wsID, &wsName); err != nil {
			return nil, err
		}
		out = append(out, SearchResult{ID: id, Kind: "file", Title: name, Subtitle: wsName, Href: "/workspaces/" + wsID + "?file=" + id})
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT id, title, COALESCE(location,'') FROM events WHERE user_id=$2 AND lower(title) LIKE $1`, like, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, title, loc string
		if err := rows.Scan(&id, &title, &loc); err != nil {
			return nil, err
		}
		out = append(out, SearchResult{ID: id, Kind: "event", Title: title, Subtitle: loc, Href: "/schedule"})
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT m.id, m.title, m.workspace_name
		FROM materials m
		WHERE (m.owner_user_id=$2 OR EXISTS (
			SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=m.workspace_id AND wm.user_id=$2
		)) AND m.kind='flashcards' AND lower(m.title) LIKE $1`, like, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name, wsName string
		if err := rows.Scan(&id, &name, &wsName); err != nil {
			return nil, err
		}
		out = append(out, SearchResult{ID: id, Kind: "flashcards", Title: name, Subtitle: wsName, Href: "/flashcards/" + id})
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT id, name FROM canvases WHERE user_id=$2 AND lower(name) LIKE $1`, like, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out = append(out, SearchResult{ID: id, Kind: "thinking", Title: name, Href: "/thinking/" + id})
	}
	rows.Close()

	if len(out) > 20 {
		out = out[:20]
	}
	return out, nil
}

/* --------------------------------------------------------------- workspaces */

// The owner name is a subselect rather than a join so every caller of wsCols
// keeps its existing FROM clause.
const wsCols = `w.id, w.name, w.color, w.privacy, w.share_role,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'value', t.name) ORDER BY t.name)
		FROM entity_tags et JOIN tags t ON t.id=et.tag_id
		WHERE et.workspace_id=w.id), '[]'::jsonb),
	w.user_id, COALESCE((SELECT u.name FROM users u WHERE u.id=w.user_id), ''),
	(SELECT count(*) FROM chapters c WHERE c.workspace_id=w.id),
	(SELECT count(*) FROM files f WHERE f.workspace_id=w.id),
	w.created_at, w.last_accessed_at`

func scanWorkspace(row pgx.Row) (Workspace, error) {
	var w Workspace
	err := row.Scan(&w.ID, &w.Name, &w.Color, &w.Privacy, &w.ShareRole, &w.Tags, &w.OwnerUserID, &w.OwnerName, &w.ChapterCount, &w.FileCount, &w.CreatedAt, &w.LastAccessedAt)
	w.FilesLimit = MaxFilesPerWorkspace
	return w, err
}

// splitCSVQuery splits a comma-separated query value into trimmed non-empty parts.
func splitCSVQuery(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (s *Store) ListWorkspaces(ctx context.Context, userID, q, sortKey, color, tag string) ([]Workspace, error) {
	sb := "SELECT " + wsCols + " FROM workspaces w WHERE (w.user_id=$1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=$1))"
	args := []any{userID}
	if q != "" {
		args = append(args, "%"+strings.ToLower(q)+"%")
		n := len(args)
		sb += fmt.Sprintf(" AND (lower(w.name) LIKE $%d OR EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id=et.tag_id WHERE et.workspace_id=w.id AND lower(t.name) LIKE $%d))", n, n)
	}
	colors := splitCSVQuery(color)
	tags := splitCSVQuery(tag)
	if len(colors) > 0 || len(tags) > 0 {
		var parts []string
		if len(colors) > 0 {
			args = append(args, colors)
			parts = append(parts, fmt.Sprintf("w.color = ANY($%d)", len(args)))
		}
		if len(tags) > 0 {
			args = append(args, tags)
			parts = append(parts, fmt.Sprintf("EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id=et.tag_id WHERE et.workspace_id=w.id AND t.name = ANY($%d))", len(args)))
		}
		sb += " AND (" + strings.Join(parts, " OR ") + ")"
	}
	switch sortKey {
	case "created":
		sb += " ORDER BY w.created_at DESC"
	case "chapters":
		sb += " ORDER BY (SELECT count(*) FROM chapters c WHERE c.workspace_id=w.id) DESC"
	case "files":
		sb += " ORDER BY (SELECT count(*) FROM files f WHERE f.workspace_id=w.id) DESC"
	default:
		sb += " ORDER BY w.last_accessed_at DESC"
	}
	rows, err := s.pool.Query(ctx, sb, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Workspace{}
	for rows.Next() {
		w, err := scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) GetWorkspace(ctx context.Context, userID, id string, touch bool) (Workspace, error) {
	if err := s.AssertWorkspaceOwner(ctx, userID, id); err != nil {
		return Workspace{}, err
	}
	if touch {
		_, _ = s.pool.Exec(ctx, `UPDATE workspaces SET last_accessed_at=now() WHERE id=$1`, id)
	}
	w, err := scanWorkspace(s.pool.QueryRow(ctx, "SELECT "+wsCols+" FROM workspaces w WHERE w.id=$1", id))
	if isNoRows(err) {
		return w, ErrNotFound
	}
	return w, err
}

func (s *Store) WorkspaceStats(ctx context.Context, userID, id string) (WorkspaceStats, error) {
	if err := s.AssertWorkspaceOwner(ctx, userID, id); err != nil {
		return WorkspaceStats{}, err
	}
	var st WorkspaceStats
	// Quizzes live in `materials` since 0010 (the legacy quizzes table is gone).
	err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM chapters WHERE workspace_id=$1),
		(SELECT count(*) FROM files WHERE workspace_id=$1),
		(SELECT count(*) FROM materials WHERE workspace_id=$1 AND kind='quiz'),
		(SELECT count(*) FROM attempts a JOIN materials m ON m.id=a.material_id WHERE m.workspace_id=$1),
		COALESCE((SELECT round(avg(a.pct))::int FROM attempts a JOIN materials m ON m.id=a.material_id WHERE m.workspace_id=$1),0)`,
		id).Scan(&st.Chapters, &st.Files, &st.Quizzes, &st.Attempts, &st.AvgScore)
	return st, err
}

// workspaceEmbedding is the vector space a workspace is bound to for its
// lifetime, stored on the row so ingest and query never have to agree by
// coincidence.
type workspaceEmbedding struct {
	Pin models.Pin
	Dim int
}

// vectorTables mirrors _VECTOR_TABLES in pipeline/pipeline/retrieval/store.py.
// Vectors are stored one table per width because the width is part of the
// halfvec column type; a new width means a new table in the migration and a new
// entry in both maps.
var vectorTables = map[int]string{2560: "rag_chunk_vectors_2560"}

// vectorTable is looked up rather than formatted, because the result is
// interpolated into SQL: only widths the schema actually has can reach a query.
func vectorTable(dim int) (string, error) {
	table, ok := vectorTables[dim]
	if !ok {
		return "", fmt.Errorf("no vector table for embedding dimension %d", dim)
	}
	return table, nil
}

// newWorkspaceEmbedding resolves the embedding model a new workspace will keep
// forever. Resolved once, here, rather than per ingest or per search: every
// chunk in the workspace ends up in this model's space and there is no reindex
// job that could move them, so a later disagreement is unrecoverable.
//
// A hard error when the registry cannot answer, because a workspace whose
// embedding model is unknown can be uploaded to but never searched. The
// hardcoded pair mirrors accountModelPrefs: it is the last resort for a process
// with no registry at all (tests that insert rows without wiring one), and it
// matches the seeded row and the column defaults in the migration.
func (s *Store) newWorkspaceEmbedding(ctx context.Context) (workspaceEmbedding, error) {
	if s.registry == nil {
		return workspaceEmbedding{Pin: models.Pin{Key: "qwen-embed", Version: 1}, Dim: 2560}, nil
	}
	cfg, err := s.registry.Default(ctx, models.SurfaceEmbedding)
	if err != nil {
		return workspaceEmbedding{}, err
	}
	dim, err := cfg.EmbeddingDim()
	if err != nil {
		return workspaceEmbedding{}, err
	}
	return workspaceEmbedding{Pin: cfg.Pin(), Dim: dim}, nil
}

func (s *Store) CreateWorkspace(ctx context.Context, userID, name string, color UserColor, tags []TagRef) (Workspace, error) {
	id := uid("ws")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback(ctx)

	// Workspaces themselves do not consume storage bytes, so they miss the
	// gateStorageTx path used by files and materials. Still enforce lifecycle.
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return Workspace{}, err
	}
	if err := status.CreateErr(); err != nil {
		return Workspace{}, err
	}

	embed, err := s.newWorkspaceEmbedding(ctx)
	if err != nil {
		return Workspace{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspaces
			(id, user_id, name, color, privacy, share_role,
			 embedding_model_key, embedding_model_version, embedding_dim)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		id, userID, name, color, PrivacyPrivate, ShareViewer,
		embed.Pin.Key, embed.Pin.Version, embed.Dim); err != nil {
		return Workspace{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`,
		id, userID); err != nil {
		return Workspace{}, err
	}
	if err := syncEntityTags(ctx, tx, userID, "workspace", id, tags); err != nil {
		return Workspace{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, userID, id, false)
}

// entityTagColumn maps a catalog tag kind to the entity_tags column holding its
// reference. Adding a taggable type means adding a nullable FK column here and
// in the migration, which is the point: the previous polymorphic (kind,
// entity_id) pair accepted anything and referenced nothing.
func entityTagColumn(kind string) (string, error) {
	switch kind {
	case "workspace":
		return "workspace_id", nil
	case "material":
		return "material_id", nil
	default:
		return "", fmt.Errorf("untaggable entity kind %q", kind)
	}
}

// syncEntityTags reconciles the tag set for one entity to exactly `refs`, inside
// a transaction. It resolves each ref to a catalog tag (reusing the
// referenced/matched row so its metadata survives), then adds the missing links
// and drops links no longer present. Catalog rows are never deleted here — they
// outlive the entities that reference them.
func syncEntityTags(ctx context.Context, tx pgx.Tx, userID, kind, entityID string, refs []TagRef) error {
	column, err := entityTagColumn(kind)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(refs))
	seen := map[string]bool{}
	for _, r := range refs {
		value := strings.TrimSpace(r.Value)
		if value == "" {
			continue
		}
		tagID, err := resolveTag(ctx, tx, userID, kind, r.ID, value)
		if err != nil {
			return err
		}
		if !seen[tagID] {
			seen[tagID] = true
			ids = append(ids, tagID)
		}
	}
	// Drop links this entity no longer has (empty ids clears them all).
	if _, err := tx.Exec(ctx,
		`DELETE FROM entity_tags WHERE `+column+`=$1 AND NOT (tag_id = ANY($2))`,
		entityID, ids); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx,
			`INSERT INTO entity_tags (`+column+`, tag_id) VALUES ($1,$2)
				ON CONFLICT DO NOTHING`,
			entityID, id); err != nil {
			return err
		}
	}
	return nil
}

// resolveTag maps one incoming tag ref to a catalog tag id. A valid id owned by
// this user+kind is reused as-is (preserving metadata); otherwise the tag is
// found-or-created by (user, kind, lower(name)).
func resolveTag(ctx context.Context, tx pgx.Tx, userID, kind string, id *string, value string) (string, error) {
	if id != nil && *id != "" {
		var existing string
		err := tx.QueryRow(ctx,
			`SELECT id FROM tags WHERE id=$1 AND user_id=$2 AND kind=$3`,
			*id, userID, kind).Scan(&existing)
		if err == nil {
			return existing, nil
		}
		if !isNoRows(err) {
			return "", err
		}
		// Unknown / not-owned id: fall back to resolving by value.
	}
	var tagID string
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO tags (id, user_id, kind, name) VALUES ($1,$2,$3,$4)
			ON CONFLICT (user_id, kind, lower(name)) DO NOTHING
			RETURNING id
		)
		SELECT id FROM ins
		UNION ALL
		SELECT id FROM tags WHERE user_id=$2 AND kind=$3 AND lower(name)=lower($4)
		LIMIT 1`,
		uid("tag"), userID, kind, value).Scan(&tagID)
	return tagID, err
}

// ListTags returns the user's tag catalog for one kind — the source for the
// client-side "reuse existing tag" autocomplete.
func (s *Store) ListTags(ctx context.Context, userID, kind string) ([]Tag, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name FROM tags WHERE user_id=$1 AND kind=$2 ORDER BY name`, userID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tag{}
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Value); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) UpdateWorkspace(ctx context.Context, userID, id string, p WorkspacePatch) (Workspace, error) {
	if err := s.AssertWorkspaceOwner(ctx, userID, id); err != nil {
		return Workspace{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback(ctx)

	ct, err := tx.Exec(ctx, `UPDATE workspaces SET
		name=COALESCE($2,name), color=COALESCE($3,color) WHERE id=$1`,
		id, p.Name, p.Color)
	if err != nil {
		return Workspace{}, err
	}
	if ct.RowsAffected() == 0 {
		return Workspace{}, ErrNotFound
	}
	if p.Tags != nil {
		if err := syncEntityTags(ctx, tx, userID, "workspace", id, *p.Tags); err != nil {
			return Workspace{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, userID, id, false)
}

func (s *Store) UpdateWorkspaceSharing(
	ctx context.Context,
	userID, id string,
	privacy *Privacy,
	shareRole *ShareRole,
) (Workspace, error) {
	if err := s.AssertWorkspaceOwner(ctx, userID, id); err != nil {
		return Workspace{}, err
	}
	ct, err := s.pool.Exec(ctx, `UPDATE workspaces SET
		privacy=COALESCE($2,privacy), share_role=COALESCE($3,share_role) WHERE id=$1`,
		id, privacy, shareRole)
	if err != nil {
		return Workspace{}, err
	}
	if ct.RowsAffected() == 0 {
		return Workspace{}, ErrNotFound
	}
	return s.GetWorkspace(ctx, userID, id, false)
}

func (s *Store) DeleteWorkspace(ctx context.Context, userID, id string) error {
	_, err := s.DeleteWorkspaceWithResult(ctx, userID, id)
	return err
}

func (s *Store) DeleteWorkspaceWithResult(ctx context.Context, userID, id string) ([]NotificationRemoval, error) {
	if err := s.AssertWorkspaceOwner(ctx, userID, id); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM workspaces
		WHERE id=$1`, id).Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT user_id FROM workspaces
		WHERE id=$1 FOR UPDATE`, id).Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if ownerID != userID {
		return nil, ErrForbidden
	}
	rows, err := tx.Query(ctx, `SELECT user_id, id
		FROM notifications WHERE workspace_id=$1`, id)
	if err != nil {
		return nil, err
	}
	removed := []NotificationRemoval{}
	for rows.Next() {
		var item NotificationRemoval
		if err := rows.Scan(&item.UserID, &item.ID); err != nil {
			rows.Close()
			return nil, err
		}
		removed = append(removed, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template='workspace-invite'
			AND status='pending'
			AND payload->>'inviteId' IN (
				SELECT id FROM workspace_invites WHERE workspace_id=$1
			)`, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE template IN ('workspace-role-changed','workspace-member-removed')
			AND status='pending'
			AND payload->>'workspaceId'=$1`, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, id); err != nil {
		return nil, err
	}
	// The workspace's blob objects are queued by the cascade's delete triggers,
	// and its retrieval index cascades away with it now that rag_* lives in this
	// schema — no teardown job to lose.
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return removed, nil
}

/* ----------------------------------------------------------- chapters/files */

const chFiles = `COALESCE((SELECT array_agg(f.id ORDER BY f.position, f.added_at DESC) FROM files f WHERE f.chapter_id=c.id), '{}')`

func (s *Store) ListChapters(ctx context.Context, wsID string) ([]Chapter, error) {
	rows, err := s.pool.Query(ctx, `SELECT c.id, c.workspace_id, c.name, c.position, `+chFiles+`
		FROM chapters c WHERE c.workspace_id=$1 ORDER BY c.position`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Chapter{}
	for rows.Next() {
		var c Chapter
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.Name, &c.Order, &c.FileIDs); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) AddChapter(ctx context.Context, wsID, name string) (Chapter, error) {
	id := uid("ch")
	var pos int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM chapters WHERE workspace_id=$1`, wsID).Scan(&pos); err != nil {
		return Chapter{}, err
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO chapters (id, workspace_id, name, position) VALUES ($1,$2,$3,$4)`, id, wsID, name, pos); err != nil {
		return Chapter{}, err
	}
	return Chapter{ID: id, WorkspaceID: wsID, Name: name, Order: pos, FileIDs: []string{}}, nil
}

func (s *Store) UpdateChapter(ctx context.Context, id string, p ChapterPatch) (Chapter, error) {
	ct, err := s.pool.Exec(ctx, `UPDATE chapters SET name=COALESCE($2,name), position=COALESCE($3,position) WHERE id=$1`, id, p.Name, p.Order)
	if err != nil {
		return Chapter{}, err
	}
	if ct.RowsAffected() == 0 {
		return Chapter{}, ErrNotFound
	}
	var c Chapter
	err = s.pool.QueryRow(ctx, `SELECT c.id, c.workspace_id, c.name, c.position, `+chFiles+` FROM chapters c WHERE c.id=$1`, id).
		Scan(&c.ID, &c.WorkspaceID, &c.Name, &c.Order, &c.FileIDs)
	return c, err
}

func (s *Store) ReorderChapters(ctx context.Context, ids []string) error {
	for i, id := range ids {
		if _, err := s.pool.Exec(ctx, `UPDATE chapters SET position=$2 WHERE id=$1`, id, i); err != nil {
			return err
		}
	}
	return nil
}

// ReorderContent atomically moves content into a chapter (or the unfiled
// bucket) and assigns one shared order across files and materials.
func (s *Store) ReorderContent(ctx context.Context, wsID string, chapterID *string, items []ContentOrderItem) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if chapterID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM chapters WHERE id=$1 AND workspace_id=$2
		)`, *chapterID, wsID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrNotFound
		}
	}

	seen := make(map[string]struct{}, len(items))
	for position, item := range items {
		key := item.Type + ":" + item.ID
		if _, exists := seen[key]; exists {
			return fmt.Errorf("duplicate content item %q", item.ID)
		}
		seen[key] = struct{}{}

		var table string
		switch item.Type {
		case "file":
			table = "files"
		case "material":
			table = "materials"
		default:
			return fmt.Errorf("unsupported content type %q", item.Type)
		}
		ct, err := tx.Exec(ctx, `UPDATE `+table+`
			SET chapter_id=$1, position=$2
			WHERE id=$3 AND workspace_id=$4`, chapterID, position, item.ID, wsID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() != 1 {
			return ErrNotFound
		}
	}
	return tx.Commit(ctx)
}

// DeleteChapter removes the chapter; files keep existing (ON DELETE SET NULL
// unfiles them) per the product rule.
func (s *Store) DeleteChapter(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM chapters WHERE id=$1`, id)
	return err
}

const fileCols = `id, workspace_id, chapter_id, position, name, kind, size_bytes, added_at, status, indexed, url, content`

func scanFile(row pgx.Row) (File, error) {
	var f File
	err := row.Scan(&f.ID, &f.WorkspaceID, &f.ChapterID, &f.Position, &f.Name, &f.Kind, &f.SizeBytes, &f.AddedAt, &f.Status, &f.Indexed, &f.URL, &f.Content)
	return f, err
}

func (s *Store) ListFiles(ctx context.Context, userID, wsID string) ([]File, error) {
	const fCols = `f.id, f.workspace_id, f.chapter_id, f.position, f.name, f.kind, f.size_bytes, f.added_at, f.status, f.indexed, f.url, f.content`
	q := `SELECT ` + fileCols + ` FROM files`
	args := []any{}
	if wsID != "" {
		q += ` WHERE workspace_id=$1`
		args = append(args, wsID)
	} else if userID != "" {
		q = `SELECT ` + fCols + ` FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$1`
		args = append(args, userID)
	}
	q += ` ORDER BY position, added_at DESC`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []File{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) GetFile(ctx context.Context, id string) (File, error) {
	f, err := scanFile(s.pool.QueryRow(ctx, `SELECT `+fileCols+` FROM files WHERE id=$1`, id))
	if isNoRows(err) {
		return f, ErrNotFound
	}
	return f, err
}

func (s *Store) AddSource(ctx context.Context, wsID, name, kind string, chapterID *string, sizeBytes int64) (File, error) {
	id := uid("f")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.storageOwnerTx(ctx, tx, wsID)
	if err != nil {
		return File{}, err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, sizeBytes); err != nil {
		return File{}, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, wsID, 1); err != nil {
		return File{}, err
	}
	// Phase 1: no pipeline yet, so sources land 'ready'. Phase 2 sets
	// 'processing' and enqueues an ingest job in the same transaction.
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, chapter_id, name, kind, size_bytes, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'ready')`,
		id, wsID, ownerID, chapterID, name, kind, sizeBytes); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return s.GetFile(ctx, id)
}

// FilePatch carries the mutable fields for a file rename / re-file.
type FilePatch struct {
	Name      *string
	ChapterID **string // double pointer: nil = leave, &nil = clear, &&v = set
}

func (s *Store) nextContentPosition(ctx context.Context, wsID string, chapterID *string) (int64, error) {
	var position int64
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(MAX(position), -1) + 1 FROM (
		SELECT position FROM files
			WHERE workspace_id=$1 AND chapter_id IS NOT DISTINCT FROM $2
		UNION ALL
		SELECT position FROM materials
			WHERE workspace_id=$1 AND chapter_id IS NOT DISTINCT FROM $2
	) content`, wsID, chapterID).Scan(&position)
	return position, err
}

func (s *Store) UpdateFile(ctx context.Context, id string, p FilePatch) (File, error) {
	if p.Name != nil {
		if _, err := s.pool.Exec(ctx, `UPDATE files SET name=$2 WHERE id=$1`, id, *p.Name); err != nil {
			return File{}, err
		}
	}
	if p.ChapterID != nil {
		var wsID string
		if err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, id).Scan(&wsID); err != nil {
			if isNoRows(err) {
				return File{}, ErrNotFound
			}
			return File{}, err
		}
		if *p.ChapterID != nil {
			var valid bool
			if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM chapters WHERE id=$1 AND workspace_id=$2
			)`, **p.ChapterID, wsID).Scan(&valid); err != nil {
				return File{}, err
			}
			if !valid {
				return File{}, ErrNotFound
			}
		}
		position, err := s.nextContentPosition(ctx, wsID, *p.ChapterID)
		if err != nil {
			return File{}, err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE files SET chapter_id=$2, position=$3 WHERE id=$1`, id, *p.ChapterID, position); err != nil {
			return File{}, err
		}
	}
	return s.GetFile(ctx, id)
}

// DeleteFile removes the file row. Its blob objects are dereferenced by trigger,
// which queues for the reaper whichever ones no other row still points at — a
// workspace clone deliberately shares source blobs, so the refcount decides.
func (s *Store) DeleteFile(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var userID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM files WHERE id=$1`, id).Scan(&userID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	ct, err := tx.Exec(ctx, `DELETE FROM files WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

/* ------------------------------------------------------------- materials */

const materialCols = `id, COALESCE(created_by,''), owner_user_id, COALESCE(workspace_id,''), workspace_name, kind, title, content, chapter_id, position, scope_chapters, scope_file_names, privacy, color, created_at, updated_at, revision, size_bytes, node_count, max_depth`
const materialColsM = `m.id, COALESCE(m.created_by,''), m.owner_user_id, COALESCE(m.workspace_id,''), m.workspace_name, m.kind, m.title, m.content, m.chapter_id, m.position, m.scope_chapters, m.scope_file_names, m.privacy, m.color, m.created_at, m.updated_at, m.revision, m.size_bytes, m.node_count, m.max_depth`

func scanMaterial(row pgx.Row) (Material, error) {
	var mt Material
	err := row.Scan(&mt.ID, &mt.CreatedBy, &mt.OwnerUserID, &mt.WorkspaceID, &mt.WorkspaceName, &mt.Kind, &mt.Title, &mt.Content, &mt.ChapterID, &mt.Position, &mt.ScopeChapters, &mt.ScopeFileNames, &mt.Privacy, &mt.Color, &mt.CreatedAt, &mt.UpdatedAt, &mt.Revision, &mt.SizeBytes, &mt.NodeCount, &mt.MaxDepth)
	if mt.ScopeChapters == nil {
		mt.ScopeChapters = []string{}
	}
	if mt.ScopeFileNames == nil {
		mt.ScopeFileNames = []string{}
	}
	return mt, err
}

func (s *Store) CreateMaterial(ctx context.Context, mt Material) (Material, error) {
	if mt.ID == "" {
		mt.ID = uid("mat")
	}
	if mt.ScopeChapters == nil {
		mt.ScopeChapters = []string{}
	}
	if mt.ScopeFileNames == nil {
		mt.ScopeFileNames = []string{}
	}
	if mt.Privacy == "" {
		mt.Privacy = "private"
	}
	if mt.Color == "" {
		mt.Color = "green"
	}
	content, err := materialdoc.FromLegacyMarkdown(string(mt.Kind), mt.Title, mt.Content)
	if err != nil {
		return Material{}, err
	}
	if err := materialdoc.ValidateKind(content, string(mt.Kind)); err != nil {
		return Material{}, err
	}
	mt.Content = content
	metrics, err := materialdoc.Metrics(content)
	if err != nil {
		return Material{}, err
	}
	if err := metrics.LimitError(); err != nil {
		return Material{}, err
	}
	var cardIDs []string
	if mt.Kind == "flashcards" {
		cards, err := materialdoc.ExtractFlashcards(content)
		if err != nil {
			return Material{}, err
		}
		cardIDs = make([]string, len(cards))
		for i, card := range cards {
			cardIDs[i] = card.ID
		}
	}
	creatorID := mt.CreatedBy
	var ownerID string
	if mt.WorkspaceID != "" {
		if err := s.pool.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1`, mt.WorkspaceID).Scan(&ownerID); err != nil {
			return Material{}, err
		}
		if creatorID == "" {
			creatorID = ownerID
		}
	} else {
		ownerID = creatorID
	}
	if creatorID == "" || ownerID == "" {
		return Material{}, ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	storedSize, err := storageJSONSizeTx(ctx, tx, mt.Content)
	if err != nil {
		return Material{}, err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, storedSize); err != nil {
		return Material{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO materials
		(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
		 chapter_id, scope_chapters, scope_file_names, privacy, color, node_count, max_depth, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		mt.ID, creatorID, ownerID, nullStr(mt.WorkspaceID), mt.WorkspaceName, mt.Kind,
		mt.Title, json.RawMessage(mt.Content), mt.ChapterID, mt.ScopeChapters,
		mt.ScopeFileNames, mt.Privacy, mt.Color, metrics.NodeCount, metrics.MaxDepth, creatorID)
	if err != nil {
		if isUniqueViolation(err) {
			return Material{}, ErrTitleTaken
		}
		return Material{}, err
	}
	if err := upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
		MaterialID:    mt.ID,
		Revision:      1,
		EventType:     RevisionCreate,
		Title:         mt.Title,
		Content:       mt.Content,
		EventMetadata: json.RawMessage(`{}`),
		CreatedBy:     &creatorID,
	}); err != nil {
		return Material{}, err
	}
	if mt.Kind == "flashcards" {
		if err := syncCardStatsTx(ctx, tx, mt.ID, cardIDs); err != nil {
			return Material{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, mt.ID)
}

const materialTitleMaxRunes = 200

// MaterialTitleTaken reports whether another material in the workspace already
// uses this title (trimmed, case-insensitive). Empty workspace id is never taken.
func (s *Store) MaterialTitleTaken(ctx context.Context, workspaceID, title string) (bool, error) {
	if workspaceID == "" {
		return false, nil
	}
	var taken bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM materials
			WHERE workspace_id=$1 AND lower(btrim(title)) = lower(btrim($2::text))
		)`, workspaceID, title).Scan(&taken)
	return taken, err
}

// DisambiguateMaterialTitle returns desired if it is free, otherwise
// "desired 2", "desired 3", … until one is unused in the workspace.
func (s *Store) DisambiguateMaterialTitle(ctx context.Context, workspaceID, desired string) (string, error) {
	desired = strings.TrimSpace(desired)
	if desired == "" {
		desired = "Untitled"
	}
	if utf8.RuneCountInString(desired) > materialTitleMaxRunes {
		desired = string([]rune(desired)[:materialTitleMaxRunes])
		desired = strings.TrimSpace(desired)
	}
	taken, err := s.MaterialTitleTaken(ctx, workspaceID, desired)
	if err != nil {
		return "", err
	}
	if !taken {
		return desired, nil
	}
	for n := 2; n < 10000; n++ {
		candidate := fmt.Sprintf("%s %d", desired, n)
		if utf8.RuneCountInString(candidate) > materialTitleMaxRunes {
			base := []rune(desired)
			suffix := fmt.Sprintf(" %d", n)
			keep := materialTitleMaxRunes - utf8.RuneCountInString(suffix)
			if keep < 1 {
				return "", ErrTitleTaken
			}
			candidate = string(base[:keep]) + suffix
		}
		taken, err = s.MaterialTitleTaken(ctx, workspaceID, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", ErrTitleTaken
}

func (s *Store) GetMaterial(ctx context.Context, id string) (Material, error) {
	mt, err := scanMaterial(s.pool.QueryRow(ctx, `SELECT `+materialCols+` FROM materials WHERE id=$1`, id))
	if isNoRows(err) {
		return mt, ErrNotFound
	}
	return mt, err
}

func (s *Store) DeleteMaterial(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM materials WHERE id=$1`, id).Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return err
	}
	ct, err := tx.Exec(ctx, `DELETE FROM materials WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// MaterialPatch is a partial update for a material. Only non-nil fields are
// written. Used for user-authored notes (title/content/scope edits) and filing
// a material under a chapter.
type MaterialPatch struct {
	Title            *string
	Content          *string
	ChapterID        **string // double pointer: nil = leave, &nil = unfile, &&v = set
	ScopeChapters    *[]string
	ScopeFileNames   *[]string
	Privacy          *Privacy
	ExpectedRevision *int64
	UpdatedBy        string
}

func (s *Store) UpdateMaterial(ctx context.Context, id string, p MaterialPatch) (Material, error) {
	sets := []string{}
	args := []any{}
	var contentKind string
	var contentCardIDs []string
	var contentBaseRevision int64
	var currentContent string
	var contentMetrics materialdoc.DocumentMetrics
	i := 1
	add := func(col string, val any) {
		sets = append(sets, fmt.Sprintf("%s=$%d", col, i))
		args = append(args, val)
		i++
	}
	if p.Title != nil {
		add("title", *p.Title)
	}
	if p.Content != nil {
		if err := s.pool.QueryRow(ctx, `SELECT kind, revision, content
			FROM materials WHERE id=$1`, id).
			Scan(&contentKind, &contentBaseRevision, &currentContent); err != nil {
			if isNoRows(err) {
				return Material{}, ErrNotFound
			}
			return Material{}, err
		}
		if err := materialdoc.ValidateKind(*p.Content, contentKind); err != nil {
			return Material{}, err
		}
		handled, err := s.applyAuthoritativeContentCommand(
			ctx, id, currentContent, *p.Content,
		)
		if err != nil {
			return Material{}, err
		}
		if handled {
			p.Content = nil
		}
	}
	if p.Content != nil {
		if contentKind == "flashcards" {
			cards, err := materialdoc.ExtractFlashcards(*p.Content)
			if err != nil {
				return Material{}, err
			}
			contentCardIDs = make([]string, len(cards))
			for i, card := range cards {
				contentCardIDs[i] = card.ID
			}
		}
		var metricsErr error
		contentMetrics, metricsErr = materialdoc.Metrics(*p.Content)
		if metricsErr != nil {
			return Material{}, metricsErr
		}
		if err := contentMetrics.LimitError(); err != nil {
			return Material{}, err
		}
		add("content", json.RawMessage(*p.Content))
		add("node_count", contentMetrics.NodeCount)
		add("max_depth", contentMetrics.MaxDepth)
	}
	if p.ChapterID != nil {
		add("chapter_id", *p.ChapterID)
		var wsID string
		if err := s.pool.QueryRow(ctx, `SELECT COALESCE(workspace_id, '') FROM materials WHERE id=$1`, id).Scan(&wsID); err != nil {
			if isNoRows(err) {
				return Material{}, ErrNotFound
			}
			return Material{}, err
		}
		if *p.ChapterID != nil {
			var valid bool
			if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM chapters WHERE id=$1 AND workspace_id=$2
			)`, **p.ChapterID, wsID).Scan(&valid); err != nil {
				return Material{}, err
			}
			if !valid {
				return Material{}, ErrNotFound
			}
		}
		position, err := s.nextContentPosition(ctx, wsID, *p.ChapterID)
		if err != nil {
			return Material{}, err
		}
		add("position", position)
	}
	if p.ScopeChapters != nil {
		sc := *p.ScopeChapters
		if sc == nil {
			sc = []string{}
		}
		add("scope_chapters", sc)
	}
	if p.ScopeFileNames != nil {
		sf := *p.ScopeFileNames
		if sf == nil {
			sf = []string{}
		}
		add("scope_file_names", sf)
	}
	if p.Privacy != nil {
		add("privacy", *p.Privacy)
	}
	if len(sets) == 0 {
		return s.GetMaterial(ctx, id)
	}
	documentChanged := p.Content != nil || p.Title != nil
	var eventMetadata json.RawMessage
	if documentChanged {
		changedFields := make([]string, 0, 2)
		if p.Title != nil {
			changedFields = append(changedFields, "title")
		}
		if p.Content != nil {
			changedFields = append(changedFields, "content")
		}
		eventMetadata, _ = json.Marshal(map[string]any{"changedFields": changedFields})
		sets = append(sets, "revision=revision+1")
		add("updated_at", time.Now().UTC())
		if p.UpdatedBy != "" {
			add("updated_by", p.UpdatedBy)
		}
	}
	args = append(args, id)
	where := fmt.Sprintf(" WHERE id=$%d", i)
	effectiveExpectedRevision := p.ExpectedRevision
	if effectiveExpectedRevision == nil && p.Content != nil {
		effectiveExpectedRevision = &contentBaseRevision
	}
	if effectiveExpectedRevision != nil {
		args = append(args, *effectiveExpectedRevision)
		where += fmt.Sprintf(" AND revision=$%d", i+1)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	ct, err := tx.Exec(ctx, `UPDATE materials SET `+strings.Join(sets, ", ")+where, args...)
	if err != nil {
		if isUniqueViolation(err) {
			return Material{}, ErrTitleTaken
		}
		return Material{}, err
	}
	if ct.RowsAffected() == 0 {
		var exists bool
		_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM materials WHERE id=$1)`, id).Scan(&exists)
		if exists && effectiveExpectedRevision != nil {
			return Material{}, ErrConflict
		}
		return Material{}, ErrNotFound
	}
	if documentChanged {
		var snapshot MaterialRevision
		var parentRevision int64
		if err := tx.QueryRow(ctx, `SELECT id, revision, revision-1, title, content,
			updated_at
			FROM materials WHERE id=$1`, id).Scan(
			&snapshot.MaterialID,
			&snapshot.Revision,
			&parentRevision,
			&snapshot.Title,
			&snapshot.Content,
			&snapshot.CreatedAt,
		); err != nil {
			return Material{}, err
		}
		snapshot.ParentRevision = &parentRevision
		snapshot.EventType = RevisionEdit
		snapshot.EventMetadata = eventMetadata
		if p.UpdatedBy != "" {
			snapshot.CreatedBy = &p.UpdatedBy
		}
		if err := upsertMaterialRevisionTx(ctx, tx, snapshot); err != nil {
			return Material{}, err
		}
	}
	if p.Content != nil && contentKind == "flashcards" {
		if err := syncCardStatsTx(ctx, tx, id, contentCardIDs); err != nil {
			return Material{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, id)
}

// MaterialWorkspaceID returns the owning workspace id of a material (for
// ownership checks on get/update/delete).
func (s *Store) MaterialWorkspaceID(ctx context.Context, id string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(workspace_id,'') FROM materials WHERE id=$1`, id).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
}

// ListMaterialRefs returns the unified, workspace-scoped list of versioned
// Plate materials, newest first. The flashcards kind is surfaced to the client
// as the legacy ref type "deck".
func (s *Store) ListMaterialRefs(ctx context.Context, wsID string) ([]MaterialRef, error) {
	out := []MaterialRef{}
	rows, err := s.pool.Query(ctx, `SELECT id, kind, title, chapter_id, position, created_at, revision, size_bytes, node_count, max_depth
		FROM materials WHERE workspace_id=$1 ORDER BY position, created_at DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r MaterialRef
		var kind MaterialKind
		if err := rows.Scan(
			&r.ID,
			&kind,
			&r.Title,
			&r.ChapterID,
			&r.Position,
			&r.CreatedAt,
			&r.Revision,
			&r.SizeBytes,
			&r.NodeCount,
			&r.MaxDepth,
		); err != nil {
			return nil, err
		}
		r.Type = kind.RefType()
		out = append(out, r)
	}
	return out, rows.Err()
}

/* --------------------------------------------------------- quizzes/attempts */

// quizFromMaterial derives the legacy typed Quiz API view from canonical
// quiz_question descendants; everything else maps straight off the material.
func quizFromMaterial(mt Material) (Quiz, error) {
	questions, timeLimit, err := materialdoc.ExtractQuiz(mt.Content)
	if err != nil {
		return Quiz{}, err
	}
	if len(questions) == 0 {
		questions = json.RawMessage("[]")
	}
	chapters := mt.ScopeChapters
	if chapters == nil {
		chapters = []string{}
	}
	return Quiz{
		ID: mt.ID, Name: mt.Title, WorkspaceID: mt.WorkspaceID, WorkspaceName: mt.WorkspaceName,
		Chapters: chapters, Questions: questions, CreatedAt: mt.CreatedAt,
		Privacy: mt.Privacy, TimeLimitMin: timeLimit,
	}, nil
}

func (s *Store) ListQuizzes(ctx context.Context, userID string) ([]Quiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+materialColsM+`
		FROM materials m
		WHERE (m.owner_user_id=$1 OR EXISTS (
			SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=m.workspace_id AND wm.user_id=$1
		)) AND m.kind='quiz' ORDER BY m.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Quiz{}
	for rows.Next() {
		mt, err := scanMaterial(rows)
		if err != nil {
			return nil, err
		}
		q, err := quizFromMaterial(mt)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

func (s *Store) GetQuiz(ctx context.Context, id string) (Quiz, error) {
	mt, err := s.GetMaterial(ctx, id)
	if err != nil {
		return Quiz{}, err
	}
	if mt.Kind != "quiz" {
		return Quiz{}, ErrNotFound
	}
	return quizFromMaterial(mt)
}

func (s *Store) CreateQuiz(ctx context.Context, q Quiz) (Quiz, error) {
	content, err := materialdoc.QuizDocument(q.Name, q.Questions, q.TimeLimitMin)
	if err != nil {
		return Quiz{}, err
	}
	mt, err := s.CreateMaterial(ctx, Material{
		ID: q.ID, CreatedBy: q.UserID, WorkspaceID: q.WorkspaceID, WorkspaceName: q.WorkspaceName, Kind: "quiz",
		Title: q.Name, Content: content, ScopeChapters: q.Chapters, Privacy: q.Privacy,
	})
	if err != nil {
		return Quiz{}, err
	}
	return quizFromMaterial(mt)
}

func (s *Store) UpdateQuiz(ctx context.Context, id string, p QuizPatch) (Quiz, error) {
	mt, err := s.GetMaterial(ctx, id)
	if err != nil {
		return Quiz{}, err
	}
	if mt.Kind != "quiz" {
		return Quiz{}, ErrNotFound
	}
	cur, err := quizFromMaterial(mt)
	if err != nil {
		return Quiz{}, err
	}
	name, chapters, questions, timeLimit, privacy := mt.Title, mt.ScopeChapters, cur.Questions, cur.TimeLimitMin, mt.Privacy
	if p.Name != nil {
		name = *p.Name
	}
	if p.Chapters != nil {
		chapters = *p.Chapters
	}
	if p.Questions != nil {
		questions = *p.Questions
	}
	if p.TimeLimitMin != nil {
		timeLimit = p.TimeLimitMin
	}
	if p.Privacy != nil {
		privacy = *p.Privacy
	}
	content, err := materialdoc.ReplaceQuiz(mt.Content, questions, timeLimit)
	if err != nil {
		return Quiz{}, err
	}
	if chapters == nil {
		chapters = []string{}
	}
	if _, err := s.UpdateMaterial(ctx, id, MaterialPatch{
		Title: &name, Content: &content, ScopeChapters: &chapters, Privacy: &privacy,
	}); err != nil {
		return Quiz{}, err
	}
	return s.GetQuiz(ctx, id)
}

func (s *Store) DeleteQuiz(ctx context.Context, id string) error {
	if err := s.DeleteMaterial(ctx, id); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}

// ReviewMistakesQuizID is the virtual quiz assembled from the user's mistakes
// pool. It is not a material, so attempts against it carry a null material_id.
const ReviewMistakesQuizID = "review_mistakes"

func (s *Store) ListAttempts(ctx context.Context, userID string) ([]Attempt, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, material_id, quiz_name, workspace_name, chapters, correct, total, pct, taken_at
		FROM attempts WHERE user_id=$1 ORDER BY taken_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attempt{}
	for rows.Next() {
		var a Attempt
		if err := rows.Scan(&a.ID, &a.MaterialID, &a.QuizName, &a.WorkspaceName, &a.Chapters, &a.Correct, &a.Total, &a.Pct, &a.TakenAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) CreateAttempt(ctx context.Context, userID, materialID string, correct, total int, answers, questions json.RawMessage) (Attempt, error) {
	quizName, workspaceName := "Review mistakes", ""
	chapters := []string{}
	var linkedMaterial *string
	if materialID != ReviewMistakesQuizID {
		q, err := s.GetQuiz(ctx, materialID)
		if err != nil {
			return Attempt{}, err
		}
		quizName, workspaceName, chapters = q.Name, q.WorkspaceName, q.Chapters
		linkedMaterial = &materialID
	}
	pct := 0
	if total > 0 {
		pct = int(float64(correct) / float64(total) * 100.0)
	}
	a := Attempt{
		ID: uid("at"), MaterialID: linkedMaterial, QuizName: quizName, WorkspaceName: workspaceName,
		Chapters: chapters, Correct: correct, Total: total, Pct: pct, TakenAt: time.Now().UTC(),
	}
	if a.Chapters == nil {
		a.Chapters = []string{}
	}
	if len(answers) == 0 {
		answers = json.RawMessage("{}")
	}
	if len(questions) == 0 {
		questions = json.RawMessage("[]")
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO attempts (id, material_id, user_id, quiz_name, workspace_name, chapters, correct, total, pct, taken_at, answers, questions)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, a.ID, a.MaterialID, userID, a.QuizName, a.WorkspaceName, a.Chapters, a.Correct, a.Total, a.Pct, a.TakenAt, []byte(answers), []byte(questions))
	return a, err
}

// GetAttempt returns a single attempt with its per-question breakdown, scoped to
// the owner via the attempts.user_id column recorded at submit time.
func (s *Store) GetAttempt(ctx context.Context, id, userID string) (AttemptDetail, error) {
	var d AttemptDetail
	err := s.pool.QueryRow(ctx, `SELECT id, material_id, quiz_name, workspace_name, chapters, correct, total, pct, taken_at, answers, questions
		FROM attempts WHERE id=$1 AND user_id=$2`, id, userID).
		Scan(&d.ID, &d.MaterialID, &d.QuizName, &d.WorkspaceName, &d.Chapters, &d.Correct, &d.Total, &d.Pct, &d.TakenAt, &d.Answers, &d.Questions)
	if isNoRows(err) {
		return d, ErrNotFound
	}
	if d.Chapters == nil {
		d.Chapters = []string{}
	}
	return d, err
}

/* -------------------------------------------------------------- flashcards */

// deckStatsExpr derives a deck's card_count / known_pct / due_count from the
// per-card scheduling rows in card_stats (m is the aliased materials row).
const deckStatsExpr = `
	(SELECT count(*) FROM card_stats cs WHERE cs.material_id=m.id),
	COALESCE((SELECT round(100.0*count(*) FILTER (WHERE cs.known)/NULLIF(count(*),0))::int FROM card_stats cs WHERE cs.material_id=m.id), 0),
	(SELECT count(*) FROM card_stats cs WHERE cs.material_id=m.id AND (cs.srs->>'due')::timestamptz <= now())`

func scanDeck(row pgx.Row) (Deck, error) {
	var d Deck
	err := row.Scan(&d.ID, &d.Name, &d.WorkspaceID, &d.WorkspaceName, &d.Color, &d.Privacy, &d.CardCount, &d.KnownPct, &d.DueCount)
	return d, err
}

// ListDecks returns the decks a user owns plus those reachable through
// workspace membership, so IsOwner has to be derived per row rather than
// assumed — a member seeing owner-only affordances would be offered actions the
// API then refuses.
func (s *Store) ListDecks(ctx context.Context, userID string) ([]Deck, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, COALESCE(m.workspace_id,''), m.workspace_name, m.color, m.privacy,`+deckStatsExpr+`,
		(m.owner_user_id=$1)
		FROM materials m
		WHERE (m.owner_user_id=$1 OR EXISTS (
			SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=m.workspace_id AND wm.user_id=$1
		)) AND m.kind='flashcards' ORDER BY m.title`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Deck{}
	for rows.Next() {
		var d Deck
		if err := rows.Scan(&d.ID, &d.Name, &d.WorkspaceID, &d.WorkspaceName, &d.Color,
			&d.Privacy, &d.CardCount, &d.KnownPct, &d.DueCount, &d.IsOwner); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) GetDeck(ctx context.Context, id string) (Deck, error) {
	d, err := scanDeck(s.pool.QueryRow(ctx, `SELECT m.id, m.title, COALESCE(m.workspace_id,''), m.workspace_name, m.color, m.privacy,`+deckStatsExpr+`
		FROM materials m WHERE m.id=$1 AND m.kind='flashcards'`, id))
	if isNoRows(err) {
		return d, ErrNotFound
	}
	return d, err
}

// CreateDeck persists a canonical flashcards document with one blank authored
// card, matching the frontend constructor. An omitted workspace id creates a
// truly standalone deck owned directly by the user.
func (s *Store) CreateDeck(ctx context.Context, userID, name string, color UserColor, wsID string) (Deck, error) {
	return s.CreateDeckWithCards(ctx, userID, name, color, wsID, nil)
}

// CreateDeckWithCards persists the complete authored deck in one material
// creation transaction. This is important for generated decks: card additions
// are normal material edits and intentionally do not pass through the creation
// quota gate.
//
// userID is the author, not necessarily the workspace owner. This lookup must
// not filter on ownership: doing so made decks the only material kind an editor
// could not create in someone else's workspace, and CreateMaterial below
// already resolves the owner and gates their quota. Callers are responsible for
// the workspace role check, as they are for every other material kind.
func (s *Store) CreateDeckWithCards(
	ctx context.Context,
	userID, name string,
	color UserColor,
	wsID string,
	cardValues [][2]string,
) (Deck, error) {
	var wsName string
	if wsID != "" {
		err := s.pool.QueryRow(ctx, `SELECT name FROM workspaces WHERE id=$1`, wsID).Scan(&wsName)
		if isNoRows(err) {
			return Deck{}, ErrNotFound
		}
		if err != nil {
			return Deck{}, err
		}
	}
	if name == "" {
		name = "New deck"
	}
	if color == "" {
		color = "green"
	}
	cards := make([]materialdoc.Card, len(cardValues))
	for i, card := range cardValues {
		cards[i] = materialdoc.Card{
			ID:    uid("c"),
			Front: card[0],
			Back:  card[1],
		}
	}
	content, err := materialdoc.FlashcardsDocument(name, cards)
	if err != nil {
		return Deck{}, err
	}
	mt, err := s.CreateMaterial(ctx, Material{
		CreatedBy: userID, WorkspaceID: wsID, WorkspaceName: wsName, Kind: "flashcards",
		Title: name, Content: content, Color: color,
	})
	if err != nil {
		return Deck{}, err
	}
	return s.GetDeck(ctx, mt.ID)
}

// cardStat is a per-card scheduling row joined onto the authored front/back.
type cardStat struct {
	srs   SrsState
	known bool
}

func (s *Store) cardStats(ctx context.Context, materialID string) (map[string]cardStat, error) {
	rows, err := s.pool.Query(ctx, `SELECT card_id, srs, known FROM card_stats WHERE material_id=$1`, materialID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]cardStat{}
	for rows.Next() {
		var id string
		var st cardStat
		if err := rows.Scan(&id, &st.srs, &st.known); err != nil {
			return nil, err
		}
		m[id] = st
	}
	return m, rows.Err()
}

func (s *Store) ListCards(ctx context.Context, deckID string) ([]Flashcard, error) {
	mt, err := s.GetMaterial(ctx, deckID)
	if err != nil {
		return nil, err
	}
	cards, err := materialdoc.ExtractFlashcards(mt.Content)
	if err != nil {
		return nil, err
	}
	stats, err := s.cardStats(ctx, deckID)
	if err != nil {
		return nil, err
	}
	out := make([]Flashcard, 0, len(cards))
	for _, c := range cards {
		st, ok := stats[c.ID]
		if !ok {
			st = cardStat{srs: newSrsState()}
		}
		out = append(out, Flashcard{ID: c.ID, DeckID: deckID, Front: c.Front, Back: c.Back, Known: st.known, Srs: st.srs})
	}
	return out, nil
}

func (s *Store) GetCard(ctx context.Context, id string) (Flashcard, error) {
	var materialID string
	var st cardStat
	err := s.pool.QueryRow(ctx, `SELECT material_id, srs, known FROM card_stats WHERE card_id=$1`, id).Scan(&materialID, &st.srs, &st.known)
	if isNoRows(err) {
		return Flashcard{}, ErrNotFound
	}
	if err != nil {
		return Flashcard{}, err
	}
	mt, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Flashcard{}, err
	}
	cards, err := materialdoc.ExtractFlashcards(mt.Content)
	if err != nil {
		return Flashcard{}, err
	}
	for _, c := range cards {
		if c.ID == id {
			return Flashcard{ID: c.ID, DeckID: materialID, Front: c.Front, Back: c.Back, Known: st.known, Srs: st.srs}, nil
		}
	}
	return Flashcard{}, ErrNotFound
}

func (s *Store) CreateCard(ctx context.Context, deckID, front, back string) (Flashcard, error) {
	mt, err := s.GetMaterial(ctx, deckID)
	if err != nil {
		return Flashcard{}, err
	}
	cards, err := materialdoc.ExtractFlashcards(mt.Content)
	if err != nil {
		return Flashcard{}, err
	}
	id := uid("c")
	cards = append(cards, materialdoc.Card{ID: id, Front: front, Back: back})
	content, err := materialdoc.ReplaceFlashcards(mt.Content, cards)
	if err != nil {
		return Flashcard{}, err
	}
	if _, err := s.UpdateMaterial(ctx, deckID, MaterialPatch{Content: &content}); err != nil {
		return Flashcard{}, err
	}
	return s.GetCard(ctx, id)
}

func (s *Store) UpdateCard(ctx context.Context, id string, p CardPatch) (Flashcard, error) {
	var materialID string
	if err := s.pool.QueryRow(ctx, `SELECT material_id FROM card_stats WHERE card_id=$1`, id).Scan(&materialID); err != nil {
		if isNoRows(err) {
			return Flashcard{}, ErrNotFound
		}
		return Flashcard{}, err
	}
	if p.Front != nil || p.Back != nil {
		mt, err := s.GetMaterial(ctx, materialID)
		if err != nil {
			return Flashcard{}, err
		}
		cards, err := materialdoc.ExtractFlashcards(mt.Content)
		if err != nil {
			return Flashcard{}, err
		}
		for i := range cards {
			if cards[i].ID != id {
				continue
			}
			if p.Front != nil {
				cards[i].Front = *p.Front
			}
			if p.Back != nil {
				cards[i].Back = *p.Back
			}
		}
		content, err := materialdoc.ReplaceFlashcards(mt.Content, cards)
		if err != nil {
			return Flashcard{}, err
		}
		if _, err := s.UpdateMaterial(ctx, materialID, MaterialPatch{Content: &content}); err != nil {
			return Flashcard{}, err
		}
	}
	if p.Known != nil || p.Srs != nil {
		var srs []byte
		if p.Srs != nil {
			srs = []byte(*p.Srs)
		}
		if _, err := s.pool.Exec(ctx, `UPDATE card_stats SET known=COALESCE($2,known), srs=COALESCE($3,srs) WHERE card_id=$1`,
			id, p.Known, srs); err != nil {
			return Flashcard{}, err
		}
	}
	return s.GetCard(ctx, id)
}

func (s *Store) DeleteCard(ctx context.Context, id string) error {
	var materialID string
	if err := s.pool.QueryRow(ctx, `SELECT material_id FROM card_stats WHERE card_id=$1`, id).Scan(&materialID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	mt, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return err
	}
	cards, err := materialdoc.ExtractFlashcards(mt.Content)
	if err != nil {
		return err
	}
	kept := cards[:0]
	for _, c := range cards {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	content, err := materialdoc.ReplaceFlashcards(mt.Content, kept)
	if err != nil {
		return err
	}
	if _, err := s.UpdateMaterial(ctx, materialID, MaterialPatch{Content: &content}); err != nil {
		return err
	}
	return nil
}

// syncCardStatsTx keeps relational FSRS state aligned with authored card IDs.
// Existing IDs retain their scheduling data; new IDs start fresh; removed IDs
// are deleted by cascade-equivalent reconciliation.
func syncCardStatsTx(ctx context.Context, tx pgx.Tx, materialID string, cardIDs []string) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM card_stats WHERE material_id=$1 AND NOT (card_id = ANY($2))`,
		materialID, cardIDs); err != nil {
		return err
	}
	for _, cardID := range cardIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO card_stats (card_id, material_id, srs, known)
			SELECT $1,$2,$3,false
			WHERE NOT EXISTS (
				SELECT 1 FROM card_stats WHERE card_id=$1 AND material_id=$2
			)`, cardID, materialID, newSrsBytes()); err != nil {
			return err
		}
	}
	return nil
}

// newSrsState returns a fresh FSRS "new" state as a typed struct (due now).
func newSrsState() SrsState {
	var st SrsState
	_ = json.Unmarshal(newSrsBytes(), &st)
	return st
}

// newSrsBytes returns a fresh FSRS "new" state (due now) matching SrsState in
// src/api/types.ts. The frontend recomputes real intervals on each review.
func newSrsBytes() []byte {
	b, _ := json.Marshal(map[string]any{
		"due":            time.Now().UTC().Format(time.RFC3339Nano),
		"stability":      0,
		"difficulty":     0,
		"elapsed_days":   0,
		"scheduled_days": 0,
		"reps":           0,
		"lapses":         0,
		"state":          0,
		"learning_steps": 0,
	})
	return b
}

/* ---------------------------------------------------------------- mistakes */

// AddMistakes upserts each missed question into the user's mistakes pool so it
// can be re-studied via the "Review mistakes" quiz.
func (s *Store) AddMistakes(ctx context.Context, userID string, wrong []json.RawMessage) error {
	for _, raw := range wrong {
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &head) != nil || head.ID == "" {
			continue
		}
		if _, err := s.pool.Exec(ctx, `INSERT INTO mistakes (user_id, question_id, question, updated_at)
			VALUES ($1,$2,$3,now())
			ON CONFLICT (user_id, question_id) DO UPDATE SET question=EXCLUDED.question, updated_at=now()`,
			userID, head.ID, []byte(raw)); err != nil {
			return err
		}
	}
	return nil
}

// ClearMistakesExcept drops every mistake for the user that is NOT still in
// keepIDs — i.e. the ones just answered correctly in a review session.
func (s *Store) ClearMistakesExcept(ctx context.Context, userID string, keepIDs []string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mistakes WHERE user_id=$1 AND NOT (question_id = ANY($2))`, userID, keepIDs)
	return err
}

// MistakesQuiz assembles an ad-hoc quiz from the user's missed questions.
func (s *Store) MistakesQuiz(ctx context.Context, userID string) (Quiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT question FROM mistakes WHERE user_id=$1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return Quiz{}, err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var q json.RawMessage
		if err := rows.Scan(&q); err != nil {
			return Quiz{}, err
		}
		items = append(items, q)
	}
	if err := rows.Err(); err != nil {
		return Quiz{}, err
	}
	questions, _ := json.Marshal(items)
	return Quiz{
		ID: "review_mistakes", Name: "Review mistakes", WorkspaceName: "",
		Chapters: []string{}, Questions: questions, CreatedAt: time.Now().UTC(), Privacy: "private",
	}, nil
}

/* ---------------------------------------------------------------- schedule */

func (s *Store) ListLabels(ctx context.Context, userID string) ([]Label, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, color FROM labels WHERE user_id=$1 ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Label{}
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Schedule rows are owned outright by one user and have no share model, so the
// owner id is part of every mutation's WHERE clause rather than a separate
// access lookup.
func (s *Store) UpdateLabel(ctx context.Context, userID, id string, p LabelPatch) (Label, error) {
	var color *string
	if p.Color != nil {
		c := string(*p.Color)
		color = &c
	}
	var l Label
	err := s.pool.QueryRow(ctx, `UPDATE labels SET name=COALESCE($3,name), color=COALESCE($4,color)
		WHERE id=$1 AND user_id=$2 RETURNING id, name, color`,
		id, userID, p.Name, color).Scan(&l.ID, &l.Name, &l.Color)
	if isNoRows(err) {
		return Label{}, ErrNotFound
	}
	return l, err
}

// Deleting a label cascades its event links away, so events keep only the
// labels they still reference.
func (s *Store) DeleteLabel(ctx context.Context, userID, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM labels WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

// Label membership is a join table, so the API's flat labelIds array is
// aggregated on read. Only labels the row still references survive, because a
// deleted label cascades its links away instead of leaving a dead id behind.
const eventCols = `e.id, e.title, e.start_at, e.end_at,
	COALESCE((SELECT array_agg(el.label_id ORDER BY el.label_id)
		FROM event_labels el WHERE el.event_id=e.id), '{}'),
	e.location, e.note`

func scanEvent(row pgx.Row) (Event, error) {
	var e Event
	err := row.Scan(&e.ID, &e.Title, &e.Start, &e.End, &e.LabelIDs, &e.Location, &e.Note)
	if e.LabelIDs == nil {
		e.LabelIDs = []string{}
	}
	return e, err
}

func (s *Store) ListEvents(ctx context.Context, userID string) ([]Event, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+eventCols+`
		FROM events e WHERE e.user_id=$1 ORDER BY e.start_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// syncEventLabelsTx reconciles an event's label links to exactly labelIDs. Ids
// the user does not own are silently dropped rather than erroring: the join
// insert would otherwise let a caller probe for other users' label ids.
func syncEventLabelsTx(ctx context.Context, tx pgx.Tx, userID, eventID string, labelIDs []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM event_labels
		WHERE event_id=$1 AND NOT (label_id = ANY($2))`, eventID, labelIDs); err != nil {
		return err
	}
	if len(labelIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO event_labels (event_id, label_id)
		SELECT $1, l.id FROM labels l
		WHERE l.id = ANY($2) AND l.user_id=$3
		ON CONFLICT DO NOTHING`, eventID, labelIDs, userID)
	return err
}

func (s *Store) CreateEvent(ctx context.Context, userID string, e Event) (Event, error) {
	e.ID = uid("ev")
	if e.LabelIDs == nil {
		e.LabelIDs = []string{}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at, location, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`, e.ID, userID, e.Title, e.Start, e.End, e.Location, e.Note); err != nil {
		return Event{}, err
	}
	if err := syncEventLabelsTx(ctx, tx, userID, e.ID, e.LabelIDs); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return scanEvent(s.pool.QueryRow(ctx, `SELECT `+eventCols+` FROM events e WHERE e.id=$1`, e.ID))
}

func (s *Store) UpdateEvent(ctx context.Context, userID, id string, p EventPatch) (Event, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer tx.Rollback(ctx)
	var ownerID string
	err = tx.QueryRow(ctx, `UPDATE events SET
		title=COALESCE($3,title), start_at=COALESCE($4,start_at), end_at=COALESCE($5,end_at),
		location=COALESCE($6,location), note=COALESCE($7,note)
		WHERE id=$1 AND user_id=$2 RETURNING user_id`,
		id, userID, p.Title, p.Start, p.End, p.Location, p.Note).Scan(&ownerID)
	if isNoRows(err) {
		return Event{}, ErrNotFound
	}
	if err != nil {
		return Event{}, err
	}
	if p.LabelIDs != nil {
		if err := syncEventLabelsTx(ctx, tx, ownerID, id, *p.LabelIDs); err != nil {
			return Event{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return scanEvent(s.pool.QueryRow(ctx, `SELECT `+eventCols+` FROM events e WHERE e.id=$1`, id))
}

func (s *Store) DeleteEvent(ctx context.Context, userID, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM events WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

/* ------------------------------------------------------------------- tasks */

// ListTasks hides tasks completed before today (day-end cleanup behaviour).
func (s *Store) ListTasks(ctx context.Context, userID string) ([]Task, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, title, meta, done, due_date FROM tasks
		WHERE user_id=$1 AND NOT (done AND due_date < date_trunc('day', now())) ORDER BY due_date`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.Title, &t.Meta, &t.Done, &t.DueDate); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) UpdateTask(ctx context.Context, userID, id string, p TaskPatch) (Task, error) {
	var t Task
	err := s.pool.QueryRow(ctx, `UPDATE tasks SET title=COALESCE($3,title), meta=COALESCE($4,meta), done=COALESCE($5,done)
		WHERE id=$1 AND user_id=$2 RETURNING id, title, meta, done, due_date`,
		id, userID, p.Title, p.Meta, p.Done).Scan(&t.ID, &t.Title, &t.Meta, &t.Done, &t.DueDate)
	if isNoRows(err) {
		return Task{}, ErrNotFound
	}
	return t, err
}

func (s *Store) DeleteTask(ctx context.Context, userID, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tasks WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

/* ------------------------------------------------------------ thinking space */

func (s *Store) ListCanvases(ctx context.Context, userID string) ([]Canvas, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, updated_at, scene FROM canvases WHERE user_id=$1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Canvas{}
	for rows.Next() {
		var c Canvas
		if err := rows.Scan(&c.ID, &c.Name, &c.UpdatedAt, &c.Scene); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetCanvas(ctx context.Context, id string) (Canvas, error) {
	var c Canvas
	err := s.pool.QueryRow(ctx, `SELECT id, name, updated_at, scene FROM canvases WHERE id=$1`, id).
		Scan(&c.ID, &c.Name, &c.UpdatedAt, &c.Scene)
	if isNoRows(err) {
		return c, ErrNotFound
	}
	return c, err
}

func (s *Store) CreateCanvas(ctx context.Context, userID, name string) (Canvas, error) {
	id := uid("cv")
	now := time.Now().UTC()
	if _, err := s.pool.Exec(ctx, `INSERT INTO canvases (id, user_id, name, updated_at) VALUES ($1,$2,$3,$4)`, id, userID, name, now); err != nil {
		return Canvas{}, err
	}
	return Canvas{ID: id, Name: name, UpdatedAt: now}, nil
}

func (s *Store) SaveCanvas(ctx context.Context, id string, name *string, scene json.RawMessage) (Canvas, error) {
	var scenePtr []byte
	if scene != nil {
		scenePtr = []byte(scene)
	}
	ct, err := s.pool.Exec(ctx, `UPDATE canvases SET
		name=COALESCE($2,name), scene=COALESCE($3,scene), updated_at=now() WHERE id=$1`,
		id, name, scenePtr)
	if err != nil {
		return Canvas{}, err
	}
	if ct.RowsAffected() == 0 {
		return Canvas{}, ErrNotFound
	}
	return s.GetCanvas(ctx, id)
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
