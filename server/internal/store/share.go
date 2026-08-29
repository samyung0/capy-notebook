package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/models"
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

// WorkspaceEffectiveRole is the workspace-wide counterpart of
// MaterialEffectiveAccess: membership raised by the share role wherever the
// workspace is link/public. It answers collaboration questions that are not
// scoped to one material, such as who may read the collaborator directory.
// Structural authorization keeps using WorkspaceRole.
func (s *Store) WorkspaceEffectiveRole(ctx context.Context, userID, wsID string) (WorkspaceRole, error) {
	var owner *string
	var privacy Privacy
	var shareRole *ShareRole
	var memberRole WorkspaceRole
	err := s.pool.QueryRow(ctx, `
		SELECT w.user_id, w.privacy, w.share_role, COALESCE(wm.role,'')
		FROM workspaces w
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE w.id=$1`, wsID, userID).Scan(&owner, &privacy, &shareRole, &memberRole)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if userID != "" && owner != nil && *owner == userID {
		return RoleOwner, nil
	}
	var sharedRole WorkspaceRole
	if privacy == PrivacyLink || privacy == PrivacyPublic {
		sharedRole = RoleViewer
		if userID != "" && shareRole != nil {
			sharedRole = shareRole.WorkspaceRole()
		}
	}
	if memberRole == "" && sharedRole == "" {
		return "", ErrNotFound
	}
	return MaxRole(memberRole, sharedRole), nil
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

func roleRank(role WorkspaceRole) int {
	switch role {
	case RoleOwner:
		return 4
	case RoleEditor:
		return 3
	case RoleCommenter:
		return 2
	case RoleViewer:
		return 1
	default:
		return 0
	}
}

// MaxRole returns the more permissive of two grants. Roles are grants rather
// than caps, so a caller holding several of them keeps the strongest.
func MaxRole(a, b WorkspaceRole) WorkspaceRole {
	if roleRank(b) > roleRank(a) {
		return b
	}
	return a
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

// MaterialAccessInfo separates the caller's persisted membership from the
// role that actually applies to this request.
//
// Role is the more permissive of the two grants that can reach the caller:
// their membership and, on a link/public workspace, the share role. Capping a
// member at their invited role would not restrain anyone — a workspace shared
// for editing hands that same access to every other signed-in account — while
// it does surprise the one person who accepted an invitation.
//
// MemberRole carries the persisted role on its own for the checks that must
// stay membership-based, such as material metadata edits. A shared grant
// governs document collaboration and never workspace structure.
type MaterialAccessInfo struct {
	Role       WorkspaceRole
	MemberRole WorkspaceRole
}

// MaterialEffectiveAccess derives material access for this request:
//   - direct owner: owner
//   - explicit member: their role, raised to the share role where the
//     workspace is shared more permissively
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
		return MaterialAccessInfo{Role: RoleOwner, MemberRole: RoleOwner}, nil
	}
	if userID != "" && workspaceOwner != nil && *workspaceOwner == userID {
		return MaterialAccessInfo{Role: RoleOwner, MemberRole: RoleOwner}, nil
	}

	workspaceShared := wsID != nil && workspacePrivacy != nil &&
		(*workspacePrivacy == PrivacyLink || *workspacePrivacy == PrivacyPublic)
	materialShared := materialPrivacy == PrivacyLink || materialPrivacy == PrivacyPublic
	var sharedRole WorkspaceRole
	switch {
	case workspaceShared && userID != "" && shareRole != nil:
		sharedRole = shareRole.WorkspaceRole()
	case workspaceShared:
		// Anonymous readers are viewers whatever the share role says, because
		// every write route requires a session.
		sharedRole = RoleViewer
	case materialShared:
		// Material-only links are intentionally view-only, including when the
		// material still belongs to a private workspace.
		sharedRole = RoleViewer
	}

	if memberRole != "" {
		return MaterialAccessInfo{
			Role:       MaxRole(memberRole, sharedRole),
			MemberRole: memberRole,
		}, nil
	}
	if sharedRole != "" {
		return MaterialAccessInfo{Role: sharedRole}, nil
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
		if err := rows.Scan(&w.ID, &w.Name, &w.Color, &w.Privacy, &w.ShareRole, &w.Tags, &w.OwnerUserID, &w.OwnerName, &w.ChapterCount, &w.FileCount, &w.CreatedAt, &w.LastAccessedAt, &w.Author, &w.Clones); err != nil {
			return nil, err
		}
		w.FilesLimit = MaxFilesPerWorkspace
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) ListPublicQuizzes(ctx context.Context) ([]PublicQuiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, COALESCE(m.workspace_id,''), m.workspace_name, m.kind, m.title, m.content, m.chapter_id, m.scope_chapters, m.scope_file_names, m.privacy, m.color, m.created_at,
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
		if err := rows.Scan(&mt.ID, &mt.WorkspaceID, &mt.WorkspaceName, &mt.Kind, &mt.Title, &mt.Content, &mt.ChapterID, &mt.ScopeChapters, &mt.ScopeFileNames, &mt.Privacy, &mt.Color, &mt.CreatedAt, &author, &clones); err != nil {
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
	url, content                        *string
	parsedFingerprint                   *string
	parsedParserVersion, sourceETag     *string
	contentHash, sourceSHA256           *string
	sizeBytes                           int64
	position                            int64
	indexed, captionImages              bool
	parseMode                           string
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
		`SELECT id, chapter_id, position, name, kind, size_bytes, status, indexed,
			parser, engine, blob_path, url, content,
			parsed_fingerprint, parsed_parser_version, source_etag,
			content_hash, source_sha256, parse_mode, caption_images
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
			&file.indexed,
			&file.parser,
			&file.engine,
			&file.blobPath,
			&file.url,
			&file.content,
			&file.parsedFingerprint,
			&file.parsedParserVersion,
			&file.sourceETag,
			&file.contentHash,
			&file.sourceSHA256,
			&file.parseMode,
			&file.captionImages,
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
		if err := metrics.LimitError(); err != nil {
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
// fresh card stats, retrieval index) into a new workspace owned by userID. Blob
// objects are shared rather than duplicated: the clone copies blob_path and
// editor asset object paths, and the refcount triggers make that safe — the
// object survives until its last holder is gone, so deleting either workspace no
// longer leaks or destroys the other's bytes. The clone lands private regardless
// of the source's visibility.
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
	// The clone inherits the source's embedding pin instead of taking the current
	// default. cloneRetrievalIndex copies vectors verbatim rather than
	// re-embedding, so the copy is already in the source's space; giving the new
	// workspace a different pin would mean every future upload landed in one
	// space and every query was embedded in the other, with no error and no way
	// back short of a reindex.
	var srcEmbed workspaceEmbedding
	if err := tx.QueryRow(ctx,
		`SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim
		   FROM workspaces WHERE id = $1`, srcID,
	).Scan(&srcEmbed.Pin.ProviderSlug, &srcEmbed.Pin.ModelSlug, &srcEmbed.Pin.Version, &srcEmbed.Dim); err != nil {
		return Workspace{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspaces
			(id, user_id, name, color, privacy,
			 embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim)
		VALUES ($1,$2,$3,$4,'private',$5,$6,$7,$8)`,
		newID, userID, name, src.Color,
		srcEmbed.Pin.ProviderSlug, srcEmbed.Pin.ModelSlug, srcEmbed.Pin.Version, srcEmbed.Dim); err != nil {
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

	// Files. Parse-zip and caption object keys are owned by artifact_cache,
	// not copied: clone copies the rag_* rows in-transaction and never reads
	// those objects. source_sha256 rides along so a later ingest can find a
	// donor instead of re-parsing.
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
				(id, workspace_id, user_id, created_by, chapter_id, position, name, kind, size_bytes, added_at, status, indexed, parser, engine, blob_path, url, content,
				 parsed_fingerprint, parsed_parser_version, source_etag, content_hash, source_sha256, parse_mode, caption_images)
				VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
				nid, newID, userID, chapterID, f.position, f.name, f.kind, f.sizeBytes, time.Now().UTC(), f.status, f.indexed, f.parser, f.engine, f.blobPath, url, f.content,
				f.parsedFingerprint, f.parsedParserVersion, f.sourceETag, f.contentHash, f.sourceSHA256, f.parseMode, f.captionImages); err != nil {
				return Workspace{}, err
			}
		}
	}

	if err := cloneRetrievalIndex(ctx, tx, srcID, newID, srcEmbed.Pin, fileMap, chapterMap); err != nil {
		return Workspace{}, err
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
			content := materialSnapshot.content
			metrics := materialSnapshot.metrics
			if _, err := tx.Exec(ctx, `INSERT INTO materials
				(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
				 chapter_id, position, scope_chapters, scope_file_names, privacy, color, node_count, max_depth, updated_at, revision, updated_by)
				VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private',$12,$13,$14,$15,$16,$2)`,
				nid, userID, newID, name, mt.Kind, mt.Title, json.RawMessage(content), chapterID,
				mt.Position, mt.ScopeChapters, mt.ScopeFileNames, mt.Color, metrics.NodeCount,
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

// cloneRetrievalIndex copies a workspace's chunks, file summaries and concept
// index into the clone, inside the same transaction as the content it
// describes. Copying the vectors is pure SQL where re-ingesting would mean
// paying for the parse and the embeddings again.
//
// The source pin names the vector table on both sides of the copy. An empty
// workspace has no vectors, so the table is resolved only once there is
// content; a fixture pin that is not in the allowlist can still clone.
//
// Canonical content receives fresh ids because it is workspace-scoped, while
// duplicate logical files in the clone keep sharing one copied index.
func cloneRetrievalIndex(ctx context.Context, tx pgx.Tx, srcID, newID string, pin models.Pin, fileMap, chapterMap map[string]string) error {
	oldFiles, newFiles := unzipIDs(fileMap)
	if len(oldFiles) > 0 {
		contentMap := map[string]string{}
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT content_id FROM rag_file_contents
			WHERE file_id = ANY($1::text[])`, oldFiles)
		if err != nil {
			return err
		}
		for rows.Next() {
			var oldContentID string
			if err := rows.Scan(&oldContentID); err != nil {
				rows.Close()
				return err
			}
			contentMap[oldContentID] = uid("rgc")
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		oldContents, newContents := unzipIDs(contentMap)

		if len(oldContents) > 0 {
			vectors, err := vectorTable(pin)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
				INSERT INTO rag_contents (id, workspace_id, content_hash, status,
					embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim,
					source_sha256, pipeline_identity)
				SELECT c.new_id, $3, rc.content_hash, rc.status,
				       rc.embedding_provider_slug, rc.embedding_model_slug, rc.embedding_model_version, rc.embedding_dim,
				       rc.source_sha256, rc.pipeline_identity
				FROM rag_contents rc JOIN cmap c ON c.old_id = rc.id`,
				oldContents, newContents, newID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				WITH fmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[])),
				     cmap(old_id, new_id) AS (SELECT * FROM unnest($3::text[], $4::text[]))
				INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
				SELECT f.new_id, $5, c.new_id
				FROM rag_file_contents fc
				JOIN fmap f ON f.old_id = fc.file_id
				JOIN cmap c ON c.old_id = fc.content_id`,
				oldFiles, newFiles, oldContents, newContents, newID); err != nil {
				return err
			}
			// Mirrors copy_content_from_donor in pipeline/pipeline/retrieval/store.py:
			// dest chunk ids are derived from dest workspace id + donor chunk id so
			// the vector copy can recompute them and pair each embedding with its
			// passage. newID is freshly minted, so the derivation is still unique
			// across clones of the same source.
			const newChunkID = `'rc_' || substr(md5($3 || c.id), 1, 12)`
			if _, err := tx.Exec(ctx, `
			WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
			INSERT INTO rag_chunks
				(id, workspace_id, content_id, chunk_idx, section_path, text, indexed_text,
				 token_count, page_start, page_end, regions, search)
			SELECT `+newChunkID+`,
			       $3, m.new_id, c.chunk_idx, c.section_path, c.text, c.indexed_text,
			       c.token_count, c.page_start, c.page_end, c.regions, c.search
			FROM rag_chunks c JOIN cmap m ON m.old_id = c.content_id`,
				oldContents, newContents, newID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
			WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
			INSERT INTO `+vectors+` (chunk_id, workspace_id, embedding)
			SELECT `+newChunkID+`, $3, v.embedding
			FROM rag_chunks c
			JOIN cmap m ON m.old_id = c.content_id
			JOIN `+vectors+` v ON v.chunk_id = c.id`,
				oldContents, newContents, newID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
			WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
			INSERT INTO rag_content_summaries
				(content_id, workspace_id, fingerprint, descriptor, summary, summary_version, updated_at)
			SELECT c.new_id, $3, s.fingerprint, s.descriptor, s.summary, s.summary_version, s.updated_at
			FROM rag_content_summaries s JOIN cmap c ON c.old_id = s.content_id`,
				oldContents, newContents, newID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
			INSERT INTO rag_concepts (id, workspace_id, name, norm)
			SELECT 'rcp_' || substr(md5(random()::text || clock_timestamp()::text || k.id), 1, 12),
			       $1, k.name, k.norm
			FROM rag_concepts k WHERE k.workspace_id = $2`, newID, srcID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
			WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
			INSERT INTO rag_concept_mentions (concept_id, chunk_id)
			SELECT nk.id, nc.id
			FROM rag_concept_mentions m
			JOIN rag_concepts ok ON ok.id = m.concept_id AND ok.workspace_id = $3
			JOIN rag_chunks    oc ON oc.id = m.chunk_id
			JOIN cmap c           ON c.old_id = oc.content_id
			JOIN rag_chunks    nc ON nc.content_id = c.new_id AND nc.chunk_idx = oc.chunk_idx
			JOIN rag_concepts  nk ON nk.workspace_id = $4 AND nk.norm = ok.norm
			ON CONFLICT DO NOTHING`,
				oldContents, newContents, srcID, newID); err != nil {
				return err
			}
		}
	}

	return nil
}

func unzipIDs(m map[string]string) (old, fresh []string) {
	old = make([]string, 0, len(m))
	fresh = make([]string, 0, len(m))
	for o, n := range m {
		old = append(old, o)
		fresh = append(fresh, n)
	}
	return old, fresh
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
	if err := metrics.LimitError(); err != nil {
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
		 scope_chapters, scope_file_names, privacy, color, node_count, max_depth, updated_at, revision, updated_by)
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
