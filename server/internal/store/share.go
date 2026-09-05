package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/models"
	"github.com/jackc/pgx/v5"
)

/* -------------------------------------------------------------- access checks

Sharing model: workspace privacy is inherited by everything inside it, while
standalone materials keep their own privacy.
  - owner / member → read (and write per role capabilities)
  - link/public    → any caller may read; signed-in workspace nonmembers receive
    share_role for material collaboration, while anonymous callers view only
  - private        → owner/members only (404 for everyone else)
A material is readable when its parent workspace is link/public, or when it is
standalone and its own policy is link/public. */

// WorkspaceAccess reports whether userID may read wsID. isOwner is true for
// the owner; (false, nil) means shared read access (privacy link/public).
func (s *Store) WorkspaceAccess(ctx context.Context, userID, wsID string) (isOwner bool, err error) {
	var owner *string
	var privacy Privacy
	e := s.pool.QueryRow(ctx, `SELECT w.user_id, w.privacy
		FROM workspaces w
		JOIN users owner ON owner.id=w.user_id
		WHERE w.id=$1 AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL`, wsID).Scan(&owner, &privacy)
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
		JOIN users owner ON owner.id=w.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE w.id=$1 AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL`, wsID, userID).Scan(&role)
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
		JOIN users owner ON owner.id=w.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE w.id=$1 AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL`, wsID, userID).Scan(&owner, &privacy, &shareRole, &memberRole)
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
	err := s.pool.QueryRow(ctx, `SELECT m.owner_user_id, m.workspace_id
		FROM materials m
		JOIN users owner ON owner.id=m.owner_user_id
		WHERE m.id=$1 AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL`, matID).
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
//   - standalone material-level sharing: viewer
func materialEffectiveAccess(
	ctx context.Context,
	q rowQueryer,
	userID, matID string,
) (MaterialAccessInfo, error) {
	var materialOwner, wsID, workspaceOwner *string
	var materialPrivacy Privacy
	var workspacePrivacy *Privacy
	var shareRole *ShareRole
	var memberRole WorkspaceRole
	err := q.QueryRow(ctx, `
		SELECT m.owner_user_id, m.privacy, m.workspace_id, w.user_id, w.privacy, w.share_role,
			COALESCE(wm.role, '')
		FROM materials m
		JOIN users material_owner ON material_owner.id=m.owner_user_id
		LEFT JOIN workspaces w ON w.id=m.workspace_id
		LEFT JOIN workspace_members wm
			ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE m.id=$1 AND material_owner.deleted_at IS NULL
			AND material_owner.deletion_requested_at IS NULL`, matID, userID).Scan(
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
	materialShared := wsID == nil && (materialPrivacy == PrivacyLink || materialPrivacy == PrivacyPublic)
	var sharedRole WorkspaceRole
	switch {
	case workspaceShared && userID != "" && shareRole != nil:
		sharedRole = shareRole.WorkspaceRole()
	case workspaceShared:
		// Anonymous readers are viewers whatever the share role says, because
		// every write route requires a session.
		sharedRole = RoleViewer
	case materialShared:
		// Standalone material links are intentionally view-only.
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

func (s *Store) MaterialEffectiveAccess(ctx context.Context, userID, matID string) (MaterialAccessInfo, error) {
	return materialEffectiveAccess(ctx, s.pool, userID, matID)
}

// UpdateStandaloneMaterialPrivacy is the only material-sharing write. It
// rejects workspace materials and resource-kind mismatches before delegating
// to the ordinary lifecycle-fenced material update.
func (s *Store) UpdateStandaloneMaterialPrivacy(
	ctx context.Context,
	userID, materialID, expectedKind string,
	privacy Privacy,
) (Material, error) {
	material, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Material{}, err
	}
	if material.OwnerUserID != userID || material.WorkspaceID != "" ||
		(expectedKind != "" && string(material.Kind) != expectedKind) {
		return Material{}, ErrNotFound
	}
	return s.UpdateMaterial(ctx, materialID, MaterialPatch{
		Privacy: &privacy, UpdatedBy: userID,
	})
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

// CardMaterialID resolves the flashcardSet (flashcards material) owning a card.
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
	w, err := s.scanWorkspace(s.pool.QueryRow(ctx, "SELECT "+wsCols+" FROM workspaces w WHERE w.id=$1", id))
	if isNoRows(err) {
		return w, ErrNotFound
	}
	return w, err
}

/* ------------------------------------------------------------------- explore

Explore reads live rows: everything with privacy='public' plus its author name
and clone counter. The seeded public_* snapshot tables are no longer used. */

func (s *Store) ListPublicWorkspaces(ctx context.Context) ([]PublicWorkspace, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+wsCols+`, COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0)
		FROM workspaces w LEFT JOIN users u ON u.id=w.user_id
		LEFT JOIN workspace_clone_counts cc ON cc.workspace_id=w.id
		WHERE w.privacy='public'
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, w.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicWorkspace{}
	for rows.Next() {
		var w PublicWorkspace
		if err := rows.Scan(&w.ID, &w.Name, &w.Color, &w.Privacy, &w.ShareRole,
			&w.Tags, &w.OwnerUserID, &w.OwnerName, &w.OwnerPlanTier,
			&w.ChapterCount, &w.FileCount, &w.CreatedAt, &w.LastAccessedAt,
			&w.Author, &w.Clones); err != nil {
			return nil, err
		}
		limits, err := s.PlanLimits(w.OwnerPlanTier)
		if err != nil {
			return nil, err
		}
		w.FilesLimit = limits.FilesPerWorkspace
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) ListPublicQuizzes(ctx context.Context) ([]PublicQuiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, COALESCE(m.workspace_id,''), m.workspace_name, m.kind, m.title, m.content, m.chapter_id, m.scope_chapters, m.scope_file_names, m.privacy, m.color, m.created_at,
			COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0)
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=m.owner_user_id
		LEFT JOIN material_clone_counts cc ON cc.material_id=m.id
		WHERE m.kind='quiz'
		  AND ((m.workspace_id IS NULL AND m.privacy='public') OR w.privacy='public')
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, m.created_at DESC`)
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

func (s *Store) ListPublicFlashcardSets(ctx context.Context) ([]PublicFlashcardSet, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, COALESCE(m.workspace_id,''), m.workspace_name, m.color, m.privacy,`+flashcardSetStatsExpr+`,
			COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0)
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=m.owner_user_id
		LEFT JOIN material_clone_counts cc ON cc.material_id=m.id
		WHERE m.kind='flashcards'
		  AND ((m.workspace_id IS NULL AND m.privacy='public') OR w.privacy='public')
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, m.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicFlashcardSet{}
	for rows.Next() {
		var d PublicFlashcardSet
		if err := rows.Scan(&d.ID, &d.Name, &d.WorkspaceID, &d.WorkspaceName, &d.Color, &d.Privacy, &d.CardCount, &d.KnownPct, &d.DueCount, &d.Author, &d.Clones); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

/* -------------------------------------------------------------------- cloning */

// rewriteCardIDs re-keys every card in a flashcards document. card_stats.card_id
// is a global primary key, so a cloned flashcardSet must mint fresh card ids before
// fresh (reset) SRS rows can be inserted for them.
func rewriteCardIDs(_ string, content string) (newContent string, newIDs []string, err error) {
	return rewriteCardIDsWithMap(content, map[string]string{})
}

func rewriteCardIDsWithMap(content string, idMap map[string]string) (newContent string, newIDs []string, err error) {
	return materialdoc.RewriteFlashcardIDs(content, idMap, func() string { return uid("c") })
}

func (s *Store) materialCloneHistory(
	ctx context.Context,
	tx pgx.Tx,
	sourceID, targetUserID string,
) ([]MaterialRevision, error) {
	tier, err := s.effectivePlanTierForUser(ctx, tx, targetUserID)
	if err != nil {
		return nil, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return nil, err
	}
	revisions, err := tx.Query(ctx, `SELECT revision, parent_revision, event_type, title, content,
		event_metadata, created_by, created_at
		FROM (
			SELECT * FROM material_revisions WHERE material_id=$1
			ORDER BY version_date DESC LIMIT $2
		) retained ORDER BY version_date`, sourceID, limits.MaterialRevisions)
	if err != nil {
		return nil, err
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
			return nil, err
		}
		history = append(history, row)
	}
	revisions.Close()
	if err := revisions.Err(); err != nil {
		return nil, err
	}
	return history, nil
}

func (s *Store) cloneMaterialRelations(
	ctx context.Context,
	tx pgx.Tx,
	targetID string,
	history []MaterialRevision,
	rewriteContent func(string) (string, error),
) error {
	for _, row := range history {
		content, err := rewriteContent(row.Content)
		if err != nil {
			return err
		}
		row.MaterialID = targetID
		row.Content = content
		if err := s.upsertMaterialRevisionTx(ctx, tx, row); err != nil {
			return err
		}
	}
	// Comment threads are intentionally not copied. A clone receives only the
	// retained daily material history.
	return nil
}

func snapshotStandaloneCloneAssets(
	ctx context.Context,
	tx pgx.Tx,
	source Material,
	contents []string,
) ([]workspaceCloneAsset, map[string]string, int64, error) {
	referenced := map[string]struct{}{}
	for _, content := range contents {
		ids, err := materialdoc.EditorAssetIDs(content)
		if err != nil {
			return nil, nil, 0, err
		}
		for _, id := range ids {
			referenced[id] = struct{}{}
		}
	}
	ids := make([]string, 0, len(referenced))
	for id := range referenced {
		ids = append(ids, id)
	}
	assetMap := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return nil, assetMap, 0, nil
	}
	rows, err := tx.Query(ctx, `SELECT id, name, purpose, object_path, content_type,
		size_bytes, status, COALESCE(etag,''), created_at, completed_at
		FROM editor_assets
		WHERE id=ANY($1) AND status='ready' AND (
			($2 <> '' AND workspace_id=$2) OR
			($2 = '' AND material_id=$3)
		)`, ids, source.WorkspaceID, source.ID)
	if err != nil {
		return nil, nil, 0, err
	}
	defer rows.Close()
	var assets []workspaceCloneAsset
	var bytes int64
	for rows.Next() {
		var asset workspaceCloneAsset
		if err := rows.Scan(
			&asset.oldID, &asset.name, &asset.purpose, &asset.objectPath,
			&asset.contentType, &asset.sizeBytes, &asset.status, &asset.etag,
			&asset.createdAt, &asset.completedAt,
		); err != nil {
			return nil, nil, 0, err
		}
		asset.newID = uid("asset")
		assetMap[asset.oldID] = asset.newID
		bytes += asset.sizeBytes
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, 0, err
	}
	return assets, assetMap, bytes, nil
}

type workspaceCloneChapter struct {
	id       string
	name     string
	position int
}

type workspaceCloneFile struct {
	id, name, kind, status              string
	chapterID, parser, engine, blobPath *string
	previewBlobPath                     *string
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
	history   []MaterialRevision
	metrics   materialdoc.DocumentMetrics
	sizeBytes int64
	cardIDs   []string
}

type workspaceCloneSnapshot struct {
	chapters  []workspaceCloneChapter
	files     []workspaceCloneFile
	assets    []workspaceCloneAsset
	materials []workspaceCloneMaterial
	bytes     int64
}

func lockCloneBlobPathsTx(
	ctx context.Context,
	tx pgx.Tx,
	paths []string,
) error {
	unique := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if path != "" {
			unique[path] = struct{}{}
		}
	}
	if len(unique) == 0 {
		return nil
	}
	ordered := make([]string, 0, len(unique))
	for path := range unique {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	rows, err := tx.Query(ctx, `SELECT object_path FROM blobs
		WHERE object_path=ANY($1::text[])
		ORDER BY object_path FOR UPDATE`, ordered)
	if err != nil {
		return err
	}
	defer rows.Close()
	locked := 0
	for rows.Next() {
		locked++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if locked != len(ordered) {
		return ErrConflict
	}
	return nil
}

func workspaceCloneBlobPaths(snapshot workspaceCloneSnapshot) []string {
	paths := make([]string, 0, len(snapshot.files)*2+len(snapshot.assets))
	for _, file := range snapshot.files {
		if file.blobPath != nil {
			paths = append(paths, *file.blobPath)
		}
		if file.previewBlobPath != nil {
			paths = append(paths, *file.previewBlobPath)
		}
	}
	for _, asset := range snapshot.assets {
		paths = append(paths, asset.objectPath)
	}
	return paths
}

func (s *Store) snapshotWorkspaceForClone(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, targetUserID string,
) (workspaceCloneSnapshot, error) {
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
			(indexed AND EXISTS (
				SELECT 1 FROM rag_file_contents fc
				JOIN rag_contents rc ON rc.id=fc.content_id
				WHERE fc.file_id=files.id AND rc.status='ready'
			)),
			parser, engine, blob_path, preview_blob_path, url, content,
			parsed_fingerprint, parsed_parser_version, source_etag,
			content_hash, source_sha256, parse_mode, caption_images
		 FROM files
		 WHERE workspace_id=$1 AND status='ready'
		 ORDER BY added_at`,
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
			&file.previewBlobPath,
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
		snapshot.materials = append(snapshot.materials, workspaceCloneMaterial{
			material: material,
			content:  material.Content,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()

	for i := range snapshot.materials {
		materialSnapshot := &snapshot.materials[i]
		history, err := s.materialCloneHistory(
			ctx, tx, materialSnapshot.material.ID, targetUserID,
		)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		cardIDMap := map[string]string{}
		if materialSnapshot.material.Kind == "flashcards" {
			materialSnapshot.content, materialSnapshot.cardIDs, err = rewriteCardIDsWithMap(
				materialSnapshot.content, cardIDMap,
			)
			if err != nil {
				return workspaceCloneSnapshot{}, err
			}
		}
		materialSnapshot.content, err = materialdoc.RewriteClonedEditorAssetIDs(
			materialSnapshot.content, assetIDs,
		)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		for j := range history {
			if materialSnapshot.material.Kind == "flashcards" {
				history[j].Content, _, err = rewriteCardIDsWithMap(history[j].Content, cardIDMap)
				if err != nil {
					return workspaceCloneSnapshot{}, err
				}
			}
			history[j].Content, err = materialdoc.RewriteClonedEditorAssetIDs(
				history[j].Content, assetIDs,
			)
			if err != nil {
				return workspaceCloneSnapshot{}, err
			}
		}
		materialSnapshot.history = history
		materialSnapshot.metrics, err = materialdoc.Metrics(materialSnapshot.content)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		if err := materialSnapshot.metrics.LimitError(); err != nil {
			return workspaceCloneSnapshot{}, err
		}
		sizeBytes, err := storageJSONSizeTx(
			ctx, tx, materialSnapshot.content,
		)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		materialSnapshot.sizeBytes = sizeBytes
		snapshot.bytes += sizeBytes
	}

	return snapshot, nil
}

// CloneWorkspace deep-copies a shared workspace (chapters, files, materials,
// fresh card stats, retrieval index) into a new workspace owned by userID. Blob
// objects are shared rather than duplicated: the clone copies blob_path and
// editor asset object paths, and locks their refcount rows through commit. The
// object survives until its last holder is gone, so deleting either workspace no
// longer leaks or destroys the other's bytes. The clone lands private regardless
// of the source's visibility.
func (s *Store) CloneWorkspace(ctx context.Context, userID, srcID string) (Workspace, error) {
	// A workspace snapshot owns the hierarchy fence so contained material
	// deletion cannot race its counter and blob-reference copy.
	conn, unlock, err := s.lockWorkspaceCloneSource(ctx, srcID, false)
	if err != nil {
		return Workspace{}, err
	}
	defer unlock()
	for attempt := 0; ; attempt++ {
		workspace, err := s.cloneWorkspaceOnce(ctx, conn, userID, srcID)
		if !isRetryableTransactionError(err) {
			return workspace, err
		}
		if err := waitCloneRetry(ctx, attempt); err != nil {
			return Workspace{}, err
		}
	}
}

type cloneTxStarter interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

func waitCloneRetry(ctx context.Context, attempt int) error {
	delay := 5 * time.Millisecond * time.Duration(1<<min(attempt, 5))
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Store) cloneWorkspaceOnce(
	ctx context.Context,
	starter cloneTxStarter,
	userID, srcID string,
) (Workspace, error) {
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback(ctx)

	// Repeatable read gives the clone one self-consistent source snapshot without
	// locking live workspace/material rows. A clone deliberately accepts a stale
	// SQL projection and must never wait for Yjs persistence or projection.
	src, err := s.scanWorkspace(tx.QueryRow(ctx, `SELECT `+wsCols+`
		FROM workspaces w
		JOIN users source_owner ON source_owner.id=w.user_id
		WHERE w.id=$1
		  AND source_owner.deleted_at IS NULL
		  AND source_owner.deletion_requested_at IS NULL`, srcID))
	if isNoRows(err) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	if err := lockCloneAccountsTx(ctx, tx, src.OwnerUserID, userID); err != nil {
		var locked *AccountLockedError
		if errors.As(err, &locked) && locked.UserID == src.OwnerUserID {
			return Workspace{}, ErrNotFound
		}
		return Workspace{}, err
	}
	isOwner := src.OwnerUserID == userID
	if !isOwner {
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_members
			WHERE workspace_id=$1 AND user_id=$2)`, srcID, userID).Scan(&member); err != nil {
			return Workspace{}, err
		}
		if !member && src.Privacy != PrivacyLink && src.Privacy != PrivacyPublic {
			return Workspace{}, ErrNotFound
		}
	}
	limits, err := s.gateOwnedWorkspacesTx(ctx, tx, userID, 1)
	if err != nil {
		return Workspace{}, err
	}
	// The target account lock above freezes both its current plan and its
	// history-retention limit before we select any source revisions. Otherwise a
	// concurrent downgrade could prune old history and the clone could restore
	// the larger pre-downgrade snapshot afterward.
	snapshot, err := s.snapshotWorkspaceForClone(ctx, tx, srcID, userID)
	if err != nil {
		return Workspace{}, err
	}
	// Physical paths are shared, so keep the refcount rows locked until the clone
	// references commit. A concurrent last-reference delete then happens either
	// before this repeatable-read snapshot or after the clone is durable.
	if err := lockCloneBlobPathsTx(ctx, tx, workspaceCloneBlobPaths(snapshot)); err != nil {
		return Workspace{}, err
	}
	if len(snapshot.files) > limits.FilesPerWorkspace {
		return Workspace{}, &FileLimitExceededError{
			WorkspaceID: srcID,
			Used:        0,
			Requested:   len(snapshot.files),
			Limit:       limits.FilesPerWorkspace,
			Kind:        "workspace",
		}
	}
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

	// Files. Parse-zip and caption object keys are owned by artifact_cache and
	// are not copied. The exact Office preview is a viewable file resource, so
	// clones share its path and the blob refcount keeps it alive.
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
				(id, workspace_id, user_id, created_by, chapter_id, position, name, kind, size_bytes, added_at, status, indexed, parser, engine, blob_path, preview_blob_path, url, content,
				 parsed_fingerprint, parsed_parser_version, source_etag, content_hash, source_sha256, parse_mode, caption_images)
				VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
				nid, newID, userID, chapterID, f.position, f.name, f.kind, f.sizeBytes, time.Now().UTC(), f.status, f.indexed, f.parser, f.engine, f.blobPath, f.previewBlobPath, url, f.content,
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

	// Materials (clone lands private; retained history shares the same fresh
	// asset/card ID maps as current content, while comments are not copied).
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
			createdAt := time.Now().UTC()
			if _, err := tx.Exec(ctx, `INSERT INTO materials
				(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
					 chapter_id, position, scope_chapters, scope_file_names, privacy, color, node_count, max_depth, updated_at, revision, updated_by)
				VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private',$12,$13,$14,$15,$16,$2)`,
				nid, userID, newID, name, mt.Kind, mt.Title, json.RawMessage(content), chapterID,
				mt.Position, mt.ScopeChapters, mt.ScopeFileNames, mt.Color, metrics.NodeCount,
				metrics.MaxDepth, createdAt, mt.Revision); err != nil {
				return Workspace{}, err
			}
			if err := s.cloneMaterialRelations(
				ctx, tx, nid, materialSnapshot.history,
				func(value string) (string, error) { return value, nil },
			); err != nil {
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

	if _, err := tx.Exec(ctx, `INSERT INTO workspace_clone_counts (workspace_id, clone_count)
		VALUES ($1,1) ON CONFLICT (workspace_id) DO UPDATE
		SET clone_count=workspace_clone_counts.clone_count+1`, srcID); err != nil {
		return Workspace{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, userID, newID, false)
}

// cloneRetrievalIndex copies a workspace's chunks and file summaries into
// the clone, inside the same transaction as the content it describes. Copying the vectors is pure SQL where re-ingesting would mean
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
			SELECT DISTINCT fc.content_id FROM rag_file_contents fc
			JOIN rag_contents rc ON rc.id=fc.content_id
			WHERE fc.file_id = ANY($1::text[]) AND rc.status='ready'`, oldFiles)
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
				FROM rag_contents rc JOIN cmap c ON c.old_id = rc.id
				WHERE rc.status='ready'`,
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
				 token_count, page_start, page_end, regions, lang, search)
			SELECT `+newChunkID+`,
			       $3, m.new_id, c.chunk_idx, c.section_path, c.text, c.indexed_text,
			       c.token_count, c.page_start, c.page_end, c.regions, c.lang, c.search
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
	return s.CloneMaterialKind(ctx, userID, matID, "")
}

