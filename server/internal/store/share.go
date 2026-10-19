package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

/* -------------------------------------------------------------- access checks

Sharing model: workspace privacy is inherited by everything inside it, while
standalone materials keep their own privacy.
  - owner / member → read (and write per role)
  - public         → signed-in nonmembers receive share_role
  - link           → a signed-in nonmember receives share_role only after
                     presenting the signed link once (RedeemShareToken), as
                     Google's "anyone with the link" plus resource key (Sam
                     2026-10-18); making it private clears those grants
  - private        → owner/members only (404 for everyone else)
A caller's effective role is the more permissive of their membership and the
share role. Roles are grants rather than caps: capping a member at their
invited role would not restrain anyone, since the same link hands that access
to every other signed-in account. Content authority (documents, comments,
chapters, files, materials, generation, clone) follows the effective role;
workspace settings follow persisted membership only. */

// workspaceRoles reads the actor's persisted membership and the role the
// workspace effectively grants them. The owner is owner in both. userID "" is
// tolerated and yields no role. A deleted or deletion-pending owner's workspace
// is not found for anyone, a suspended owner's for anyone but the owner (who
// keeps the locked-account answer of the session checks).
func workspaceRoles(ctx context.Context, q rowQueryer, userID, wsID string) (member, effective WorkspaceRole, err error) {
	var owner string
	var privacy Privacy
	var shareRole ShareRole
	var linkGranted bool
	err = q.QueryRow(ctx, `SELECT w.user_id, w.privacy, w.share_role, COALESCE(wm.role,''),
			EXISTS(SELECT 1 FROM workspace_link_grants g WHERE g.workspace_id=w.id AND g.user_id=$2)
		FROM workspaces w
		JOIN users owner ON owner.id=w.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE w.id=$1 AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL
			AND (owner.suspended_at IS NULL OR owner.id=$2)`, wsID, userID).Scan(&owner, &privacy, &shareRole, &member, &linkGranted)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if userID == "" {
		return "", "", nil
	}
	if owner == userID {
		member = RoleOwner
	}
	// A link workspace reaches a nonmember only through a redeemed link.
	if member == "" && privacy == PrivacyLink && !linkGranted {
		return "", "", nil
	}
	return member, EffectiveRole(member, privacy, shareRole), nil
}

// linkReachSQL is true when the signed-in user may take a shared workspace's
// share role: public, a member, or holding a redeemed link (workspaceRoles).
// ws names the workspaces row alias, user the parameter.
func linkReachSQL(ws, user string) string {
	return `(` + ws + `.privacy='public'
		OR EXISTS(SELECT 1 FROM workspace_members lm WHERE lm.workspace_id=` + ws + `.id AND lm.user_id=` + user + `)
		OR EXISTS(SELECT 1 FROM workspace_link_grants lg WHERE lg.workspace_id=` + ws + `.id AND lg.user_id=` + user + `))`
}

// EffectiveRole is a member's grant raised by what the workspace hands to
// every signed-in nonmember.
func EffectiveRole(member WorkspaceRole, privacy Privacy, shareRole ShareRole) WorkspaceRole {
	return MaxRole(member, nonmemberGrant(privacy, shareRole))
}

// WorkspaceRoles exposes both grants in one query for callers that need
// membership and effective role together.
func (s *Store) WorkspaceRoles(ctx context.Context, userID, wsID string) (member, effective WorkspaceRole, err error) {
	return workspaceRoles(ctx, s.pool, userID, wsID)
}

// WorkspaceAccess reports whether userID may read wsID. isOwner is true for
// the owner; (false, nil) means member or shared read access.
func (s *Store) WorkspaceAccess(ctx context.Context, userID, wsID string) (isOwner bool, err error) {
	if userID == "" {
		return false, ErrNotFound
	}
	member, effective, err := workspaceRoles(ctx, s.pool, userID, wsID)
	if err != nil {
		return false, err
	}
	if effective == "" {
		return false, ErrNotFound
	}
	return member == RoleOwner, nil
}

// WorkspaceRole returns only the persisted membership role ("" for a
// nonmember). Workspace settings and the member roster use it.
func (s *Store) WorkspaceRole(ctx context.Context, userID, wsID string) (WorkspaceRole, error) {
	member, _, err := workspaceRoles(ctx, s.pool, userID, wsID)
	return member, err
}

// WorkspaceEffectiveRole is the membership raised by the share role wherever
// the workspace is link/public. ErrNotFound when the caller has no access.
func (s *Store) WorkspaceEffectiveRole(ctx context.Context, userID, wsID string) (WorkspaceRole, error) {
	if userID == "" {
		return "", ErrNotFound
	}
	_, effective, err := workspaceRoles(ctx, s.pool, userID, wsID)
	if err != nil {
		return "", err
	}
	if effective == "" {
		return "", ErrNotFound
	}
	return effective, nil
}

// AssertWorkspaceEditor gates workspace content: chapters, files, materials,
// generation. Member editors and link/public share-role editors both pass.
func (s *Store) AssertWorkspaceEditor(ctx context.Context, userID, wsID string) error {
	role, err := s.WorkspaceEffectiveRole(ctx, userID, wsID)
	if err != nil {
		return err
	}
	if !RoleCanEdit(role) {
		return ErrForbidden
	}
	return nil
}

// AssertWorkspaceMemberEditor gates workspace settings (name, tags,
// sharing, stats), which stay with persisted owner/editor membership.
func (s *Store) AssertWorkspaceMemberEditor(ctx context.Context, userID, wsID string) error {
	role, err := s.WorkspaceRole(ctx, userID, wsID)
	if err != nil {
		return err
	}
	if !RoleCanEdit(role) {
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
		return 3
	case RoleEditor:
		return 2
	case RoleViewer:
		return 1
	default:
		return 0
	}
}

// nonmemberGrant is the role a link/public workspace hands to every signed-in
// nonmember; a private workspace grants nothing.
func nonmemberGrant(privacy Privacy, shareRole ShareRole) WorkspaceRole {
	if privacy == PrivacyLink || privacy == PrivacyPublic {
		return shareRole.WorkspaceRole()
	}
	return ""
}

// MaxRole returns the more permissive of two grants.
func MaxRole(a, b WorkspaceRole) WorkspaceRole {
	if roleRank(b) > roleRank(a) {
		return b
	}
	return a
}

func CapabilitiesForRole(role WorkspaceRole, canView bool) AccessCapabilities {
	return AccessCapabilities{
		CanView:          canView || role != "",
		CanEdit:          RoleCanEdit(role),
		CanEditContent:   RoleCanEdit(role),
		CanManageMembers: role == RoleOwner,
	}
}

// materialEffectiveAccess derives the caller's role on a material:
//   - standalone material's owner or workspace owner: owner
//   - workspace member: their role, raised to the share role where the
//     workspace is link/public
//   - signed-in nonmember of a link/public workspace: the share role
//   - standalone link/public material: viewer
//
// The owner's lifecycle hides it as workspaceRoles does.
func materialEffectiveAccess(
	ctx context.Context,
	q rowQueryer,
	userID, matID string,
) (WorkspaceRole, error) {
	if userID == "" {
		return "", ErrNotFound
	}
	var materialOwner, wsID, workspaceOwner, parentID *string
	var materialPrivacy Privacy
	var workspacePrivacy *Privacy
	var shareRole *ShareRole
	var memberRole WorkspaceRole
	var linkGranted bool
	err := q.QueryRow(ctx, `
		SELECT m.owner_user_id, m.privacy, m.workspace_id, w.user_id, w.privacy, w.share_role,
			COALESCE(wm.role, ''), m.parent_material_id,
			EXISTS(SELECT 1 FROM workspace_link_grants g WHERE g.workspace_id=w.id AND g.user_id=$2)
				OR EXISTS(SELECT 1 FROM material_link_grants g WHERE g.material_id=m.id AND g.user_id=$2)
		FROM materials m
		LEFT JOIN workspaces w ON w.id=m.workspace_id
		JOIN users owner ON owner.id=COALESCE(w.user_id, m.owner_user_id)
		LEFT JOIN workspace_members wm
			ON wm.workspace_id=w.id AND wm.user_id=$2
		WHERE m.id=$1 AND m.trashed_at IS NULL AND owner.deleted_at IS NULL
			AND owner.deletion_requested_at IS NULL
			AND (owner.suspended_at IS NULL OR owner.id=$2)`, matID, userID).Scan(
		&materialOwner,
		&materialPrivacy,
		&wsID,
		&workspaceOwner,
		&workspacePrivacy,
		&shareRole,
		&memberRole,
		&parentID,
		&linkGranted,
	)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	// An embedded material is reachable exactly as its note is.
	if parentID != nil {
		return materialEffectiveAccess(ctx, q, userID, *parentID)
	}
	// A workspace material's owner_user_id is its payer (uploader pays) and
	// grants nothing: access follows the workspace.
	if wsID == nil && materialOwner != nil && *materialOwner == userID {
		return RoleOwner, nil
	}
	if workspaceOwner != nil && *workspaceOwner == userID {
		return RoleOwner, nil
	}

	// A link resource reaches a nonmember only through a redeemed link.
	workspaceShared := wsID != nil && workspacePrivacy != nil &&
		(*workspacePrivacy == PrivacyPublic ||
			(*workspacePrivacy == PrivacyLink && (memberRole != "" || linkGranted)))
	materialShared := wsID == nil &&
		(materialPrivacy == PrivacyPublic || (materialPrivacy == PrivacyLink && linkGranted))
	var sharedRole WorkspaceRole
	switch {
	case workspaceShared && shareRole != nil:
		sharedRole = shareRole.WorkspaceRole()
	case workspaceShared, materialShared:
		sharedRole = RoleViewer
	}
	role := MaxRole(memberRole, sharedRole)
	if role == "" {
		return "", ErrNotFound
	}
	return role, nil
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
	if material.OwnerUserID != userID || material.WorkspaceID != "" || material.ParentMaterialID != "" ||
		(expectedKind != "" && string(material.Kind) != expectedKind) {
		return Material{}, ErrNotFound
	}
	return s.UpdateMaterial(ctx, materialID, MaterialPatch{
		Privacy: &privacy, UpdatedBy: userID,
	})
}

