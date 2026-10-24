package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/planlimits"
)

var (
	ErrEditorAssetUploadExpired = errors.New("editor asset upload expired")
	ErrEditorAssetUploadState   = errors.New("editor asset upload is not pending")
)

type EditorAsset struct {
	ID          string     `json:"assetId"`
	WorkspaceID string     `json:"workspaceId"`
	MaterialID  string     `json:"materialId,omitempty"`
	UserID      string     `json:"-"`
	CreatedBy   *string    `json:"-"`
	Name        string     `json:"name"`
	Purpose     string     `json:"purpose"`
	ObjectPath  string     `json:"-"`
	ContentType string     `json:"contentType"`
	SizeBytes   int64      `json:"sizeBytes"`
	Status      string     `json:"status"`
	ETag        string     `json:"-"`
	CreatedAt   time.Time  `json:"createdAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	// Trashed: its material's save stopped using it; it is restored when the
	// material uses it again and purged a day after (PurgeTrashedEditorAssets).
	Trashed bool `json:"-"`
}

// EditorAssetUpload is an upload_sessions row with target='editor_asset'. The
// two upload flows share the table (and therefore one reservation trigger and
// one sweeper) while their destinations stay separate.
type EditorAssetUpload struct {
	ID          string
	AssetID     string
	WorkspaceID string
	MaterialID  string
	// UserID is charged for the reservation: its uploader (M16), who is also
	// CreatedBy, the only account that completes it.
	UserID       string
	CreatedBy    string
	ObjectPath   string
	FinalPath    string
	ContentType  string
	DeclaredSize int64
	Status       string
	ExpiresAt    time.Time
}

// NewEditorAssetReservation names the material that uploads it, and its
// workspace when it has one. The uploader pays (Epo 2026-10-24, M16). The
// material's saves and purge delete it.
type NewEditorAssetReservation struct {
	AssetID      string
	UploadID     string
	WorkspaceID  string
	MaterialID   string
	CreatedBy    string
	Name         string
	Purpose      string
	ObjectPath   string
	FinalPath    string
	ContentType  string
	DeclaredSize int64
	ExpiresAt    time.Time
}

func (s *Store) CreateEditorAssetReservation(ctx context.Context, in NewEditorAssetReservation) (EditorAsset, EditorAssetUpload, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.lockEditorAssetScopeTx(ctx, tx, in.WorkspaceID, in.MaterialID, in.CreatedBy)
	if err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	if err := s.assertMaterialNotFullTx(ctx, tx, in.MaterialID); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	if err := s.reserveStorageTx(ctx, tx, ownerID, in.DeclaredSize); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	finalPath := in.FinalPath
	if finalPath == "" {
		finalPath = in.ObjectPath
	}
	if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
		(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
		in.AssetID, nullStr(in.WorkspaceID), nullStr(in.MaterialID), ownerID, in.CreatedBy, in.Name, in.Purpose,
		finalPath, in.ContentType, in.DeclaredSize); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO upload_sessions
		(id, target, asset_id, workspace_id, material_id, user_id, created_by, object_path, final_path,
		 content_type, declared_size, reserved_size, expires_at)
		VALUES ($1,'editor_asset',$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
		in.UploadID, in.AssetID, nullStr(in.WorkspaceID), nullStr(in.MaterialID), ownerID, nullStr(in.CreatedBy),
		in.ObjectPath, finalPath, in.ContentType, in.DeclaredSize, in.ExpiresAt); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	asset, err := s.GetEditorAsset(ctx, in.AssetID)
	if err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	upload, err := s.GetEditorAssetUpload(ctx, in.UploadID)
	return asset, upload, err
}

// AssertEditorAssetRoom runs an editor-asset upload's reservation gates (the
// scope's locks and the payer's storage) and rolls back, for the upload's
// ticket. The reservation still gates.
func (s *Store) AssertEditorAssetRoom(ctx context.Context, workspaceID, materialID, actorID string, size int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	payerID, err := s.lockEditorAssetScopeTx(ctx, tx, workspaceID, materialID, actorID)
	if err != nil {
		return err
	}
	if err := s.assertMaterialNotFullTx(ctx, tx, materialID); err != nil {
		return err
	}
	return s.gateStorageTx(ctx, tx, payerID, size)
}

// assertMaterialNotFullTx refuses a new image or audio clip for a material
// that is view-only because its own payer is at its storage limit: its
// content could not save the node, so nobody is charged for it (M16). The
// scope lock refuses a frozen payer.
func (s *Store) assertMaterialNotFullTx(ctx context.Context, tx pgx.Tx, materialID string) error {
	var payerID string
	err := tx.QueryRow(ctx, `SELECT owner_user_id FROM materials WHERE id=$1`, materialID).Scan(&payerID)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return s.storageFullErr(ctx, tx, payerID)
}

const editorAssetCols = `id, COALESCE(workspace_id,''), COALESCE(material_id,''), user_id, created_by, name, purpose, object_path,
	content_type, size_bytes, status, COALESCE(etag,''), created_at, completed_at, trashed_at IS NOT NULL`

func scanEditorAsset(row interface{ Scan(...any) error }) (EditorAsset, error) {
	var asset EditorAsset
	err := row.Scan(&asset.ID, &asset.WorkspaceID, &asset.MaterialID, &asset.UserID, &asset.CreatedBy, &asset.Name,
		&asset.Purpose, &asset.ObjectPath, &asset.ContentType, &asset.SizeBytes, &asset.Status,
		&asset.ETag, &asset.CreatedAt, &asset.CompletedAt, &asset.Trashed)
	return asset, err
}

func (s *Store) GetEditorAsset(ctx context.Context, assetID string) (EditorAsset, error) {
	asset, err := scanEditorAsset(s.pool.QueryRow(ctx,
		`SELECT `+editorAssetCols+` FROM editor_assets WHERE id=$1`, assetID))
	if isNoRows(err) {
		return asset, ErrNotFound
	}
	return asset, err
}

func (s *Store) EditorAssetObjectPath(ctx context.Context, assetID string) (string, error) {
	var objectPath string
	err := s.pool.QueryRow(ctx, `SELECT object_path FROM editor_assets WHERE id=$1`, assetID).Scan(&objectPath)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return objectPath, err
}

const editorAssetUploadCols = `id, asset_id, COALESCE(workspace_id,''), COALESCE(material_id,''), user_id,
	COALESCE(created_by,''), object_path, final_path, content_type, declared_size, status, expires_at`

func scanEditorAssetUpload(row interface{ Scan(...any) error }) (EditorAssetUpload, error) {
	var upload EditorAssetUpload
	err := row.Scan(&upload.ID, &upload.AssetID, &upload.WorkspaceID, &upload.MaterialID, &upload.UserID,
		&upload.CreatedBy, &upload.ObjectPath, &upload.FinalPath, &upload.ContentType, &upload.DeclaredSize,
		&upload.Status, &upload.ExpiresAt)
	return upload, err
}

// editorAssetUploadFrom restricts the shared table to the editor-asset flow, so
// a source upload id can never be driven through the asset completion path.
const editorAssetUploadFrom = ` FROM upload_sessions WHERE target='editor_asset' AND `

func (s *Store) GetEditorAssetUpload(ctx context.Context, uploadID string) (EditorAssetUpload, error) {
	upload, err := scanEditorAssetUpload(s.pool.QueryRow(ctx,
		`SELECT `+editorAssetUploadCols+editorAssetUploadFrom+`id=$1`, uploadID))
	if isNoRows(err) {
		return upload, ErrNotFound
	}
	return upload, err
}

// FinalizeEditorAssetUpload marks both records ready exactly once. Object
// verification happens before this transaction; repeated complete calls return
// the same stable asset.
func (s *Store) FinalizeEditorAssetUpload(ctx context.Context, uploadID, etag string) (EditorAsset, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EditorAsset{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID, materialID, storedOwnerID string
	var createdBy *string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(workspace_id,''), COALESCE(material_id,''), user_id, created_by`+
		editorAssetUploadFrom+`id=$1`, uploadID).
		Scan(&workspaceID, &materialID, &storedOwnerID, &createdBy); err != nil {
		if isNoRows(err) {
			return EditorAsset{}, ErrNotFound
		}
		return EditorAsset{}, err
	}
	actorID := ""
	if createdBy != nil {
		actorID = *createdBy
	}
	ownerID, err := s.lockEditorAssetScopeTx(ctx, tx, workspaceID, materialID, actorID)
	if err != nil {
		return EditorAsset{}, err
	}
	// The reservation is charged to its uploader.
	if storedOwnerID != ownerID {
		return EditorAsset{}, ErrEditorAssetUploadState
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return EditorAsset{}, err
	}
	upload, err := scanEditorAssetUpload(tx.QueryRow(ctx,
		`SELECT `+editorAssetUploadCols+editorAssetUploadFrom+`id=$1 FOR UPDATE`, uploadID))
	if isNoRows(err) {
		return EditorAsset{}, ErrNotFound
	}
	if err != nil {
		return EditorAsset{}, err
	}
	if upload.Status == "completed" {
		asset, err := scanEditorAsset(tx.QueryRow(ctx,
			`SELECT `+editorAssetCols+` FROM editor_assets WHERE id=$1`, upload.AssetID))
		return asset, err
	}
	if upload.Status != "pending" {
		return EditorAsset{}, ErrEditorAssetUploadState
	}
	if time.Now().UTC().After(upload.ExpiresAt) {
		return EditorAsset{}, ErrEditorAssetUploadExpired
	}

	if _, err := tx.Exec(ctx, `UPDATE editor_assets
		SET status='ready', etag=$2, completed_at=now() WHERE id=$1 AND status='pending'`,
		upload.AssetID, etag); err != nil {
		return EditorAsset{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions
		SET status='completed', completed_at=now() WHERE id=$1`, uploadID); err != nil {
		return EditorAsset{}, err
	}
	asset, err := scanEditorAsset(tx.QueryRow(ctx,
		`SELECT `+editorAssetCols+` FROM editor_assets WHERE id=$1`, upload.AssetID))
	if err != nil {
		return EditorAsset{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EditorAsset{}, err
	}
	return asset, nil
}

// MarkEditorAssetUploadExpired discards an abandoned or rejected editor upload.
//
// It deletes the pending editor_assets row rather than flagging it, and lets the
// cascade do the rest: the upload_sessions row goes with it, which releases the
// reservation through the accounting trigger and queues both object paths
// through the blob-deletion trigger. Flagging instead would keep the asset row
// holding a blob reference, so its object could never be collected — and making
// the refcount conditional on a status column is exactly the kind of special
// case that makes trigger-based accounting untrustworthy.
//
// Unlike a source upload, the destination row here exists before any bytes
// arrive, so a destination that never received bytes is not an audit record.
func (s *Store) MarkEditorAssetUploadExpired(ctx context.Context, uploadID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var assetID, userID string
	err = tx.QueryRow(ctx, `SELECT asset_id, user_id`+
		editorAssetUploadFrom+`id=$1 AND status='pending'`, uploadID).
		Scan(&assetID, &userID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM editor_assets
		WHERE id=$1 AND status='pending'`, assetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EditorAssetMaterial returns the live material's workspace (empty when
// standalone) and the plan limits of the uploader, who pays for the images and
// audio it adds (Epo 2026-10-24, M16).
func (s *Store) EditorAssetMaterial(ctx context.Context, id, uploaderID string) (workspaceID string, limits planlimits.Limits, err error) {
	err = s.pool.QueryRow(ctx, `SELECT COALESCE(workspace_id,'')
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, id).Scan(&workspaceID)
	if isNoRows(err) {
		return "", planlimits.Limits{}, ErrNotFound
	}
	if err != nil {
		return "", planlimits.Limits{}, err
	}
	limits, err = s.PayerPlanLimits(ctx, uploaderID)
	return workspaceID, limits, err
}

// pruneMaterialAssetsTx trashes the material's own ready editor assets that its
// new content no longer references and restores trashed ones it references
// again (undo, cut and paste, a replayed draft). A trashed asset stays charged
// and is purged a day later (PurgeTrashedEditorAssets). Pending reservations
// are left to the upload expiry. Every content write calls it with
// materialdoc's EditorAssetIDs of the new content, the one definition of a
// reference.
//
// An asset completed in the last 60 seconds is kept. In a shared note the
// image node's assetId reaches the server a moment after the upload completes
// (or after a pasted copy is made), and a collaborator's save in that window
// must not trash it. An image removed within that minute is trashed by a
// later save. Quizzes follow the same rule.
func pruneMaterialAssetsTx(ctx context.Context, tx pgx.Tx, materialID string, kept []string) error {
	kept = append([]string{}, kept...)
	if _, err := tx.Exec(ctx, `UPDATE editor_assets SET trashed_at=NULL
		WHERE material_id=$1 AND trashed_at IS NOT NULL AND id = ANY($2::text[])`,
		materialID, kept); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE editor_assets SET trashed_at=now()
		WHERE material_id=$1 AND status='ready' AND trashed_at IS NULL AND id <> ALL($2::text[])
		  AND completed_at < now() - interval '60 seconds'`,
		materialID, kept)
	return err
}

// PurgeTrashedEditorAssets deletes editor assets trashed more than a day ago,
// one per transaction under the payer's storage lock like any asset delete:
// the row triggers release the charge and queue the object for the reaper.
// Returns the number purged.
func (s *Store) PurgeTrashedEditorAssets(ctx context.Context, limit int) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, user_id FROM editor_assets
		WHERE trashed_at <= now() - interval '1 day' ORDER BY trashed_at LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type due struct{ id, userID string }
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (due, error) {
		var d due
		return d, row.Scan(&d.id, &d.userID)
	})
	if err != nil {
		return 0, err
	}
	purged := 0
	for _, d := range items {
		err := s.inTx(ctx, func(tx pgx.Tx) error {
			if err := s.lockStorageRowTx(ctx, tx, d.userID); err != nil {
				return err
			}
			// Restored meanwhile: the condition keeps it.
			tag, err := tx.Exec(ctx, `DELETE FROM editor_assets
				WHERE id=$1 AND trashed_at <= now() - interval '1 day'`, d.id)
			purged += int(tag.RowsAffected())
			return err
		})
		if err != nil {
			return purged, err
		}
	}
	return purged, nil
}

