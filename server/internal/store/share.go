package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/jackc/pgx/v5"
)

/* -------------------------------------------------------------- access checks

Sharing model: `privacy` on workspaces and materials is enforced at read time.
  - owner / member → read (and write per role capabilities)
  - link/public    → any caller may read; signed-in workspace nonmembers receive
    share_role for material collaboration, while anonymous callers view only
  - private        → owner/members only (404 for everyone else)
A material is readable when the material itself OR its parent workspace is
link/public — publishing a workspace implicitly publishes everything inside. */

// WorkspaceAccess reports whether userID may read wsID. isOwner is true for
// the owner; (false, nil) means shared read access (privacy link/public).
func (s *Store) WorkspaceAccess(ctx context.Context, userID, wsID string) (isOwner bool, err error) {
	var owner *string
	var privacy Privacy
	e := s.pool.QueryRow(ctx, `SELECT user_id, privacy FROM workspaces WHERE id=$1`, wsID).Scan(&owner, &privacy)
	if isNoRows(e) {
		return false, ErrNotFound
	}
	if e != nil {
		return false, e
	}
	if owner != nil && *owner == userID {
		return true, nil
	}
	if role, roleErr := s.WorkspaceRole(ctx, userID, wsID); roleErr == nil && role != "" {
		return role == RoleOwner, nil
	} else if roleErr != nil {
		return false, roleErr
	}
	if privacy == PrivacyLink || privacy == PrivacyPublic {
		return false, nil
	}
	return false, ErrNotFound
}

// WorkspaceRole returns only a persisted membership role. It intentionally
// does not apply workspaces.share_role: structural workspace authorization is
// always membership-based. The legacy
// workspaces.user_id owner remains authoritative and is returned as owner even
// if a membership row has not yet been backfilled.
func (s *Store) WorkspaceRole(ctx context.Context, userID, wsID string) (WorkspaceRole, error) {
	var role WorkspaceRole
	err := s.pool.QueryRow(ctx, `
		SELECT CASE WHEN w.user_id=$2 THEN 'owner' ELSE COALESCE(wm.role,'') END
		FROM workspaces w
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE w.id=$1`, wsID, userID).Scan(&role)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return role, err
}

func (s *Store) AssertWorkspaceEditor(ctx context.Context, userID, wsID string) error {
	role, err := s.WorkspaceRole(ctx, userID, wsID)
	if err != nil {
		return err
	}
	if !RoleCanEdit(role) {
		return ErrForbidden
	}
	return nil
}

func (s *Store) AssertWorkspaceCommenter(ctx context.Context, userID, wsID string) error {
	role, err := s.WorkspaceRole(ctx, userID, wsID)
	if err != nil {
		return err
	}
	if !RoleCanComment(role) {
		return ErrForbidden
	}
	return nil
}

func RoleCanEdit(role WorkspaceRole) bool {
	return role == RoleOwner || role == RoleEditor
}

func RoleCanComment(role WorkspaceRole) bool {
	return RoleCanEdit(role) || role == RoleCommenter
}

func CapabilitiesForRole(role WorkspaceRole, canView bool) AccessCapabilities {
	return AccessCapabilities{
		CanView:          canView || role != "",
		CanEdit:          RoleCanEdit(role),
		CanComment:       RoleCanComment(role),
		CanManageMembers: role == RoleOwner,
	}
}