func (s *Store) MaterialEffectiveRole(ctx context.Context, userID, matID string) (WorkspaceRole, error) {
	return materialEffectiveAccess(ctx, s.pool, userID, matID)
}

// MaterialAccess reports whether userID may read the material.
func (s *Store) MaterialAccess(ctx context.Context, userID, matID string) (isOwner bool, err error) {
	role, err := s.MaterialEffectiveRole(ctx, userID, matID)
	if err != nil {
		return false, err
	}
	return role == RoleOwner, nil
}

// AssertMaterialEditor gates document, comment and metadata writes. A
// standalone material is editable by its owner only.
func (s *Store) AssertMaterialEditor(ctx context.Context, userID, matID string) error {
	role, err := s.MaterialEffectiveRole(ctx, userID, matID)
	if err != nil {
		return err
	}
	if !RoleCanEdit(role) {
		return ErrForbidden
	}
	return nil
}

// FileWorkspaceID resolves the owning workspace of a file (for access checks).
func (s *Store) FileWorkspaceID(ctx context.Context, fileID string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1 AND trashed_at IS NULL`, fileID).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
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

// ListPublicWorkspaces lists Explore rows with the caller's persisted
// membership on each, so the response can carry their real capabilities.
func (s *Store) ListPublicWorkspaces(ctx context.Context, userID string) ([]PublicWorkspace, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+wsCols+`, COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0), `+memberRoleCol+`
		FROM workspaces w LEFT JOIN users u ON u.id=w.user_id
		LEFT JOIN workspace_clone_counts cc ON cc.workspace_id=w.id
		LEFT JOIN workspace_members me ON me.workspace_id=w.id AND me.user_id=$1
		WHERE w.privacy='public'
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL AND u.suspended_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, w.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicWorkspace{}
	for rows.Next() {
		var w PublicWorkspace
		var member WorkspaceRole
		workspace, err := s.scanWorkspace(rows, &w.Author, &w.Clones, &member)
		if err != nil {
			return nil, err
		}
		workspace.MemberRole = member
		w.Workspace = workspace
		out = append(out, w)
	}
	return out, rows.Err()
}

// CanCloneFrom is who may copy what sits in a workspace, on roles already
// read (assertCloneSourceTx): members of any role and effective editors.
func CanCloneFrom(member, effective WorkspaceRole) bool {
	return member != "" || RoleCanEdit(effective)
}

// exploreCloneCols reads, after a materials row m joined to its workspace w
// and the caller's ($1) membership me, whether the caller may clone it: a
// standalone public item is open to every reader (exploreCanClone).
const exploreCloneCols = memberRoleCol + `, COALESCE(w.privacy,'private'), COALESCE(w.share_role,'viewer')`

func exploreCanClone(workspaceID string, member WorkspaceRole, privacy Privacy, shareRole ShareRole) bool {
	return workspaceID == "" || CanCloneFrom(member, EffectiveRole(member, privacy, shareRole))
}

// ListPublicQuizzes lists Explore quizzes with whether userID may clone each.
func (s *Store) ListPublicQuizzes(ctx context.Context, userID string) ([]PublicQuiz, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, COALESCE(m.workspace_id,''), m.workspace_name, m.kind, m.title, m.content, m.chapter_id, m.scope_chapters, m.scope_file_names, m.privacy, m.color, m.created_at, m.provenance,
			COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0), `+exploreCloneCols+`
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=COALESCE(w.user_id, m.owner_user_id)
		LEFT JOIN material_clone_counts cc ON cc.material_id=m.id
		LEFT JOIN workspace_members me ON me.workspace_id=w.id AND me.user_id=$1
		WHERE m.kind='quiz' AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
		  AND ((m.workspace_id IS NULL AND m.privacy='public') OR w.privacy='public')
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL AND u.suspended_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, m.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicQuiz{}
	for rows.Next() {
		var mt Material
		var author string
		var clones int
		var provenance []byte
		var member WorkspaceRole
		var privacy Privacy
		var shareRole ShareRole
		if err := rows.Scan(&mt.ID, &mt.WorkspaceID, &mt.WorkspaceName, &mt.Kind, &mt.Title, &mt.Content, &mt.ChapterID, &mt.ScopeChapters, &mt.ScopeFileNames, &mt.Privacy, &mt.Color, &mt.CreatedAt, &provenance, &author, &clones,
			&member, &privacy, &shareRole); err != nil {
			return nil, err
		}
		if mt.Provenance, err = decodeProvenance(provenance); err != nil {
			return nil, err
		}
		q, err := s.quizFromMaterial(mt)
		if err != nil {
			continue // skip unparseable content instead of failing the page
		}
		canClone := exploreCanClone(mt.WorkspaceID, member, privacy, shareRole)
		out = append(out, PublicQuiz{Quiz: q, Author: author, Clones: clones, CanClone: canClone})
	}
	return out, rows.Err()
}