// CloneMaterialKind applies a typed endpoint's kind before any copy or clone
// counter side effect. An empty kind is the generic material clone route.
func (s *Store) CloneMaterialKind(
	ctx context.Context,
	userID, matID, expectedKind string,
) (Material, error) {
	conn, unlock, err := s.lockMaterialCloneSource(ctx, matID, false)
	if err != nil {
		return Material{}, err
	}
	defer unlock()
	for attempt := 0; ; attempt++ {
		material, err := s.cloneMaterialKindOnce(
			ctx, conn, userID, matID, expectedKind,
		)
		if !isRetryableTransactionError(err) {
			return material, err
		}
		if err := waitCloneRetry(ctx, attempt); err != nil {
			return Material{}, err
		}
	}
}

func (s *Store) cloneMaterialKindOnce(
	ctx context.Context,
	starter cloneTxStarter,
	userID, matID, expectedKind string,
) (Material, error) {
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	var sourceWorkspaceID *string
	var sourceOwnerID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id, owner_user_id
		FROM materials WHERE id=$1`, matID).
		Scan(&sourceWorkspaceID, &sourceOwnerID); isNoRows(err) {
		return Material{}, ErrNotFound
	} else if err != nil {
		return Material{}, err
	}
	// Account lifecycle is the only source-side serialization. The material and
	// workspace remain unlocked so accepted collaboration stores can finish.
	if err := lockCloneAccountsTx(ctx, tx, sourceOwnerID, userID); err != nil {
		var locked *AccountLockedError
		if errors.As(err, &locked) && locked.UserID == sourceOwnerID {
			return Material{}, ErrNotFound
		}
		return Material{}, err
	}
	src, err := scanMaterial(tx.QueryRow(ctx, `SELECT `+materialCols+`
		FROM materials WHERE id=$1`, matID))
	if err != nil {
		return Material{}, err
	}
	if src.OwnerUserID != sourceOwnerID ||
		(sourceWorkspaceID == nil) != (src.WorkspaceID == "") ||
		(sourceWorkspaceID != nil && src.WorkspaceID != *sourceWorkspaceID) {
		return Material{}, ErrConflict
	}
	if _, err := materialEffectiveAccess(ctx, tx, userID, matID); err != nil {
		return Material{}, err
	}
	if expectedKind != "" && string(src.Kind) != expectedKind {
		return Material{}, ErrNotFound
	}

	history, err := s.materialCloneHistory(ctx, tx, src.ID, userID)
	if err != nil {
		return Material{}, err
	}
	assetContents := make([]string, 0, len(history)+1)
	assetContents = append(assetContents, src.Content)
	for _, revision := range history {
		assetContents = append(assetContents, revision.Content)
	}
	assets, assetIDMap, assetBytes, err := snapshotStandaloneCloneAssets(
		ctx, tx, src, assetContents,
	)
	if err != nil {
		return Material{}, err
	}
	assetPaths := make([]string, len(assets))
	for i, asset := range assets {
		assetPaths[i] = asset.objectPath
	}
	if err := lockCloneBlobPathsTx(ctx, tx, assetPaths); err != nil {
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
	content, err = materialdoc.RewriteClonedEditorAssetIDs(content, assetIDMap)
	if err != nil {
		return Material{}, err
	}
	metrics, err := materialdoc.Metrics(content)
	if err != nil {
		return Material{}, err
	}
	if err := metrics.LimitError(); err != nil {
		return Material{}, err
	}

	storedSize, err := storageJSONSizeTx(ctx, tx, content)
	if err != nil {
		return Material{}, err
	}
	if err := s.gateStorageTx(ctx, tx, userID, storedSize+assetBytes); err != nil {
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
	for _, asset := range assets {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose,
			 object_path, content_type, size_bytes, status, etag, created_at, completed_at)
			VALUES ($1,NULL,$2,$3,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11)`,
			asset.newID, nid, userID, asset.name, asset.purpose, asset.objectPath,
			asset.contentType, asset.sizeBytes, asset.etag, asset.createdAt,
			asset.completedAt); err != nil {
			return Material{}, err
		}
	}
	rewrite := func(value string) (string, error) {
		if src.Kind == "flashcards" {
			var rewriteErr error
			value, _, rewriteErr = rewriteCardIDsWithMap(value, cardIDMap)
			if rewriteErr != nil {
				return "", rewriteErr
			}
		}
		return materialdoc.RewriteClonedEditorAssetIDs(value, assetIDMap)
	}
	if err := s.cloneMaterialRelations(ctx, tx, nid, history, rewrite); err != nil {
		return Material{}, err
	}
	for _, cid := range cardIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO card_stats (card_id, material_id, srs, known) VALUES ($1,$2,$3,false)`,
			cid, nid, newSrsBytes()); err != nil {
			return Material{}, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO material_clone_counts (material_id, clone_count)
		VALUES ($1,1) ON CONFLICT (material_id) DO UPDATE
		SET clone_count=material_clone_counts.clone_count+1`, matID); err != nil {
		return Material{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, nid)
}