// AdoptEditorAssets gives the target material its own copy of each source
// asset, for an image pasted from another note or quiz. It returns the target's
// asset id per adoptable source: the same id when the asset is already the
// target's (restored when trashed), else a new ready row sharing the stored
// object under blob refcounting and charged to the actor, who pasted it (M16);
// a trashed source is copied too. A source that is unknown (purged), not
// ready, or unreadable by the actor (the resolve rule) is left out, as is one
// over the actor's plan cap for its purpose (limits.EditorAssetBytes).
// When the copies do not fit the actor's quota none is made and refused is
// true; restores still land.
func (s *Store) AdoptEditorAssets(
	ctx context.Context,
	actorID, workspaceID, materialID string,
	sourceIDs []string,
	limits planlimits.Limits,
) (adopted map[string]string, refused bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.lockEditorAssetScopeTx(ctx, tx, workspaceID, materialID, actorID)
	if err != nil {
		return nil, false, err
	}
	// Share-locking the sources holds off their deletion, so each copied path
	// still has a blob reference when the copies add theirs.
	rows, err := tx.Query(ctx, `SELECT `+editorAssetCols+` FROM editor_assets
		WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, sourceIDs)
	if err != nil {
		return nil, false, err
	}
	var sources []EditorAsset
	for rows.Next() {
		asset, err := scanEditorAsset(rows)
		if err != nil {
			rows.Close()
			return nil, false, err
		}
		sources = append(sources, asset)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	adopted = make(map[string]string, len(sources))
	var copies []EditorAsset
	var paths []string
	var bytes int64
	for _, asset := range sources {
		if asset.MaterialID == materialID {
			// Its node came back (undo, cut and paste): back out of the trash at
			// once, so the node resolves it.
			if asset.Trashed {
				if _, err := tx.Exec(ctx, `UPDATE editor_assets SET trashed_at=NULL WHERE id=$1`, asset.ID); err != nil {
					return nil, false, err
				}
			}
			adopted[asset.ID] = asset.ID
			continue
		}
		if asset.Status != "ready" || asset.SizeBytes > limits.EditorAssetBytes(asset.Purpose) {
			continue
		}
		readable, err := editorAssetReadableTx(ctx, tx, actorID, asset)
		if err != nil {
			return nil, false, err
		}
		if !readable {
			continue
		}
		copies = append(copies, asset)
		paths = append(paths, asset.ObjectPath)
		bytes += asset.SizeBytes
	}
	if len(copies) == 0 {
		return adopted, false, tx.Commit(ctx)
	}
	if err := lockCloneBlobPathsTx(ctx, tx, paths); err != nil {
		return nil, false, err
	}
	var quota *QuotaExceededError
	if err := s.gateStorageTx(ctx, tx, ownerID, bytes); errors.As(err, &quota) {
		return adopted, true, tx.Commit(ctx)
	} else if err != nil {
		return nil, false, err
	}
	for _, asset := range copies {
		newID := uid("asset")
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, completed_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11,now())`,
			newID, nullStr(workspaceID), materialID, ownerID, actorID, asset.Name, asset.Purpose,
			asset.ObjectPath, asset.ContentType, asset.SizeBytes, nullStr(asset.ETag)); err != nil {
			return nil, false, err
		}
		adopted[asset.ID] = newID
	}
	return adopted, false, tx.Commit(ctx)
}