// ListPublicFlashcardSets lists Explore flashcards with whether userID may
// clone each.
func (s *Store) ListPublicFlashcardSets(ctx context.Context, userID string) ([]PublicFlashcardSet, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+flashcardSetCols+`,
			COALESCE(u.name,'Unknown'), COALESCE(cc.clone_count,0), `+exploreCloneCols+`
		FROM materials m LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN users u ON u.id=COALESCE(w.user_id, m.owner_user_id)
		LEFT JOIN material_clone_counts cc ON cc.material_id=m.id
		LEFT JOIN workspace_members me ON me.workspace_id=w.id AND me.user_id=$1
		WHERE m.kind='flashcards' AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
		  AND ((m.workspace_id IS NULL AND m.privacy='public') OR w.privacy='public')
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL AND u.suspended_at IS NULL
		ORDER BY COALESCE(cc.clone_count,0) DESC, m.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicFlashcardSet{}
	for rows.Next() {
		var item PublicFlashcardSet
		var member WorkspaceRole
		var privacy Privacy
		var shareRole ShareRole
		set, err := scanFlashcardSetRow(rows, &item.Author, &item.Clones, &member, &privacy, &shareRole)
		if err != nil {
			return nil, err
		}
		item.FlashcardSet = set
		item.CanClone = exploreCanClone(set.WorkspaceID, member, privacy, shareRole)
		out = append(out, item)
	}
	return out, rows.Err()
}

/* -------------------------------------------------------------------- cloning */

// rewriteCardIDs re-keys every card in a flashcards document.
// flashcard_cards.card_id is a global primary key, so a cloned set mints fresh
// card ids before its lookup rows are inserted.
func rewriteCardIDs(_ string, content string) (newContent string, newIDs []string, err error) {
	return rewriteCardIDsWithMap(content, map[string]string{})
}

func rewriteCardIDsWithMap(content string, idMap map[string]string) (newContent string, newIDs []string, err error) {
	return materialdoc.RewriteFlashcardIDs(content, idMap, func() string { return uid("c") })
}

func snapshotStandaloneCloneAssets(
	ctx context.Context,
	tx pgx.Tx,
	source Material,
	embeddedIDs []string,
	contents []string,
) ([]workspaceCloneAsset, map[string]string, int64, error) {
	// contents[0] is the source's, the rest follow embeddedIDs. Each copied
	// asset belongs to the clone of the material whose content uses it, so a
	// note's save never deletes its embedded quiz's images.
	materialIDs := []string{source.ID}
	materialIDs = append(materialIDs, embeddedIDs...)
	referencedBy := map[string]string{}
	for i, content := range contents {
		ids, err := materialdoc.EditorAssetIDs(content)
		if err != nil {
			return nil, nil, 0, err
		}
		for _, id := range ids {
			if _, seen := referencedBy[id]; !seen {
				referencedBy[id] = materialIDs[i]
			}
		}
	}
	ids := make([]string, 0, len(referencedBy))
	for id := range referencedBy {
		ids = append(ids, id)
	}
	assetMap := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return nil, assetMap, 0, nil
	}
	// A standalone note's assets may hang off its embedded rows, so every
	// material whose content was scanned is an acceptable home.
	rows, err := tx.Query(ctx, `SELECT id, name, purpose, object_path, content_type,
		size_bytes, status, COALESCE(etag,''), created_at, completed_at
		FROM editor_assets
		WHERE id=ANY($1) AND status='ready' AND trashed_at IS NULL AND (
			($2 <> '' AND workspace_id=$2) OR
			($2 = '' AND material_id=ANY($3))
		)`, ids, source.WorkspaceID, materialIDs)
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
		asset.materialID = referencedBy[asset.oldID]
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
	id, name, kind, status      string
	chapterID, parser, blobPath *string
	sourceETag                  *string
	contentHash, sourceSHA256   *string
	sizeBytes                   int64
	position                    int64
	indexed, everParsed         bool
	parseMode                   string
	indexLimit                  *string
	provenance                  []byte
	thumbnailKey                *string
	preview                     []byte
	revision                    int64
	// The saved edit state (source_documents), when the file has one: its
	// base blob is locked like the published one and its bytes are charged.
	sourceBasePath *string
	sourceBytes    int64
}

// snapshotCloneFilesTx reads the files a clone copies, filtered by where
// ($1): ready files, and partial ones (failed with a served index, a part
// missing), which copy as partial so the copy's owner can retry them (parts
// design Q2). indexed counts only an index that is ready.
func snapshotCloneFilesTx(ctx context.Context, tx pgx.Tx, where string, arg any) ([]workspaceCloneFile, error) {
	rows, err := tx.Query(ctx,
		`SELECT f.id, f.chapter_id, f.position, f.name, f.kind, f.size_bytes, f.status,
			i.served, f.parser, f.blob_path, f.source_etag,
			f.content_hash, f.source_sha256, f.parse_mode, f.ever_parsed_successfully,
			f.index_limit, f.provenance, f.thumbnail_key, f.preview, f.revision,
			d.base_blob_path, COALESCE(d.storage_bytes, 0)
		 FROM files f LEFT JOIN source_documents d ON d.file_id=f.id
		 CROSS JOIN LATERAL (SELECT f.indexed AND EXISTS (
				SELECT 1 FROM rag_file_contents fc
				JOIN rag_contents rc ON rc.id=fc.content_id
				WHERE fc.file_id=f.id AND rc.status='ready'
			) AS served) i
		 WHERE (f.status='ready' OR (f.status='failed' AND i.served)) AND f.trashed_at IS NULL AND `+where,
		arg,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []workspaceCloneFile
	for rows.Next() {
		var file workspaceCloneFile
		if err := rows.Scan(
			&file.id, &file.chapterID, &file.position, &file.name, &file.kind,
			&file.sizeBytes, &file.status, &file.indexed, &file.parser,
			&file.blobPath, &file.sourceETag, &file.contentHash, &file.sourceSHA256,
			&file.parseMode, &file.everParsed, &file.indexLimit, &file.provenance,
			&file.thumbnailKey, &file.preview, &file.revision,
			&file.sourceBasePath, &file.sourceBytes,
		); err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	return files, rows.Err()
}

// insertCloneFileTx copies one snapshot file into workspaceID as newID: its
// published bytes, published captions and saved edit state, which reopens at
// epoch 1 on the same base (job, refresh and notice columns start empty; the
// reprocess mark travels, so a copy of bytes an export-only publication left
// unindexed is indexed like its source). Its thumbnail is copied under the new
// id once the transaction commits.
func insertCloneFileTx(
	ctx context.Context,
	tx pgx.Tx,
	f workspaceCloneFile,
	newID, workspaceID, actorID string,
	chapterID *string,
	name string,
	position int64,
) (*ThumbnailCopy, error) {
	// The cloner pays and is credited (uploader pays).
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, position, name, kind, size_bytes, added_at, status, indexed, parser, blob_path,
		 source_etag, content_hash, source_sha256, parse_mode, ever_parsed_successfully, index_limit, provenance, preview, revision)
		VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
		newID, workspaceID, actorID, chapterID, position, name, f.kind, f.sizeBytes, f.status, f.indexed, f.parser, f.blobPath,
		f.sourceETag, f.contentHash, f.sourceSHA256, f.parseMode, f.everParsed, f.indexLimit, f.provenance, f.preview, f.revision); err != nil {
		return nil, err
	}
	// Saved edits travel (Epo 2026-10-11): the base state, the rows saved over
	// it in the source's current epoch (migration 0075) renumbered to epoch 1,
	// and the log totals they make up, which storage_bytes charges. One
	// statement reads them all, so a save in between cannot split them.
	// base_revision equals the copied files.revision, as CheckSourceAccess
	// requires.
	if f.sourceBasePath != nil {
		if _, err := tx.Exec(ctx, `WITH src AS (
				SELECT * FROM source_documents WHERE file_id=$1
			), doc AS (
				INSERT INTO source_documents
				(user_id, file_id, format, epoch, checkpoint, indexed_checkpoint, base_revision, base_blob_path,
				 base_source_sha256, state, pending_effects, net_tokens, last_edited_at, last_refresh_requested_at,
				 seed_bytes, state_seed_sha256, rebuild_pending, published_state, published_state_seed_sha256, rebuild_refusal,
				 reprocess_at, log_bytes, log_rows)
				SELECT $3, $2, format, 1, checkpoint, indexed_checkpoint, $4, base_blob_path,
				 base_source_sha256, state, pending_effects, net_tokens, last_edited_at, last_refresh_requested_at,
				 seed_bytes, state_seed_sha256, rebuild_pending, published_state, published_state_seed_sha256, rebuild_refusal,
				 reprocess_at, log_bytes, log_rows
				FROM src
			)
			INSERT INTO source_document_updates (file_id, epoch, checkpoint, update)
			SELECT $2, 1, u.checkpoint, u.update
			FROM source_document_updates u JOIN src ON u.file_id = src.file_id AND u.epoch = src.epoch`,
			f.id, newID, actorID, f.revision); err != nil {
			return nil, err
		}
	}
	if err := cloneImageCaptionAssociations(ctx, tx, f.id, newID); err != nil {
		return nil, err
	}
	// A key's path names a file of the row's own workspace, so the clone gets
	// a copy under its own file id.
	if f.thumbnailKey == nil {
		return nil, nil
	}
	return &ThumbnailCopy{
		FileID: newID, From: *f.thumbnailKey,
		To: "thumbs/" + newID + "/" + path.Base(*f.thumbnailKey),
	}, nil
}

type workspaceCloneAsset struct {
	oldID, newID                           string
	materialID                             string // the source material that uses it
	name, purpose, objectPath, contentType string
	status                                 string
	sizeBytes                              int64
	etag                                   string
	createdAt                              time.Time
	completedAt                            *time.Time
}

type workspaceCloneMaterial struct {
	material  Material
	newID     string
	content   string
	metrics   materialdoc.DocumentMetrics
	preview   json.RawMessage
	sizeBytes int64
	cardIDs   []string
	// The copy indexes to the same text, so it may share the source's index.
	indexKept bool
}

// sameIndexText reports whether a note's copy indexes to the source's text,
// so the copy can take the source's index instead of being indexed again.
// Each side's items are its embedded rows' contents by id: their text is
// part of the note's.
func sameIndexText(before string, beforeItems map[string]string, after string, afterItems map[string]string) (bool, error) {
	a, err := materialdoc.ExtractIndexText(before, beforeItems)
	if err != nil {
		return false, err
	}
	b, err := materialdoc.ExtractIndexText(after, afterItems)
	return a == b, err
}

// cloneMentions applies the mention rule (Epo 2026-10-11): a mention of a
// user outside the copy's destination becomes plain "@Name" text.
func cloneMentions(content string, members map[string]bool) (string, error) {
	return materialdoc.PlainMentions(content, func(userID string) bool { return members[userID] })
}

type workspaceCloneSnapshot struct {
	chapters    []workspaceCloneChapter
	files       []workspaceCloneFile
	assets      []workspaceCloneAsset
	materials   []workspaceCloneMaterial
	materialIDs map[string]string
	bytes       int64
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
		return ErrCloneSourceChanged
	}
	return nil
}

// cloneFileBlobPaths lists the paths copies of files will reference.
// Thumbnail keys are not among them: a clone copies those objects after it
// commits.
func cloneFileBlobPaths(files []workspaceCloneFile) []string {
	paths := make([]string, 0, len(files))
	for _, file := range files {
		if file.blobPath != nil {
			paths = append(paths, *file.blobPath)
		}
		if file.sourceBasePath != nil {
			paths = append(paths, *file.sourceBasePath)
		}
	}
	return paths
}

func workspaceCloneBlobPaths(snapshot workspaceCloneSnapshot) []string {
	paths := cloneFileBlobPaths(snapshot.files)
	for _, asset := range snapshot.assets {
		paths = append(paths, asset.objectPath)
	}
	return paths
}

// snapshotWorkspaceForClone reads and rewrites everything a workspace clone
// copies. The new workspace has only actorID, so other mentions turn plain.
func (s *Store) snapshotWorkspaceForClone(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, actorID string,
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

	// A trashed material is not cloned, so neither are its assets.
	rows, err = tx.Query(ctx,
		`SELECT id, COALESCE(material_id,''), name, purpose, object_path, content_type, size_bytes,
			status, COALESCE(etag,''), created_at, completed_at
		 FROM editor_assets a
		 WHERE workspace_id=$1 AND status='ready' AND trashed_at IS NULL AND (material_id IS NULL OR EXISTS (
			SELECT 1 FROM materials m WHERE m.id=a.material_id AND m.trashed_at IS NULL))
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
			&asset.materialID,
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

	if snapshot.files, err = snapshotCloneFilesTx(ctx, tx,
		`f.workspace_id=$1 ORDER BY f.added_at`, workspaceID); err != nil {
		return workspaceCloneSnapshot{}, err
	}
	for _, file := range snapshot.files {
		snapshot.bytes += file.sizeBytes + file.sourceBytes
	}

	assetIDs := make(map[string]string, len(snapshot.assets))
	for _, asset := range snapshot.assets {
		assetIDs[asset.oldID] = asset.newID
	}
	rows, err = tx.Query(ctx,
		`SELECT `+materialCols+`
		 FROM materials WHERE workspace_id=$1 AND trashed_at IS NULL ORDER BY created_at`,
		workspaceID,
	)
	if err != nil {
		return workspaceCloneSnapshot{}, err
	}
	// Ids are minted up front so a note's references can point at the clones
	// of its embedded rows before either is inserted.
	materialIDs := map[string]string{}
	for rows.Next() {
		material, err := scanMaterial(rows)
		if err != nil {
			rows.Close()
			return workspaceCloneSnapshot{}, err
		}
		materialIDs[material.ID] = uid("mat")
		snapshot.materials = append(snapshot.materials, workspaceCloneMaterial{
			material: material,
			newID:    materialIDs[material.ID],
			content:  material.Content,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return workspaceCloneSnapshot{}, err
	}
	rows.Close()
	snapshot.materialIDs = materialIDs

	for i := range snapshot.materials {
		materialSnapshot := &snapshot.materials[i]
		cardIDMap := map[string]string{}
		if materialSnapshot.material.Kind == "flashcards" {
			materialSnapshot.content, materialSnapshot.cardIDs, err = rewriteCardIDsWithMap(
				materialSnapshot.content, cardIDMap,
			)
			if err != nil {
				return workspaceCloneSnapshot{}, err
			}
		}
		if materialSnapshot.material.Kind == "note" {
			materialSnapshot.content, err = materialdoc.RewriteMaterialRefIDs(
				materialSnapshot.content, materialIDs,
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
		if materialSnapshot.content, err = cloneMentions(
			materialSnapshot.content, map[string]bool{actorID: true},
		); err != nil {
			return workspaceCloneSnapshot{}, err
		}
		materialSnapshot.metrics, err = materialdoc.Metrics(materialSnapshot.content)
		if err != nil {
			return workspaceCloneSnapshot{}, err
		}
		if err := materialSnapshot.metrics.LimitError(); err != nil {
			return workspaceCloneSnapshot{}, err
		}
		// Recomputed: the clone may have dropped media the source showed.
		materialSnapshot.preview, err = materialdoc.Preview(
			string(materialSnapshot.material.Kind), materialSnapshot.content,
		)
		if err != nil {
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
	// Compared once every embedded row's copy is rewritten.
	sourceItems, copyItems := map[string]string{}, map[string]string{}
	for _, m := range snapshot.materials {
		if m.material.ParentMaterialID != "" {
			sourceItems[m.material.ID], copyItems[m.newID] = m.material.Content, m.content
		}
	}
	for i := range snapshot.materials {
		m := &snapshot.materials[i]
		if m.material.Kind == "note" {
			if m.indexKept, err = sameIndexText(m.material.Content, sourceItems, m.content, copyItems); err != nil {
				return workspaceCloneSnapshot{}, err
			}
		}
	}

	return snapshot, nil
}

// CloneWorkspace deep-copies a shared workspace (chapters, files, materials,
// fresh card stats, retrieval index) into a new workspace owned by userID. Blob
// objects are shared rather than duplicated: the clone copies blob_path and
// editor asset object paths, and locks their refcount rows through commit. The
// object survives until its last holder is gone, so deleting either workspace no
// longer leaks or destroys the other's bytes. The clone lands private regardless
// of the source's visibility. The copy takes its name, description, icon, tags
// and cover from input, which the clone dialog prefills from the source.
func (s *Store) CloneWorkspace(ctx context.Context, userID, srcID string, input WorkspaceCreate) (Workspace, error) {
	workspace, _, err := s.CloneWorkspaceThumbnails(ctx, userID, srcID, input)
	return workspace, err
}

// ThumbnailCopy is a thumbnail a clone copies under its own file id once it
// has committed (openwiki/thumbnails.md): a key's path may only name a file of
// the same workspace, since sharing the source key would show the source
// file's id, and so its workspace, to the clone's readers (the owner's own
// clone too: a link workspace cloned into a public one).
type ThumbnailCopy struct {
	FileID string // the clone's file
	From   string // the source file's key
	To     string // thumbs/{FileID}/{same hash}.webp
}

// CloneWorkspaceThumbnails is CloneWorkspace, also returning the thumbnails
// the caller copies after the commit.
func (s *Store) CloneWorkspaceThumbnails(ctx context.Context, userID, srcID string, input WorkspaceCreate) (Workspace, []ThumbnailCopy, error) {
	if input.IconID != nil && !ValidIconID(*input.IconID) {
		return Workspace{}, nil, ErrNotFound
	}
	payer := clonePayerLock(userID)
	var newID string
	var copies []ThumbnailCopy
	err := func() error {
		// A workspace snapshot owns the hierarchy fence so contained material
		// deletion cannot race its counter and blob-reference copy.
		conn, unlock, err := s.lockCloneSources(ctx, []cloneSourceLock{{
			key: cloneSourceLockKey("workspace", srcID),
		}, payer})
		if err != nil {
			return err
		}
		defer unlock()
		if err := retryClone(ctx, func() (err error) {
			newID, copies, err = s.cloneWorkspaceOnce(ctx, conn, userID, srcID, input)
			return err
		}); err != nil {
			return err
		}
		bumpCloneCount(context.WithoutCancel(ctx), conn, `INSERT INTO workspace_clone_counts (workspace_id, clone_count)
			VALUES ($1,1) ON CONFLICT (workspace_id) DO UPDATE
			SET clone_count=workspace_clone_counts.clone_count+1`, srcID)
		return nil
	}()
	if err != nil {
		return Workspace{}, nil, err
	}
	// Read with the fence's connection back in the pool (as below for files
	// and materials): holding it across a second acquire lets a few
	// concurrent clones take every connection and stall the API.
	workspace, err := s.GetWorkspace(ctx, userID, newID, false)
	return workspace, copies, err
}

// SetCloneThumbnail points a cloned file at its copied thumbnail. A file that
// is gone, trashed or already captured takes nothing, and the copy is queued
// for deletion at once.
func (s *Store) SetCloneThumbnail(ctx context.Context, fileID, key string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE files SET thumbnail_key=$2
		WHERE id=$1 AND thumbnail_key IS NULL AND trashed_at IS NULL`, fileID, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if err := s.EnqueueBlobDeletionTx(ctx, tx, 0, key); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type cloneTxStarter interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

// cloneAttempts bounds a clone transaction that fails on a serialization
// error (40001, 40P01). Clones queue behind each other on their fences, so
// this is a backstop; once spent, the user hears the source changed and can
// clone again.
const cloneAttempts = 3

// cloneRetried sees each serialization failure a clone runs again after
// (tests count them).
var cloneRetried = func(error) {}

// retryClone runs one clone transaction, again after a serialization error,
// at most cloneAttempts times in all.
func retryClone(ctx context.Context, once func() error) error {
	for attempt := 0; ; attempt++ {
		err := once()
		if !isRetryableTransactionError(err) {
			return err
		}
		if attempt+1 == cloneAttempts {
			return fmt.Errorf("%w: %w", ErrCloneSourceChanged, err)
		}
		cloneRetried(err)
		if err := waitCloneRetry(ctx, attempt); err != nil {
			return err
		}
	}
}

// bumpCloneCount counts a committed clone on its source in its own statement,
// still under the clone fence, so a source deletion's counter cleanup runs
// after it. Outside the copy's transaction the counter cannot make a clone
// fail. A crash or error between the copy's commit and this loses one count,
// which is acceptable for a counter; the error is logged and the copy stands.
func bumpCloneCount(ctx context.Context, starter cloneTxStarter, query, sourceID string) {
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{})
	if err == nil {
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, query, sourceID); err == nil {
			err = tx.Commit(ctx)
		}
	}
	if err != nil {
		obs.Log(ctx).Warn("clone count not bumped", "source_id", sourceID, "error", err)
	}
}

// clonePayerLock queues the clones one account pays for behind each other, so
// they never collide on its storage counter. The cloner pays for every copy
// (Sam 2026-10-18).
func clonePayerLock(actorID string) cloneSourceLock {
	return cloneSourceLock{key: "clone-payer:" + actorID}
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
	input WorkspaceCreate,
) (string, []ThumbnailCopy, error) {
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return "", nil, err
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
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	if err := lockCloneAccountsTx(ctx, tx, src.OwnerUserID, userID); err != nil {
		return "", nil, HideOtherAccountLock(err, userID)
	}
	if err := assertCloneSourceTx(ctx, tx, userID, srcID); err != nil {
		return "", nil, err
	}
	limits, err := s.gateOwnedWorkspacesTx(ctx, tx, userID, 1)
	if err != nil {
		return "", nil, err
	}
	// The target account lock above freezes both its current plan and its
	// history-retention limit before we select any source revisions. Otherwise a
	// concurrent downgrade could prune old history and the clone could restore
	// the larger pre-downgrade snapshot afterward.
	snapshot, err := s.snapshotWorkspaceForClone(ctx, tx, srcID, userID)
	if err != nil {
		return "", nil, err
	}
	// Physical paths are shared, so keep the refcount rows locked until the clone
	// references commit. A concurrent last-reference delete then happens either
	// before this repeatable-read snapshot or after the clone is durable.
	if err := lockCloneBlobPathsTx(ctx, tx, workspaceCloneBlobPaths(snapshot)); err != nil {
		return "", nil, err
	}
	if len(snapshot.files) > limits.FilesPerWorkspace {
		return "", nil, &FileLimitExceededError{
			WorkspaceID: srcID,
			Used:        0,
			Requested:   len(snapshot.files),
			Limit:       limits.FilesPerWorkspace,
			Kind:        "workspace",
		}
	}
	// The cloner's plan caps each file as it caps an upload (Epo 2026-10-12).
	for _, file := range snapshot.files {
		if file.sizeBytes > limits.SourceFileBytes {
			return "", nil, &FileTooLargeError{LimitBytes: limits.SourceFileBytes}
		}
	}
	if err := s.gateStorageTx(ctx, tx, userID, snapshot.bytes); err != nil {
		return "", nil, err
	}

	newID := uid("ws")
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
		return "", nil, err
	}
	if err := s.insertWorkspaceTx(ctx, tx, newID, userID, input.Name, input.Tags, srcEmbed); err != nil {
		return "", nil, err
	}
	if err := setWorkspaceAppearanceTx(ctx, tx, newID, input); err != nil {
		return "", nil, err
	}

	// Chapters (old id -> new id).
	chapterMap := map[string]string{}
	{
		for _, c := range snapshot.chapters {
			nid := uid("ch")
			chapterMap[c.id] = nid
			if _, err := tx.Exec(ctx, `INSERT INTO chapters (id, workspace_id, name, position) VALUES ($1,$2,$3,$4)`,
				nid, newID, c.name, c.position); err != nil {
				return "", nil, err
			}
		}
	}

	// Files. Parse-zip and caption object keys are owned by artifact_cache and
	// are not copied.
	fileMap := map[string]string{}
	var thumbnailCopies []ThumbnailCopy
	for _, f := range snapshot.files {
		nid := uid("f")
		fileMap[f.id] = nid
		var chapterID *string
		if f.chapterID != nil {
			if mapped, ok := chapterMap[*f.chapterID]; ok {
				chapterID = &mapped
			}
		}
		thumbnail, err := insertCloneFileTx(ctx, tx, f, nid, newID, userID, chapterID, f.name, f.position)
		if err != nil {
			return "", nil, err
		}
		if thumbnail != nil {
			thumbnailCopies = append(thumbnailCopies, *thumbnail)
		}
	}

	// Materials (clone lands private; retained history shares the same fresh
	// asset/card ID maps as current content, while comments are not copied).
	{
		// Parents first: an embedded row references its note through a FK.
		ordered := make([]workspaceCloneMaterial, 0, len(snapshot.materials))
		for _, materialSnapshot := range snapshot.materials {
			if materialSnapshot.material.ParentMaterialID == "" {
				ordered = append(ordered, materialSnapshot)
			}
		}
		for _, materialSnapshot := range snapshot.materials {
			if materialSnapshot.material.ParentMaterialID != "" {
				ordered = append(ordered, materialSnapshot)
			}
		}
		for _, materialSnapshot := range ordered {
			mt := materialSnapshot.material
			nid := materialSnapshot.newID
			var parentID *string
			title := mt.Title
			if mt.ParentMaterialID != "" {
				title = embeddedName()
				for _, candidate := range snapshot.materials {
					if candidate.material.ID == mt.ParentMaterialID {
						parentID = &candidate.newID
					}
				}
			}
			var chapterID *string
			if mt.ChapterID != nil {
				if mapped, ok := chapterMap[*mt.ChapterID]; ok {
					chapterID = &mapped
				}
			}
			content := materialSnapshot.content
			metrics := materialSnapshot.metrics
			createdAt := time.Now().UTC()
			// The attribution footer travels with the copy: dropping it would
			// strip the source books' licence credit.
			var provenance []byte
			if mt.Provenance != nil {
				provenance, err = json.Marshal(mt.Provenance)
				if err != nil {
					return "", nil, err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO materials
				(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
					 chapter_id, position, scope_chapters, scope_file_names, privacy, color, node_count, max_depth, updated_at, revision, updated_by, provenance,
					 parent_material_id, preview)
				VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private',$12,$13,$14,$15,$16,$2,$17,$18,$19)`,
				nid, userID, newID, input.Name, mt.Kind, title, json.RawMessage(content), chapterID,
				mt.Position, mt.ScopeChapters, mt.ScopeFileNames, mt.Color, metrics.NodeCount,
				metrics.MaxDepth, createdAt, mt.Revision, provenance, parentID, materialSnapshot.preview); err != nil {
				return "", nil, err
			}
			for _, cid := range materialSnapshot.cardIDs {
				if _, err := tx.Exec(ctx, `INSERT INTO flashcard_cards (card_id, material_id) VALUES ($1,$2)`,
					cid, nid); err != nil {
					return "", nil, err
				}
			}
		}
	}

	// Ready editor assets are logical resources too. Their blob paths remain
	// shared, but each clone receives a new asset row and therefore its own
	// quota charge, and each names the clone of its material. Material content
	// was rewritten to these IDs in the snapshot phase.
	for _, asset := range snapshot.assets {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, created_at, completed_at)
			VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12)`,
			asset.newID, newID, nullStr(snapshot.materialIDs[asset.materialID]), userID, asset.name, asset.purpose,
			asset.objectPath, asset.contentType, asset.sizeBytes, asset.etag,
			asset.createdAt, asset.completedAt); err != nil {
			return "", nil, err
		}
	}

	// The index follows files and notes; a note the source had not indexed yet,
	// or whose copy reads differently (mentions turned plain), starts dirty so
	// the scheduler builds its index in the clone.
	indexedMaterials := map[string]string{}
	for _, materialSnapshot := range snapshot.materials {
		if materialSnapshot.indexKept {
			indexedMaterials[materialSnapshot.material.ID] = materialSnapshot.newID
		}
	}
	if _, err := cloneRetrievalIndex(ctx, tx, srcID, newID, fileMap, indexedMaterials); err != nil {
		return "", nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE materials m SET index_dirty_at=now()
		WHERE m.workspace_id=$1 AND m.kind='note'
		  AND NOT EXISTS (SELECT 1 FROM rag_material_contents mc WHERE mc.material_id=m.id)`, newID); err != nil {
		return "", nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return newID, thumbnailCopies, nil
}

// cloneRetrievalIndex gives copied files and notes the source's ready index,
// inside the same transaction as the content it describes. Content the target
// workspace already holds (always, for a copy into the source's own
// workspace) is shared, as duplicate files share one index; other content is
// copied, chunks, vectors and summaries, when both workspaces embed in the
// same space: pure SQL where re-ingesting would mean paying for the parse and
// the embeddings again. It returns the copies that got an index; the caller
// handles the rest (a target held content still processing, or another pin).
//
// The source pin names the vector table on both sides of the copy. An empty
// workspace has no vectors, so the table is resolved only once there is
// content; a fixture pin that is not in the allowlist can still clone.
func cloneRetrievalIndex(ctx context.Context, tx pgx.Tx, srcID, dstID string, fileMap, materialMap map[string]string) (map[string]bool, error) {
	indexed := map[string]bool{}
	oldFiles, newFiles := unzipIDs(fileMap)
	oldMaterials, newMaterials := unzipIDs(materialMap)
	// A note's index travels only while it is current: an edit since it was
	// built (dirty), a job rebuilding it or a failed one leave it behind the
	// note's text, so its copy is indexed afresh instead.
	if len(oldMaterials) > 0 {
		current := map[string]string{}
		rows, err := tx.Query(ctx, `SELECT id FROM materials WHERE id = ANY($1::text[])
			AND index_dirty_at IS NULL AND index_job_id IS NULL AND index_error IS NULL`, oldMaterials)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			current[id] = materialMap[id]
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		oldMaterials, newMaterials = unzipIDs(current)
	}
	if len(oldFiles) == 0 && len(oldMaterials) == 0 {
		return indexed, nil
	}
	var pin models.Pin
	var samePin bool
	if err := tx.QueryRow(ctx, `SELECT a.embedding_provider_slug, a.embedding_model_slug, a.embedding_model_version,
			(a.embedding_provider_slug, a.embedding_model_slug, a.embedding_model_version, a.embedding_dim)
			IS NOT DISTINCT FROM (b.embedding_provider_slug, b.embedding_model_slug, b.embedding_model_version, b.embedding_dim)
		FROM workspaces a, workspaces b WHERE a.id=$1 AND b.id=$2`, srcID, dstID).
		Scan(&pin.ProviderSlug, &pin.ModelSlug, &pin.Version, &samePin); err != nil {
		return nil, err
	}
	// Files and notes alias canonical content rows (old id -> the target's).
	contentMap := map[string]string{}
	copies := map[string]string{}
	rows, err := tx.Query(ctx, `
		SELECT rc.id, dst.id, dst.status FROM rag_contents rc
		LEFT JOIN rag_contents dst ON dst.workspace_id=$4 AND dst.content_hash=rc.content_hash
		WHERE rc.workspace_id=$3 AND rc.status='ready' AND (
			rc.id IN (SELECT content_id FROM rag_file_contents WHERE file_id = ANY($1::text[]))
			OR rc.id IN (SELECT content_id FROM rag_material_contents WHERE material_id = ANY($2::text[])))`,
		oldFiles, oldMaterials, srcID, dstID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var oldContentID string
		var held, heldStatus *string
		if err := rows.Scan(&oldContentID, &held, &heldStatus); err != nil {
			rows.Close()
			return nil, err
		}
		switch {
		case held != nil && *heldStatus == "ready":
			contentMap[oldContentID] = *held
		case held == nil && samePin:
			contentMap[oldContentID] = uid("rgc")
			copies[oldContentID] = contentMap[oldContentID]
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(contentMap) == 0 {
		return indexed, nil
	}
	if err := copyRetrievalContents(ctx, tx, dstID, pin, copies); err != nil {
		return nil, err
	}
	oldContents, newContents := unzipIDs(contentMap)
	for _, alias := range []struct {
		table, holder string
		old, fresh    []string
	}{
		{"rag_file_contents", "file_id", oldFiles, newFiles},
		{"rag_material_contents", "material_id", oldMaterials, newMaterials},
	} {
		if len(alias.old) == 0 {
			continue
		}
		rows, err := tx.Query(ctx, `
			WITH hmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[])),
			     cmap(old_id, new_id) AS (SELECT * FROM unnest($3::text[], $4::text[]))
			INSERT INTO `+alias.table+` (`+alias.holder+`, workspace_id, content_id)
			SELECT h.new_id, $5, c.new_id
			FROM `+alias.table+` src
			JOIN hmap h ON h.old_id = src.`+alias.holder+`
			JOIN cmap c ON c.old_id = src.content_id
			RETURNING `+alias.holder,
			alias.old, alias.fresh, oldContents, newContents, dstID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			indexed[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return indexed, nil
}

// copyRetrievalContents copies ready content rows (old id -> new id) with
// their chunks, vectors and summaries into dstID.
func copyRetrievalContents(ctx context.Context, tx pgx.Tx, dstID string, pin models.Pin, copies map[string]string) error {
	if len(copies) == 0 {
		return nil
	}
	oldContents, newContents := unzipIDs(copies)
	vectors, err := vectorTable(pin)
	if err != nil {
		return err
	}
	// rag_contents is unique per workspace and content hash: an ingest that
	// added this content to the target after the snapshot conflicts here. That
	// is a serialization failure (PostgreSQL reports it as one under
	// serializable), so the clone retries on a snapshot that holds the content.
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
		oldContents, newContents, dstID); isUniqueViolation(err) {
		return &pgconn.PgError{Code: "40001", Message: "clone index raced an ingest of the same content"}
	} else if err != nil {
		return err
	}
	// Dest chunk ids are derived from the new content id + donor chunk id so
	// the vector copy can recompute them and pair each embedding with its
	// passage; the content id is fresh, so they are unique however often one
	// source is copied. (copy_content_from_donor in
	// pipeline/pipeline/retrieval/store.py salts with the dest workspace, which
	// holds one content row per content hash.)
	const newChunkID = `'rc_' || substr(md5(m.new_id || c.id), 1, 12)`
	if _, err := tx.Exec(ctx, `
	WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
	INSERT INTO rag_chunks
		(id, workspace_id, content_id, chunk_idx, section_path, text, indexed_text,
		 token_count, page_start, page_end, regions, lang, search,
		 confidence, confidence_reasons)
	SELECT `+newChunkID+`,
	       $3, m.new_id, c.chunk_idx, c.section_path, c.text, c.indexed_text,
	       c.token_count, c.page_start, c.page_end, c.regions, c.lang, c.search,
	       c.confidence, c.confidence_reasons
	FROM rag_chunks c JOIN cmap m ON m.old_id = c.content_id`,
		oldContents, newContents, dstID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
	WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
	INSERT INTO `+vectors+` (chunk_id, workspace_id, embedding)
	SELECT `+newChunkID+`, $3, v.embedding
	FROM rag_chunks c
	JOIN cmap m ON m.old_id = c.content_id
	JOIN `+vectors+` v ON v.chunk_id = c.id`,
		oldContents, newContents, dstID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
	WITH cmap(old_id, new_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
	INSERT INTO rag_content_summaries
		(content_id, workspace_id, fingerprint, descriptor, change_share, updated_at)
	SELECT c.new_id, $3, s.fingerprint, s.descriptor, s.change_share, s.updated_at
	FROM rag_content_summaries s JOIN cmap c ON c.old_id = s.content_id`,
		oldContents, newContents, dstID)
	return err
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

// CloneTarget is where a single file or material copy lands and what it is
// called: a workspace the actor edits, optionally filed in one of its
// chapters (ChapterID) or a chapter by name created when missing
// (ChapterName), or no workspace for a standalone material.
type CloneTarget struct {
	WorkspaceID string
	ChapterID   *string
	ChapterName string
	Name        string
}

// cloneDestination is a CloneTarget admitted inside the clone's transaction.
type cloneDestination struct {
	workspaceID, workspaceName string
	payerID                    string // the copy's bytes are charged here
	chapterID                  *string
	members                    map[string]bool // mentions that stay live
}

// lockCloneTargetTx admits a copy's destination in the order every workspace
// write takes, workspace row then accounts: the actor must be the target
// workspace's editor (a frozen owner or actor is refused). The actor pays
// (Sam 2026-10-18). The source owner's account is locked with them.
func (s *Store) lockCloneTargetTx(
	ctx context.Context,
	tx pgx.Tx,
	sourceOwnerID, actorID string,
	target CloneTarget,
) (cloneDestination, error) {
	if target.WorkspaceID == "" {
		return cloneDestination{payerID: actorID}, lockCloneAccountsTx(ctx, tx, sourceOwnerID, actorID)
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, target.WorkspaceID)
	if err != nil {
		return cloneDestination{}, err
	}
	if err := lockCloneAccountsTx(ctx, tx, sourceOwnerID, actorID, ownerID); err != nil {
		return cloneDestination{}, HideOtherAccountLock(err, actorID)
	}
	// The rows are already held; this adds the editor and frozen checks.
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, target.WorkspaceID, actorID); err != nil {
		return cloneDestination{}, err
	}
	dest := cloneDestination{workspaceID: target.WorkspaceID, payerID: actorID, members: map[string]bool{ownerID: true}}
	if dest.chapterID, err = resolveUploadChapterID(ctx, tx, target.WorkspaceID, target.ChapterID, target.ChapterName); err != nil {
		return cloneDestination{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT name FROM workspaces WHERE id=$1`, target.WorkspaceID).
		Scan(&dest.workspaceName); err != nil {
		return cloneDestination{}, err
	}
	// The editor check above read membership from the snapshot, which may
	// predate the workspace lock: locking the rows raises a serialization
	// failure (and a retry) when a removal or role change committed since.
	rows, err := tx.Query(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 FOR SHARE`, target.WorkspaceID)
	if err != nil {
		return cloneDestination{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var member string
		if err := rows.Scan(&member); err != nil {
			return cloneDestination{}, err
		}
		dest.members[member] = true
	}
	return dest, rows.Err()
}

// assertCloneSourceTx is who may copy what sits in a workspace (Epo
// 2026-10-11): members of any role and effective editors, the workspace
// clone's rule. A link or public viewer reads it but does not copy it.
func assertCloneSourceTx(ctx context.Context, tx pgx.Tx, userID, workspaceID string) error {
	member, effective, err := workspaceRoles(ctx, tx, userID, workspaceID)
	if err != nil {
		return err
	}
	if effective == "" {
		return ErrNotFound
	}
	if !CanCloneFrom(member, effective) {
		return ErrForbidden
	}
	return nil
}

// HideOtherAccountLock maps another account's lifecycle lock (deleted,
// deletion-pending or suspended) to not found: a locked owner's workspaces
// and content are gone for everyone else, and a locked payer's state and
// suspension reason are none of a co-editor's business (review C2). The
// actor's own lock, and a frozen payer (whose items read as view-only), pass.
func HideOtherAccountLock(err error, actorID string) error {
	var locked *AccountLockedError
	if errors.As(err, &locked) && locked.UserID != actorID && locked.State != AccountOverQuotaFrozen {
		return ErrNotFound
	}
	return err
}

// CloneFile copies one ready or partial file into a workspace the actor
// edits (files live in workspaces only): its published bytes (blob shared,
// reference counted), saved edit state, captions, provenance and index, plus
// the thumbnail the caller copies after the commit. The cloner pays.
func (s *Store) CloneFile(ctx context.Context, userID, fileID string, target CloneTarget) (File, []ThumbnailCopy, error) {
	payer := clonePayerLock(userID)
	var newID string
	var copies []ThumbnailCopy
	err := func() error {
		// Copies of one file queue on its fence, so they never collide on its
		// blob references.
		conn, unlock, err := s.lockContainedCloneSource(ctx, "file", fileID, false, payer)
		if err != nil {
			return err
		}
		defer unlock()
		return retryClone(ctx, func() (err error) {
			newID, copies, err = s.cloneFileOnce(ctx, conn, userID, fileID, target)
			return err
		})
	}()
	if err != nil {
		return File{}, nil, err
	}
	file, err := s.GetFile(ctx, newID)
	return file, copies, err
}

func (s *Store) cloneFileOnce(ctx context.Context, starter cloneTxStarter, userID, fileID string, target CloneTarget) (string, []ThumbnailCopy, error) {
	// Repeatable read: one consistent snapshot of the file, its saved state
	// and its index, without waiting on collaboration.
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback(ctx)
	var sourceWorkspaceID, sourceOwnerID string
	if err := tx.QueryRow(ctx, `SELECT f.workspace_id, w.user_id FROM files f
		JOIN workspaces w ON w.id=f.workspace_id
		WHERE f.id=$1 AND f.trashed_at IS NULL`, fileID).
		Scan(&sourceWorkspaceID, &sourceOwnerID); isNoRows(err) {
		return "", nil, ErrNotFound
	} else if err != nil {
		return "", nil, err
	}
	if err := assertCloneSourceTx(ctx, tx, userID, sourceWorkspaceID); err != nil {
		return "", nil, err
	}
	dest, err := s.lockCloneTargetTx(ctx, tx, sourceOwnerID, userID, target)
	if err != nil {
		return "", nil, HideOtherAccountLock(err, userID)
	}
	files, err := snapshotCloneFilesTx(ctx, tx, `f.id=$1`, fileID)
	if err != nil {
		return "", nil, err
	}
	if len(files) == 0 {
		return "", nil, ErrNotFound
	}
	f := files[0]
	if err := lockCloneBlobPathsTx(ctx, tx, cloneFileBlobPaths(files)); err != nil {
		return "", nil, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, dest.workspaceID, 1); err != nil {
		return "", nil, err
	}
	// The cloner's plan caps one file as it caps an upload (Epo 2026-10-12).
	tier, err := s.effectivePlanTierForUser(ctx, tx, dest.payerID)
	if err != nil {
		return "", nil, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return "", nil, err
	}
	if f.sizeBytes > limits.SourceFileBytes {
		return "", nil, &FileTooLargeError{LimitBytes: limits.SourceFileBytes}
	}
	if err := s.gateStorageTx(ctx, tx, dest.payerID, f.sizeBytes+f.sourceBytes); err != nil {
		return "", nil, err
	}
	nid := uid("f")
	thumbnail, err := insertCloneFileTx(ctx, tx, f, nid, dest.workspaceID, userID, dest.chapterID,
		target.Name, time.Now().UnixMicro())
	if err != nil {
		return "", nil, err
	}
	if f.indexed {
		indexed, err := cloneRetrievalIndex(ctx, tx, sourceWorkspaceID, dest.workspaceID, map[string]string{f.id: nid}, nil)
		if err != nil {
			return "", nil, err
		}
		if !indexed[nid] {
			if err := s.queueCloneIngestTx(ctx, tx, userID, dest.workspaceID, nid, f); err != nil {
				return "", nil, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	var copies []ThumbnailCopy
	if thumbnail != nil {
		copies = append(copies, *thumbnail)
	}
	return nid, copies, nil
}

// queueCloneIngestTx processes a copied file again, as an upload is, when its
// target embeds in another space than the source and holds no copy of the
// content (or holds one still processing). The actor pays the re-embedding
// and is refused without credits (Epo 2026-10-12); the pipeline's donor path
// reuses the parse where it can. The copy's bytes stay charged while it is
// pending (files are charged whatever their status).
func (s *Store) queueCloneIngestTx(ctx context.Context, tx pgx.Tx, actorID, workspaceID, fileID string, f workspaceCloneFile) error {
	// A processed store-only upload keeps parse_mode 'none' (see reprocessTx),
	// so its copy is parsed the way the source was.
	mode := f.parseMode
	if mode == sourceupload.ParseModeNone && f.everParsed {
		mode = sourceupload.ParseModeFast
	}
	plan, err := sourceupload.BuildProcessingPlan(f.name, f.kind, mode)
	if err != nil {
		return err
	}
	if plan.Route == sourceupload.RouteStoreOnly || f.blobPath == nil {
		// Nothing to process: the copy is stored, not indexed.
		_, err = tx.Exec(ctx, `UPDATE files SET indexed=false WHERE id=$1`, fileID)
		return err
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, actorID, workspaceID)
	if err != nil {
		return err
	}
	var parser, etag string
	if f.parser != nil {
		parser = *f.parser
	}
	if f.sourceETag != nil {
		etag = *f.sourceETag
	}
	payload, err := s.ingestJobPayload(ctx, tx, actorID, map[string]any{
		"fileId": fileID, "workspaceId": workspaceID, "blobPath": *f.blobPath, "kind": f.kind,
		"parser": parser, "parseMode": mode, "processingPlan": plan,
		"sourceETag": etag, "sourceRevision": f.revision, "reservationId": reservation,
	})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,$2,$3)`,
		uid("job"), initialPipelineJobType(plan), payload); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE files SET status='pending', indexed=false WHERE id=$1`, fileID)
	return err
}

// CloneMaterial copies one material into a workspace the actor edits (and
// one of its chapters) or, with no workspace, into a private standalone copy.
// A note brings its embedded rows along under fresh ids; flashcards get fresh
// card ids; editor assets get fresh rows over shared blobs. Comments, Yjs
// state and study progress are not copied. The cloner pays.
func (s *Store) CloneMaterial(ctx context.Context, userID, matID string, target CloneTarget) (Material, error) {
	payer := clonePayerLock(userID)
	var newID string
	err := func() error {
		conn, unlock, err := s.lockContainedCloneSource(ctx, "material", matID, false, payer)
		if err != nil {
			return err
		}
		defer unlock()
		if err := retryClone(ctx, func() (err error) {
			newID, err = s.cloneMaterialOnce(ctx, conn, userID, matID, target)
			return err
		}); err != nil {
			return err
		}
		bumpCloneCount(context.WithoutCancel(ctx), conn, `INSERT INTO material_clone_counts (material_id, clone_count)
			VALUES ($1,1) ON CONFLICT (material_id) DO UPDATE
			SET clone_count=material_clone_counts.clone_count+1`, matID)
		return nil
	}()
	if err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, newID)
}

func (s *Store) cloneMaterialOnce(
	ctx context.Context,
	starter cloneTxStarter,
	userID, matID string,
	target CloneTarget,
) (string, error) {
	tx, err := starter.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	src, err := scanMaterial(tx.QueryRow(ctx, `SELECT `+materialCols+`
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, matID))
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	// An embedded row is copied only with its note.
	if src.ParentMaterialID != "" {
		return "", ErrNotFound
	}
	if _, err := materialEffectiveAccess(ctx, tx, userID, matID); err != nil {
		return "", err
	}
	if src.WorkspaceID != "" {
		if err := assertCloneSourceTx(ctx, tx, userID, src.WorkspaceID); err != nil {
			return "", err
		}
	}
	// Account lifecycle is the only source-side serialization. The material and
	// its workspace remain unlocked so accepted collaboration stores can finish.
	dest, err := s.lockCloneTargetTx(ctx, tx, src.OwnerUserID, userID, target)
	if err != nil {
		return "", HideOtherAccountLock(err, userID)
	}

	// A note brings its embedded rows along; their references are rewritten
	// to the copies below.
	var embedded []Material
	if src.Kind == "note" {
		childRows, err := tx.Query(ctx, `SELECT `+materialCols+`
			FROM materials WHERE parent_material_id=$1 AND trashed_at IS NULL ORDER BY created_at`, matID)
		if err != nil {
			return "", err
		}
		for childRows.Next() {
			child, err := scanMaterial(childRows)
			if err != nil {
				childRows.Close()
				return "", err
			}
			embedded = append(embedded, child)
		}
		childRows.Close()
		if err := childRows.Err(); err != nil {
			return "", err
		}
	}
	contents := []string{src.Content}
	childIDs := make([]string, 0, len(embedded))
	for _, child := range embedded {
		contents = append(contents, child.Content)
		childIDs = append(childIDs, child.ID)
	}
	assets, assetIDMap, assetBytes, err := snapshotStandaloneCloneAssets(
		ctx, tx, src, childIDs, contents,
	)
	if err != nil {
		return "", err
	}
	assetPaths := make([]string, len(assets))
	for i, asset := range assets {
		assetPaths[i] = asset.objectPath
	}
	if err := lockCloneBlobPathsTx(ctx, tx, assetPaths); err != nil {
		return "", err
	}

	// rewrite applies every clone rewrite but the note's references.
	rewrite := func(m Material) (content string, cardIDs []string, err error) {
		content = m.Content
		if m.Kind == "flashcards" {
			if content, cardIDs, err = rewriteCardIDsWithMap(content, map[string]string{}); err != nil {
				return "", nil, err
			}
		}
		if content, err = materialdoc.RewriteClonedEditorAssetIDs(content, assetIDMap); err != nil {
			return "", nil, err
		}
		content, err = cloneMentions(content, dest.members)
		return content, cardIDs, err
	}
	type materialClone struct {
		src     Material
		newID   string
		content string
		metrics materialdoc.DocumentMetrics
		preview json.RawMessage
		cardIDs []string
	}
	measure := func(clone *materialClone) (int64, error) {
		var err error
		if clone.metrics, err = materialdoc.Metrics(clone.content); err != nil {
			return 0, err
		}
		if err := clone.metrics.LimitError(); err != nil {
			return 0, err
		}
		if clone.preview, err = materialdoc.Preview(string(clone.src.Kind), clone.content); err != nil {
			return 0, err
		}
		return storageJSONSizeTx(ctx, tx, clone.content)
	}
	embeddedIDs := map[string]string{}
	clones := make([]materialClone, 0, len(embedded)+1)
	bytes := assetBytes
	for _, child := range embedded {
		clone := materialClone{src: child, newID: uid("mat")}
		embeddedIDs[child.ID] = clone.newID
		if clone.content, clone.cardIDs, err = rewrite(child); err != nil {
			return "", err
		}
		size, err := measure(&clone)
		if err != nil {
			return "", err
		}
		bytes += size
		clones = append(clones, clone)
	}
	root := materialClone{src: src, newID: uid("mat")}
	if root.content, root.cardIDs, err = rewrite(src); err != nil {
		return "", err
	}
	if src.Kind == "note" {
		if root.content, err = materialdoc.RewriteMaterialRefIDs(root.content, embeddedIDs); err != nil {
			return "", err
		}
	}
	size, err := measure(&root)
	if err != nil {
		return "", err
	}
	bytes += size
	if err := s.gateStorageTx(ctx, tx, dest.payerID, bytes); err != nil {
		return "", err
	}

	// Scope names chapters and files of the source's workspace: kept only in it.
	scopeChapters, scopeFileNames := []string{}, []string{}
	if dest.workspaceID != "" && dest.workspaceID == src.WorkspaceID {
		scopeChapters, scopeFileNames = src.ScopeChapters, src.ScopeFileNames
	}
	insert := func(clone materialClone, title string, chapterID, parentID *string, scopeChapters, scopeFileNames []string) error {
		// Attribution travels with the copy: dropping it would strip the
		// source books' licence credit.
		var provenance []byte
		if clone.src.Provenance != nil {
			var err error
			if provenance, err = json.Marshal(clone.src.Provenance); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO materials
			(id, created_by, owner_user_id, workspace_id, workspace_name, kind, title, content,
			 chapter_id, scope_chapters, scope_file_names, privacy, color, node_count, max_depth, revision, updated_by,
			 parent_material_id, provenance, preview)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private',$12,$13,$14,$15,$2,$16,$17,$18)`,
			clone.newID, userID, dest.payerID, nullStr(dest.workspaceID), dest.workspaceName, clone.src.Kind,
			title, json.RawMessage(clone.content), chapterID, scopeChapters, scopeFileNames, clone.src.Color,
			clone.metrics.NodeCount, clone.metrics.MaxDepth, clone.src.Revision, parentID, provenance,
			clone.preview); err != nil {
			if isUniqueViolation(err) {
				return ErrTitleTaken
			}
			return err
		}
		for _, cid := range clone.cardIDs {
			if _, err := tx.Exec(ctx, `INSERT INTO flashcard_cards (card_id, material_id) VALUES ($1,$2)`,
				cid, clone.newID); err != nil {
				return err
			}
		}
		return nil
	}
	if err := insert(root, target.Name, dest.chapterID, nil, scopeChapters, scopeFileNames); err != nil {
		return "", err
	}
	for _, clone := range clones {
		// An embed's own credits travel with it, like the note's.
		if err := insert(clone, embeddedName(), nil, &root.newID, []string{}, []string{}); err != nil {
			return "", err
		}
	}
	for _, asset := range assets {
		home := root.newID
		if asset.materialID != src.ID {
			home = embeddedIDs[asset.materialID]
		}
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose,
			 object_path, content_type, size_bytes, status, etag, created_at, completed_at)
			VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12)`,
			asset.newID, nullStr(dest.workspaceID), home, userID, asset.name, asset.purpose, asset.objectPath,
			asset.contentType, asset.sizeBytes, asset.etag, asset.createdAt,
			asset.completedAt); err != nil {
			return "", err
		}
	}
	// A workspace note shares the source's index when it reads the same,
	// otherwise it starts dirty and the scheduler indexes it.
	if src.Kind == "note" && dest.workspaceID != "" {
		indexed := map[string]bool{}
		if src.WorkspaceID != "" {
			sourceItems, copyItems := map[string]string{}, map[string]string{}
			for _, clone := range clones {
				sourceItems[clone.src.ID], copyItems[clone.newID] = clone.src.Content, clone.content
			}
			same, err := sameIndexText(src.Content, sourceItems, root.content, copyItems)
			if err != nil {
				return "", err
			}
			if same {
				if indexed, err = cloneRetrievalIndex(ctx, tx, src.WorkspaceID, dest.workspaceID,
					nil, map[string]string{src.ID: root.newID}); err != nil {
					return "", err
				}
			}
		}
		if !indexed[root.newID] {
			if _, err := tx.Exec(ctx, `UPDATE materials SET index_dirty_at=now() WHERE id=$1`, root.newID); err != nil {
				return "", err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return root.newID, nil
}

// lockCloneAccountsTx follows the normal ordered account lock discipline over
// the source owner, the actor and the accounts that pay for the copy, and
// refuses any of them that is locked (deleted, deletion pending, suspended):
// callers map a locked owner to not found (HideOtherAccountLock).
func lockCloneAccountsTx(
	ctx context.Context,
	tx pgx.Tx,
	sourceOwnerID, actorUserID string,
	payerIDs ...string,
) error {
	ids := []string{sourceOwnerID}
	for _, id := range append([]string{actorUserID}, payerIDs...) {
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
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
		if state == AccountActive {
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

// A cloned file carries its source file's published caption references. Hash
// discovery uses a separate live-visibility check in the caption resolver.
func cloneImageCaptionAssociations(ctx context.Context, tx pgx.Tx, oldID, newID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes) SELECT 'ica_'||substr(md5(random()::text||clock_timestamp()::text||id),1,24),$2,image_sha256,caption_blob_path,size_bytes FROM image_caption_associations WHERE published AND file_id=$1`, oldID, newID)
	return err
}