// lockCloneAccountsTx follows the normal ordered account lock
// discipline, but suspension of a different source owner does not hide content
// that was already shared. The cloning actor must still have an active session.
func lockCloneAccountsTx(
	ctx context.Context,
	tx pgx.Tx,
	sourceOwnerID, actorUserID string,
) error {
	ids := []string{sourceOwnerID}
	if actorUserID != sourceOwnerID {
		ids = append(ids, actorUserID)
	}
	rows, err := tx.Query(ctx, `SELECT id, deleted_at, deletion_requested_at,
			suspended_at, suspended_reason
		FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id string
		var deletedAt, deletionRequestedAt, suspendedAt *time.Time
		var reason *string
		if err := rows.Scan(
			&id, &deletedAt, &deletionRequestedAt, &suspendedAt, &reason,
		); err != nil {
			return err
		}
		seen++
		state := AccountActive
		switch {
		case deletedAt != nil:
			state = AccountDeleted
		case deletionRequestedAt != nil:
			state = AccountDeletionPending
		case suspendedAt != nil:
			state = AccountSuspended
		}
		if state == AccountActive ||
			(state == AccountSuspended && id == sourceOwnerID && id != actorUserID) {
			continue
		}
		locked := &AccountLockedError{UserID: id, State: state}
		if reason != nil {
			locked.Reason = *reason
		}
		return locked
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if seen != len(ids) {
		return ErrNotFound
	}
	return nil
}

/* ---------------------------------------------------------------- flashcardSet patch */

// FlashcardSetPatch carries the mutable flashcardSet fields (the flashcardSet is a flashcards material).
type FlashcardSetPatch struct {
	Name      *string
	Color     *UserColor
	UpdatedBy string
}

// UpdateFlashcardSet changes relational metadata only. Flashcard content and
// standalone sharing use separate paths so a successful Yjs command can never
// be followed by a failed SQL-only field in the same request.
func (s *Store) UpdateFlashcardSet(ctx context.Context, id string, p FlashcardSetPatch) (FlashcardSet, error) {
	mt, err := s.GetMaterial(ctx, id)
	if err != nil {
		return FlashcardSet{}, err
	}
	if mt.Kind != "flashcards" {
		return FlashcardSet{}, ErrNotFound
	}
	title, color := mt.Title, mt.Color
	if p.Name != nil && *p.Name != mt.Title {
		title = *p.Name
	}
	if p.Color != nil {
		color = *p.Color
	}
	materialPatch := MaterialPatch{UpdatedBy: p.UpdatedBy}
	if p.Name != nil && *p.Name != mt.Title {
		materialPatch.Title = &title
	}
	if p.Color != nil {
		materialPatch.Color = &color
	}
	if _, err := s.UpdateMaterial(ctx, id, materialPatch); err != nil {
		return FlashcardSet{}, err
	}
	return s.GetFlashcardSet(ctx, id)
}