// MaterialRole returns only the requester's persisted role inherited from the
// parent workspace. Standalone material owners are represented as owners. Use
// MaterialEffectiveAccess for request-scoped shared material capabilities.
func (s *Store) MaterialRole(ctx context.Context, userID, matID string) (WorkspaceRole, error) {
	var owner, wsID *string
	err := s.pool.QueryRow(ctx, `SELECT owner_user_id, workspace_id FROM materials WHERE id=$1`, matID).
		Scan(&owner, &wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if owner != nil && *owner == userID {
		return RoleOwner, nil
	}
	if wsID != nil {
		return s.WorkspaceRole(ctx, userID, *wsID)
	}
	return "", nil
}

// MaterialAccessInfo distinguishes persisted membership from an effective
// link/public material role. Explicit membership always wins, even when the
// workspace's share role is more permissive.
type MaterialAccessInfo struct {
	Role     WorkspaceRole
	Explicit bool
}

// MaterialEffectiveAccess derives material access for this request:
//   - direct owner / explicit member: persisted role
//   - signed-in nonmember of a link/public workspace: workspace share_role
//   - anonymous shared reader: viewer
//   - material-level sharing without a shared workspace: viewer
func (s *Store) MaterialEffectiveAccess(ctx context.Context, userID, matID string) (MaterialAccessInfo, error) {
	var materialOwner, wsID, workspaceOwner *string
	var materialPrivacy Privacy
	var workspacePrivacy *Privacy
	var shareRole *ShareRole
	var memberRole WorkspaceRole
	err := s.pool.QueryRow(ctx, `
		SELECT m.owner_user_id, m.privacy, m.workspace_id, w.user_id, w.privacy, w.share_role,
			COALESCE(wm.role, '')
		FROM materials m
		LEFT JOIN workspaces w ON w.id=m.workspace_id
		LEFT JOIN workspace_members wm
			ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE m.id=$1`, matID, userID).Scan(
		&materialOwner,
		&materialPrivacy,
		&wsID,
		&workspaceOwner,
		&workspacePrivacy,
		&shareRole,
		&memberRole,
	)
	if isNoRows(err) {
		return MaterialAccessInfo{}, ErrNotFound
	}
	if err != nil {
		return MaterialAccessInfo{}, err
	}
	if userID != "" && materialOwner != nil && *materialOwner == userID {
		return MaterialAccessInfo{Role: RoleOwner, Explicit: true}, nil
	}
	if userID != "" && workspaceOwner != nil && *workspaceOwner == userID {
		return MaterialAccessInfo{Role: RoleOwner, Explicit: true}, nil
	}
	if memberRole != "" {
		return MaterialAccessInfo{Role: memberRole, Explicit: true}, nil
	}

	workspaceShared := wsID != nil && workspacePrivacy != nil &&
		(*workspacePrivacy == PrivacyLink || *workspacePrivacy == PrivacyPublic)
	materialShared := materialPrivacy == PrivacyLink || materialPrivacy == PrivacyPublic
	if workspaceShared {
		if userID != "" && shareRole != nil {
			return MaterialAccessInfo{Role: shareRole.WorkspaceRole()}, nil
		}
		return MaterialAccessInfo{Role: RoleViewer}, nil
	}
	if materialShared {
		// Material-only links are intentionally view-only, including when the
		// material still belongs to a private workspace.
		return MaterialAccessInfo{Role: RoleViewer}, nil
	}
	return MaterialAccessInfo{}, ErrNotFound
}

func (s *Store) MaterialEffectiveRole(ctx context.Context, userID, matID string) (WorkspaceRole, error) {
	access, err := s.MaterialEffectiveAccess(ctx, userID, matID)
	return access.Role, err
}

// MaterialAccess reports whether userID may read the material.
func (s *Store) MaterialAccess(ctx context.Context, userID, matID string) (isOwner bool, err error) {
	access, err := s.MaterialEffectiveAccess(ctx, userID, matID)
	if err != nil {
		return false, err
	}
	return access.Role == RoleOwner, nil
}

func (s *Store) AssertMaterialEditor(ctx context.Context, userID, matID string) error {
	var owner, wsID *string
	err := s.pool.QueryRow(ctx, `SELECT owner_user_id, workspace_id FROM materials WHERE id=$1`, matID).Scan(&owner, &wsID)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner != nil && *owner == userID {
		return nil
	}
	if wsID != nil {
		return s.AssertWorkspaceEditor(ctx, userID, *wsID)
	}
	return ErrForbidden
}

func (s *Store) AssertMaterialCommenter(ctx context.Context, userID, matID string) error {
	access, err := s.MaterialEffectiveAccess(ctx, userID, matID)
	if err != nil {
		return err
	}
	if !RoleCanComment(access.Role) {
		return ErrForbidden
	}
	return nil
}

// AssertMaterialContentEditor permits effective shared editors to patch Plate
// content. Callers must still enforce the shared-editor field allow-list.
func (s *Store) AssertMaterialContentEditor(ctx context.Context, userID, matID string) (MaterialAccessInfo, error) {
	access, err := s.MaterialEffectiveAccess(ctx, userID, matID)
	if err != nil {
		return MaterialAccessInfo{}, err
	}
	if !RoleCanEdit(access.Role) {
		return MaterialAccessInfo{}, ErrForbidden
	}
	return access, nil
}

// FileWorkspaceID resolves the owning workspace of a file (for access checks).
func (s *Store) FileWorkspaceID(ctx context.Context, fileID string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
}

// CardMaterialID resolves the deck (flashcards material) owning a card.
func (s *Store) CardMaterialID(ctx context.Context, cardID string) (string, error) {
	var matID string
	err := s.pool.QueryRow(ctx, `SELECT material_id FROM card_stats WHERE card_id=$1`, cardID).Scan(&matID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return matID, err
}

// ChapterWorkspaceID resolves the owning workspace of a chapter.
func (s *Store) ChapterWorkspaceID(ctx context.Context, chapterID string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM chapters WHERE id=$1`, chapterID).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
}

// GetWorkspaceShared reads a workspace without asserting ownership (the caller
// must have verified access via WorkspaceAccess).
func (s *Store) GetWorkspaceShared(ctx context.Context, id string) (Workspace, error) {
	w, err := scanWorkspace(s.pool.QueryRow(ctx, "SELECT "+wsCols+" FROM workspaces w WHERE w.id=$1", id))
	if isNoRows(err) {
		return w, ErrNotFound
	}
	return w, err
}

/* ------------------------------------------------------------------- explore

Explore reads live rows: everything with privacy='public' plus its author name
and clone counter. The seeded public_* snapshot tables are no longer used. */

func (s *Store) ListPublicWorkspaces(ctx context.Context) ([]PublicWorkspace, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+wsCols+`, COALESCE(u.name,'Unknown'), w.clone_count
		FROM workspaces w LEFT JOIN users u ON u.id=w.user_id
		WHERE w.privacy='public' ORDER BY w.clone_count DESC, w.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicWorkspace{}
	for rows.Next() {
		var w PublicWorkspace
		if err := rows.Scan(&w.ID, &w.Name, &w.Color, &w.Privacy, &w.ShareRole, &w.Tags, &w.ChapterCount, &w.FileCount, &w.CreatedAt, &w.LastAccessedAt, &w.Author, &w.Clones); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) ListPublicQuizzes(ctx context.Context) ([]PublicQuiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, COALESCE(m.workspace_id,''), m.workspace_name, m.kind, m.title, m.content, m.chapter_id, m.scope_chapters, m.scope_file_ids, m.privacy, m.color, m.created_at,
			COALESCE(u.name,'Unknown'), m.clone_count
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=m.owner_user_id
		WHERE m.kind='quiz' AND (m.privacy='public' OR w.privacy='public')
		ORDER BY m.clone_count DESC, m.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicQuiz{}
	for rows.Next() {
		var mt Material
		var author string
		var clones int
		if err := rows.Scan(&mt.ID, &mt.WorkspaceID, &mt.WorkspaceName, &mt.Kind, &mt.Title, &mt.Content, &mt.ChapterID, &mt.ScopeChapters, &mt.ScopeFileIDs, &mt.Privacy, &mt.Color, &mt.CreatedAt, &author, &clones); err != nil {
			return nil, err
		}
		q, err := quizFromMaterial(mt)
		if err != nil {
			continue // skip unparseable content instead of failing the page
		}
		out = append(out, PublicQuiz{Quiz: q, Author: author, Clones: clones})
	}
	return out, rows.Err()
}

func (s *Store) ListPublicDecks(ctx context.Context) ([]PublicDeck, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, COALESCE(m.workspace_id,''), m.workspace_name, m.color, m.privacy,`+deckStatsExpr+`,
			COALESCE(u.name,'Unknown'), m.clone_count
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=m.owner_user_id
		WHERE m.kind='flashcards' AND (m.privacy='public' OR w.privacy='public')
		ORDER BY m.clone_count DESC, m.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicDeck{}
	for rows.Next() {
		var d PublicDeck
		if err := rows.Scan(&d.ID, &d.Name, &d.WorkspaceID, &d.WorkspaceName, &d.Color, &d.Privacy, &d.CardCount, &d.KnownPct, &d.DueCount, &d.Author, &d.Clones); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

/* -------------------------------------------------------------------- cloning */

// rewriteCardIDs re-keys every card in a flashcards document. card_stats.card_id
// is a global primary key, so a cloned deck must mint fresh card ids before
// fresh (reset) SRS rows can be inserted for them.
func rewriteCardIDs(_ string, content string) (newContent string, newIDs []string, err error) {
	return rewriteCardIDsWithMap(content, map[string]string{})
}

func rewriteCardIDsWithMap(content string, idMap map[string]string) (newContent string, newIDs []string, err error) {
	return materialdoc.RewriteFlashcardIDs(content, idMap, func() string { return uid("c") })
}

func cloneMaterialRelations(
	ctx context.Context,
	tx pgx.Tx,
	sourceID, targetID string,
	rewriteContent func(string) (string, error),
) error {
	revisions, err := tx.Query(ctx, `SELECT revision, parent_revision, event_type, title, content,
		event_metadata, created_by, created_at
		FROM material_revisions WHERE material_id=$1 ORDER BY version_date`, sourceID)
	if err != nil {
		return err
	}
	var history []MaterialRevision
	for revisions.Next() {
		var row MaterialRevision
		if err := revisions.Scan(
			&row.Revision,
			&row.ParentRevision,
			&row.EventType,
			&row.Title,
			&row.Content,
			&row.EventMetadata,
			&row.CreatedBy,
			&row.CreatedAt,
		); err != nil {
			revisions.Close()
			return err
		}
		history = append(history, row)
	}
	revisions.Close()
	if err := revisions.Err(); err != nil {
		return err
	}
	for _, row := range history {
		content, err := rewriteContent(row.Content)
		if err != nil {
			return err
		}
		row.MaterialID = targetID
		row.Content = content
		if err := upsertMaterialRevisionTx(ctx, tx, row); err != nil {
			return err
		}
	}
	// Comment threads are intentionally not copied. A clone receives only the
	// retained daily material history.
	return nil
}

type workspaceCloneChapter struct {
	id       string
	name     string
	position int
}

type workspaceCloneFile struct {
	id, name, kind, status              string
	chapterID, parser, engine, blobPath *string
	url, content, docID                 *string
	sizeBytes                           int64
	position                            int64
}

type workspaceCloneAsset struct {
	oldID, newID                           string
	name, purpose, objectPath, contentType string
	status                                 string
	sizeBytes                              int64
	etag                                   string
	createdAt                              time.Time
	completedAt                            *time.Time
}

type workspaceCloneMaterial struct {
	material  Material
	content   string
	metrics   materialdoc.DocumentMetrics
	sizeBytes int64
	cardIDs   []string
	cardIDMap map[string]string
}

type workspaceCloneSnapshot struct {
	chapters  []workspaceCloneChapter
	files     []workspaceCloneFile
	assets    []workspaceCloneAsset
	materials []workspaceCloneMaterial
	bytes     int64
}

func (s *Store) snapshotWorkspaceForClone(
	ctx context.Context,
	workspaceID string,
) (workspaceCloneSnapshot, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	defer tx.Rollback(ctx)

	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)`,
		workspaceID,
	).Scan(&exists); err != nil {
		return workspaceCloneSnapshot{}, err
	}
	if !exists {
		return workspaceCloneSnapshot{}, ErrNotFound
	}

	var snapshot workspaceCloneSnapshot
	rows, err := tx.Query(ctx,
		`SELECT id, name, position FROM chapters
		 WHERE workspace_id=$1 ORDER BY position`,
		workspaceID,
	)
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	for rows.Next() {
		var chapter workspaceCloneChapter
		if err := rows.Scan(&chapter.id, &chapter.name, &chapter.position); err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		snapshot.chapters = append(snapshot.chapters, chapter)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()

	rows, err = tx.Query(ctx,
		`SELECT id, name, purpose, object_path, content_type, size_bytes,
			status, COALESCE(etag,''), created_at, completed_at
		 FROM editor_assets
		 WHERE workspace_id=$1 AND status='ready'
		 ORDER BY created_at`,
		workspaceID,
	)
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	for rows.Next() {
		var asset workspaceCloneAsset
		if err := rows.Scan(
			&asset.oldID,
			&asset.name,
			&asset.purpose,
			&asset.objectPath,
			&asset.contentType,
			&asset.sizeBytes,
			&asset.status,
			&asset.etag,
			&asset.createdAt,
			&asset.completedAt,
		); err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		asset.newID = uid("asset")
		snapshot.bytes += asset.sizeBytes
		snapshot.assets = append(snapshot.assets, asset)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()

	rows, err = tx.Query(ctx,
		`SELECT id, chapter_id, position, name, kind, size_bytes, status,
			parser, engine, blob_path, url, content, doc_id
		 FROM files WHERE workspace_id=$1 ORDER BY added_at`,
		workspaceID,
	)
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	for rows.Next() {
		var file workspaceCloneFile
		if err := rows.Scan(
			&file.id,
			&file.chapterID,
			&file.position,
			&file.name,
			&file.kind,
			&file.sizeBytes,
			&file.status,
			&file.parser,
			&file.engine,
			&file.blobPath,
			&file.url,
			&file.content,
			&file.docID,
		); err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		snapshot.bytes += file.sizeBytes
		snapshot.files = append(snapshot.files, file)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()

	assetIDs := make(map[string]string, len(snapshot.assets))
	for _, asset := range snapshot.assets {
		assetIDs[asset.oldID] = asset.newID
	}
	rows, err = tx.Query(ctx,
		`SELECT `+materialCols+`
		 FROM materials WHERE workspace_id=$1 ORDER BY created_at`,
		workspaceID,
	)
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	for rows.Next() {
		material, err := scanMaterial(rows)
		if err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		content := material.Content
		cardIDMap := map[string]string{}
		var cardIDs []string
		if material.Kind == "flashcards" {
			content, cardIDs, err = rewriteCardIDsWithMap(content, cardIDMap)
			if err != nil {
				rows.Close()
				return workspaceCloneSnapshot{}, err
			}
		}
		if len(assetIDs) > 0 {
			content, err = materialdoc.RewriteEditorAssetIDs(content, assetIDs)
			if err != nil {
				rows.Close()
				return workspaceCloneSnapshot{}, err
			}
		}
		metrics, err := materialdoc.Metrics(content)
		if err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		snapshot.materials = append(snapshot.materials, workspaceCloneMaterial{
			material:  material,
			content:   content,
			metrics:   metrics,
			cardIDs:   cardIDs,
			cardIDMap: cardIDMap,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()

	for i := range snapshot.materials {
		sizeBytes, err := storageJSONSizeTx(
			ctx, tx, snapshot.materials[i].content,
		)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		snapshot.materials[i].sizeBytes = sizeBytes
		snapshot.bytes += sizeBytes
	}

	if err := tx.Commit(ctx); err != nil {
		return workspaceCloneSnapshot{}, err
	}
	return snapshot, nil
}

// CloneWorkspace deep-copies a shared workspace (chapters, files, materials,
// fresh card stats) into a new workspace owned by userID. Blob objects are shared
// rather than duplicated: the clone copies blob_path and editor asset object
// paths, and the refcount triggers make that safe — the object survives until its
// last holder is gone, so deleting either workspace no longer leaks or destroys
// the other's bytes. LightRAG state is copied separately by the pipeline (keyed
// by workspace id). The clone lands private regardless of the source's
// visibility.
func (s *Store) CloneWorkspace(ctx context.Context, userID, srcID string) (Workspace, error) {
	isOwner, err := s.WorkspaceAccess(ctx, userID, srcID)
	if err != nil {
		return Workspace{}, err
	}

	src, err := s.GetWorkspaceShared(ctx, srcID)
	if err != nil {
		return Workspace{}, err
	}
	snapshot, err := s.snapshotWorkspaceForClone(ctx, srcID)
	if err != nil {
		return Workspace{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback(ctx)
	if err := s.gateStorageTx(ctx, tx, userID, snapshot.bytes); err != nil {
		return Workspace{}, err
	}

	newID := uid("ws")
	name := src.Name
	if isOwner {
		name += " (copy)"
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspaces (id, user_id, name, color, privacy) VALUES ($1,$2,$3,$4,'private')`,
		newID, userID, name, src.Color); err != nil {
		return Workspace{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`,
		newID, userID); err != nil {
		return Workspace{}, err
	}
	tagRefs := make([]TagRef, len(src.Tags))
	for i, tag := range src.Tags {
		tagRefs[i] = TagRef{Value: tag.Value}
	}
	if err := syncEntityTags(ctx, tx, userID, "workspace", newID, tagRefs); err != nil {
		return Workspace{}, err
	}

	// Chapters (old id -> new id).
	chapterMap := map[string]string{}
	{
		for _, c := range snapshot.chapters {
			nid := uid("ch")
			chapterMap[c.id] = nid
			if _, err := tx.Exec(ctx, `INSERT INTO chapters (id, workspace_id, name, position) VALUES ($1,$2,$3,$4)`,
				nid, newID, c.name, c.position); err != nil {
				return Workspace{}, err
			}
		}
	}

	// Files (old id -> new id); doc_id is copied so the pipeline's LightRAG
	// row copy (keyed by workspace) keeps the file <-> document link intact.
	fileMap := map[string]string{}
	{
		for _, f := range snapshot.files {
			nid := uid("f")
			fileMap[f.id] = nid
			var chapterID *string
			if f.chapterID != nil {
				if mapped, ok := chapterMap[*f.chapterID]; ok {
					chapterID = &mapped
				}
			}
			url := f.url
			if url != nil && *url == "/api/files/"+f.id+"/raw" {
				u := "/api/files/" + nid + "/raw"
				url = &u
			}
			if _, err := tx.Exec(ctx, `INSERT INTO files
				(id, workspace_id, user_id, created_by, chapter_id, position, name, kind, size_bytes, added_at, status, parser, engine, blob_path, url, content, doc_id)
				VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
				nid, newID, userID, chapterID, f.position, f.name, f.kind, f.sizeBytes, time.Now().UTC(), f.status, f.parser, f.engine, f.blobPath, url, f.content, f.docID); err != nil {
				return Workspace{}, err
			}
		}
	}

	// Ready editor assets are logical resources too. Their blob paths remain
	// shared, but each clone receives a new asset row and therefore its own
	// quota charge. Material content was rewritten to these IDs in the
	// snapshot phase.
	for _, asset := range snapshot.assets {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, created_at, completed_at)
			VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11)`,
			asset.newID, newID, userID, asset.name, asset.purpose,
			asset.objectPath, asset.contentType, asset.sizeBytes, asset.etag,
			asset.createdAt, asset.completedAt); err != nil {
			return Workspace{}, err
		}
	}

	// Materials (clone lands private; flashcards get fresh card ids + stats).
	{
		for _, materialSnapshot := range snapshot.materials {
			mt := materialSnapshot.material
			nid := uid("mat")
			var chapterID *string
			if mt.ChapterID != nil {
				if mapped, ok := chapterMap[*mt.ChapterID]; ok {
					chapterID = &mapped
				}
			}
			scopeFiles := make([]string, 0, len(mt.ScopeFileIDs))
			for _, fid := range mt.ScopeFileIDs {
				if mapped, ok := fileMap[fid]; ok {
					scopeFiles = append(scopeFiles, mapped)
				}
			}
			content := materialSnapshot.content
			metrics := materialSnapshot.metrics
			if _, err := tx.Exec(ctx, `INSERT INTO materials
				(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
				 chapter_id, position, scope_chapters, scope_file_ids, privacy, color, node_count, max_depth, updated_at, revision, updated_by)
				VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private',$12,$13,$14,$15,$16,$2)`,
				nid, userID, newID, name, mt.Kind, mt.Title, json.RawMessage(content), chapterID,
				mt.Position, mt.ScopeChapters, scopeFiles, mt.Color, metrics.NodeCount,
				metrics.MaxDepth, mt.UpdatedAt, mt.Revision); err != nil {
				return Workspace{}, err
			}
			rewrite := func(value string) (string, error) { return value, nil }
			if mt.Kind == "flashcards" {
				rewrite = func(value string) (string, error) {
					rewritten, _, err := rewriteCardIDsWithMap(value, materialSnapshot.cardIDMap)
					return rewritten, err
				}
			}
			if err := cloneMaterialRelations(ctx, tx, mt.ID, nid, rewrite); err != nil {
				return Workspace{}, err
			}
			for _, cid := range materialSnapshot.cardIDs {
				if _, err := tx.Exec(ctx, `INSERT INTO card_stats (card_id, material_id, srs, known) VALUES ($1,$2,$3,false)`,
					cid, nid, newSrsBytes()); err != nil {
					return Workspace{}, err
				}
			}
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE workspaces SET clone_count=clone_count+1 WHERE id=$1`, srcID); err != nil {
		return Workspace{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, userID, newID, false)
}

// CloneMaterial copies one shared material into the user's standalone library.
// Flashcards get fresh card ids + reset SRS stats. The clone lands private.
func (s *Store) CloneMaterial(ctx context.Context, userID, matID string) (Material, error) {
	if _, err := s.MaterialAccess(ctx, userID, matID); err != nil {
		return Material{}, err
	}
	src, err := s.GetMaterial(ctx, matID)
	if err != nil {
		return Material{}, err
	}

	content := src.Content
	var cardIDs []string
	cardIDMap := map[string]string{}
	if src.Kind == "flashcards" {
		if content, cardIDs, err = rewriteCardIDsWithMap(src.Content, cardIDMap); err != nil {
			return Material{}, err
		}
	}
	metrics, err := materialdoc.Metrics(content)
	if err != nil {
		return Material{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	storedSize, err := storageJSONSizeTx(ctx, tx, content)
	if err != nil {
		return Material{}, err
	}
	if err := s.gateStorageTx(ctx, tx, userID, storedSize); err != nil {
		return Material{}, err
	}

	nid := uid("mat")
	if _, err := tx.Exec(ctx, `INSERT INTO materials
		(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
		 scope_chapters, scope_file_ids, privacy, color, node_count, max_depth, updated_at, revision, updated_by)
		VALUES ($1,$2,$2,NULL,'',$3,$4,$5,$6,'{}','private',$7,$8,$9,$10,$11,$2)`,
		nid, userID, src.Kind, src.Title, json.RawMessage(content), src.ScopeChapters,
		src.Color, metrics.NodeCount, metrics.MaxDepth, src.UpdatedAt, src.Revision); err != nil {
		return Material{}, err
	}
	rewrite := func(value string) (string, error) { return value, nil }
	if src.Kind == "flashcards" {
		rewrite = func(value string) (string, error) {
			rewritten, _, err := rewriteCardIDsWithMap(value, cardIDMap)
			return rewritten, err
		}
	}
	if err := cloneMaterialRelations(ctx, tx, src.ID, nid, rewrite); err != nil {
		return Material{}, err
	}
	for _, cid := range cardIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO card_stats (card_id, material_id, srs, known) VALUES ($1,$2,$3,false)`,
			cid, nid, newSrsBytes()); err != nil {
			return Material{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET clone_count=clone_count+1 WHERE id=$1`, matID); err != nil {
		return Material{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, nid)
}

/* ---------------------------------------------------------------- deck patch */

// DeckPatch carries the mutable deck fields (the deck is a flashcards material).
type DeckPatch struct {
	Name    *string
	Color   *UserColor
	Privacy *Privacy
}

// UpdateDeck renames/recolours a deck and/or changes its visibility. Renames
// preserve the Plate document while updating the relational title.
func (s *Store) UpdateDeck(ctx context.Context, id string, p DeckPatch) (Deck, error) {
	mt, err := s.GetMaterial(ctx, id)
	if err != nil {
		return Deck{}, err
	}
	if mt.Kind != "flashcards" {
		return Deck{}, ErrNotFound
	}
	title, color, privacy := mt.Title, mt.Color, mt.Privacy
	content := mt.Content
	if p.Name != nil && *p.Name != mt.Title {
		title = *p.Name
		cards, err := materialdoc.ExtractFlashcards(mt.Content)
		if err != nil {
			return Deck{}, err
		}
		if content, err = materialdoc.ReplaceFlashcards(mt.Content, cards); err != nil {
			return Deck{}, err
		}
	}
	if p.Color != nil {
		color = *p.Color
	}
	if p.Privacy != nil {
		privacy = *p.Privacy
	}
	materialPatch := MaterialPatch{Privacy: &privacy}
	if p.Name != nil && *p.Name != mt.Title {
		materialPatch.Title = &title
		materialPatch.Content = &content
	}
	if _, err := s.UpdateMaterial(ctx, id, materialPatch); err != nil {
		return Deck{}, err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET color=$2 WHERE id=$1`, id, color); err != nil {
		return Deck{}, err
	}
	return s.GetDeck(ctx, id)
}