// editorAssetReadableTx is resolve's read rule: workspace access for a
// workspace asset, material access for a standalone one.
func editorAssetReadableTx(ctx context.Context, tx pgx.Tx, actorID string, asset EditorAsset) (bool, error) {
	var err error
	switch {
	case asset.WorkspaceID != "":
		var effective WorkspaceRole
		_, effective, err = workspaceRoles(ctx, tx, actorID, asset.WorkspaceID)
		if err == nil && effective == "" {
			return false, nil
		}
	case asset.MaterialID != "":
		_, err = materialEffectiveAccess(ctx, tx, actorID, asset.MaterialID)
	default:
		return false, nil
	}
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

// lockEditorAssetScopeTx admits an editor-asset write for the actor and returns
// the payer: the actor, who pays for the images and audio it adds, as for a
// file (Epo 2026-10-24, M16). A workspace asset needs workspace edit access; a
// standalone material is edited only by its owner. Nobody adds to a material
// whose own payer is frozen: its view-only state follows that payer alone.
// Accounts lock before the material row, matching material saves.
func (s *Store) lockEditorAssetScopeTx(ctx context.Context, tx pgx.Tx, workspaceID, materialID, actorID string) (string, error) {
	if workspaceID != "" {
		materialPayerID := ""
		if materialID != "" {
			// Set once at insert, so the unlocked read is stable.
			err := tx.QueryRow(ctx, `SELECT owner_user_id FROM materials
				WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL`, materialID, workspaceID).Scan(&materialPayerID)
			if isNoRows(err) {
				return "", ErrNotFound
			}
			if err != nil {
				return "", err
			}
		}
		if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actorID, materialPayerID); err != nil {
			return "", err
		}
		if err := s.assertEditableTx(ctx, tx, materialPayerID); err != nil {
			return "", HideOtherAccountLock(err, actorID)
		}
		if materialID == "" {
			return actorID, nil
		}
		// The asset also names the material, which must be live there.
		var live bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM materials
			WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`, materialID, workspaceID).Scan(&live); err != nil {
			return "", err
		}
		if !live {
			return "", ErrNotFound
		}
		return actorID, nil
	}
	var ownerID string
	err := tx.QueryRow(ctx, `SELECT owner_user_id FROM materials
		WHERE id=$1 AND workspace_id IS NULL AND trashed_at IS NULL`, materialID).Scan(&ownerID)
	if isNoRows(err) || (err == nil && ownerID != actorID) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if err := s.lockAccountSessionsTx(ctx, tx, ownerID); err != nil {
		return "", err
	}
	var lockedOwnerID string
	err = tx.QueryRow(ctx, `SELECT owner_user_id FROM materials
		WHERE id=$1 AND workspace_id IS NULL AND trashed_at IS NULL FOR UPDATE`, materialID).Scan(&lockedOwnerID)
	if isNoRows(err) || (err == nil && lockedOwnerID != ownerID) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if err := s.assertEditableTx(ctx, tx, ownerID); err != nil {
		return "", err
	}
	return ownerID, nil
}

// EditorAssetItem is an image or audio clip the caller pays for, wherever it
// sits (M16). The Files page's Embeds tab lists it under its note's title:
// one the caller can open opens that note, one it cannot is deleted there.
type EditorAssetItem struct {
	ID        string    `json:"assetId"`
	Name      string    `json:"name"`
	Purpose   string    `json:"purpose" enum:"image,audio"`
	SizeBytes int64     `json:"sizeBytes"`
	CreatedAt time.Time `json:"createdAt"`
	// MaterialID is the note, quiz or set it sits in (an embedded quiz's or
	// set's note), to open; empty when LostAccess.
	MaterialID string `json:"materialId,omitempty"`
	// MaterialTitle and WorkspaceName are blank once that workspace's owner is
	// no longer live.
	MaterialTitle string `json:"materialTitle"`
	WorkspaceName string `json:"workspaceName"`
	// LostAccess: the caller can no longer open its note (lostAccessSQL).
	LostAccess bool `json:"lostAccess"`
}

type EditorAssetPage struct {
	Items      []EditorAssetItem `json:"items" nullable:"false"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

// EditorAssetAccess narrows ListEditorAssets to media in notes the caller can
// open or to those it cannot; empty lists both.
type EditorAssetAccess string

const (
	EditorAssetsOpen EditorAssetAccess = "open"
	EditorAssetsLost EditorAssetAccess = "lost"
)

var editorAssetSort = listSort{column: "a.created_at", kind: "time"}

// editorAssetNoteJoin joins an asset (a) to its material (m) and that
// material's note (top: an embedded quiz's or set's note, else itself). The
// listing and the delete both decide access on top.workspace_id.
const editorAssetNoteJoin = ` JOIN materials m ON m.id=a.material_id
		JOIN materials top ON top.id=COALESCE(m.parent_material_id, m.id)`

// ListEditorAssets pages, newest first, through the images and audio the user
// pays for (editor_assets_payer_idx). Media in a trashed note or set it can
// still open are left out: they go with that material's trash and purge.
func (s *Store) ListEditorAssets(
	ctx context.Context,
	userID string,
	access EditorAssetAccess,
	limit int,
	cursor string,
) (EditorAssetPage, error) {
	if limit <= 0 || limit > listPageMax {
		limit = listPageMax
	}
	filter := `(l.lost OR (m.trashed_at IS NULL AND top.trashed_at IS NULL))`
	switch access {
	case EditorAssetsOpen:
		filter = `NOT l.lost AND m.trashed_at IS NULL AND top.trashed_at IS NULL`
	case EditorAssetsLost:
		filter = `l.lost`
	}
	clause, cursorArgs, err := cursorClause(editorAssetSort, "a.id", false, cursor, 2)
	if err != nil {
		return EditorAssetPage{}, err
	}
	args := append([]any{userID}, cursorArgs...)
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, `SELECT a.id, a.name, a.purpose, a.size_bytes, a.created_at,
			CASE WHEN l.lost THEN '' ELSE top.id END,
			`+workspaceNameSQL("top.workspace_id", "top.title")+`,
			`+workspaceNameSQL("top.workspace_id", "COALESCE(top.workspace_name,'')")+`, l.lost
		FROM editor_assets a`+editorAssetNoteJoin+`
		CROSS JOIN LATERAL (SELECT `+lostAccessSQL("top.workspace_id", "$1")+` AS lost) l
		WHERE a.user_id=$1 AND a.status='ready' AND a.trashed_at IS NULL AND `+filter+clause+
		orderClause(editorAssetSort, "a.id", false)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return EditorAssetPage{}, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (EditorAssetItem, error) {
		var item EditorAssetItem
		return item, row.Scan(&item.ID, &item.Name, &item.Purpose, &item.SizeBytes, &item.CreatedAt,
			&item.MaterialID, &item.MaterialTitle, &item.WorkspaceName, &item.LostAccess)
	})
	if err != nil {
		return EditorAssetPage{}, err
	}
	page := EditorAssetPage{Items: items}
	if len(items) > limit {
		last := items[limit-1]
		page.Items = items[:limit]
		page.NextCursor = encodeListCursor(cursorPrimary(editorAssetSort, last.CreatedAt, "", 0), last.ID)
	}
	return page, nil
}

// DeleteEditorAsset deletes an image or audio clip its payer can no longer
// open (M16): one it can open, it removes in its note instead. It goes at
// once: a trashed asset would come back with the material's next save. The
// material keeps the node, which then reads as removed
// (MissingEditorAssetIDs).
func (s *Store) DeleteEditorAsset(ctx context.Context, payerID, assetID string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var workspaceID string
		err := tx.QueryRow(ctx, `SELECT top.workspace_id FROM editor_assets a`+editorAssetNoteJoin+`
			WHERE a.id=$1 AND a.user_id=$2 AND a.status='ready' AND top.workspace_id IS NOT NULL`,
			assetID, payerID).Scan(&workspaceID)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		// Only the payer's account must be live, as for its files there. The
		// workspace row lock also holds off an invite or link joining it, so
		// access is decided under it, in the delete.
		if _, err := s.lockWorkspacePayerTx(ctx, tx, workspaceID, payerID); err != nil {
			return err
		}
		if err := s.lockStorageRowTx(ctx, tx, payerID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM editor_assets a USING materials m, materials top
			WHERE a.id=$1 AND m.id=a.material_id AND top.id=COALESCE(m.parent_material_id, m.id)
				AND `+lostAccessSQL("top.workspace_id", "$2"), assetID, payerID)
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrNotFound
		}
		return err
	})
}

// MaterialRemovedAssetIDs is MissingEditorAssetIDs for the images and audio a
// material's stored content references.
func (s *Store) MaterialRemovedAssetIDs(ctx context.Context, materialID string) ([]string, error) {
	var content string
	err := s.pool.QueryRow(ctx, `SELECT content FROM materials WHERE id=$1`, materialID).Scan(&content)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	ids, err := materialdoc.EditorAssetIDs(content)
	if err != nil {
		return nil, err
	}
	return s.MissingEditorAssetIDs(ctx, ids)
}

// MissingEditorAssetIDs returns the ids, of those a material's content
// references, that name no editor asset any more: images and audio their
// uploader deleted, or that went with the uploader's account (M16).
func (s *Store) MissingEditorAssetIDs(ctx context.Context, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT ref.id FROM unnest($1::text[]) AS ref(id)
		WHERE NOT EXISTS (SELECT 1 FROM editor_assets a WHERE a.id=ref.id) ORDER BY ref.id`, ids)
	if err != nil {
		return nil, err
	}
	return scanIDs(rows)
}
