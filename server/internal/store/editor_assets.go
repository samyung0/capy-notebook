package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
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
	ID           string
	AssetID      string
	WorkspaceID  string
	MaterialID   string
	UserID       string
	ObjectPath   string
	FinalPath    string
	ContentType  string
	DeclaredSize int64
	Status       string
	ExpiresAt    time.Time
}

// NewEditorAssetReservation names the material that uploads it. A workspace
// material's asset also names the workspace, which pays; a standalone
// material's asset is charged to the material owner. The material's saves and
// purge delete it.
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
	object_path, final_path, content_type, declared_size, status, expires_at`

func scanEditorAssetUpload(row interface{ Scan(...any) error }) (EditorAssetUpload, error) {
	var upload EditorAssetUpload
	err := row.Scan(&upload.ID, &upload.AssetID, &upload.WorkspaceID, &upload.MaterialID, &upload.UserID,
		&upload.ObjectPath, &upload.FinalPath, &upload.ContentType, &upload.DeclaredSize,
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
	// A workspace transferred since the reservation charges a different owner.
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
// standalone) and whether it is a quiz or flashcard set, which caps its images.
func (s *Store) EditorAssetMaterial(ctx context.Context, id string) (workspaceID string, study bool, err error) {
	err = s.pool.QueryRow(ctx, `SELECT COALESCE(workspace_id,''), kind IN ('quiz','flashcards')
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, id).Scan(&workspaceID, &study)
	if isNoRows(err) {
		return "", false, ErrNotFound
	}
	return workspaceID, study, err
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
// object under blob refcounting and charged to the target's payer; a trashed
// source is copied too. A source that is unknown (purged), not
// ready, or unreadable by the actor (the resolve rule) is left out, as is an
// image over imageMaxBytes when that is positive (a quiz's or flashcard set's 2 MB cap).
// When the copies do not fit the payer's quota none is made and refused is
// true; restores still land.
func (s *Store) AdoptEditorAssets(
	ctx context.Context,
	actorID, workspaceID, materialID string,
	sourceIDs []string,
	imageMaxBytes int64,
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
		if asset.Status != "ready" ||
			(imageMaxBytes > 0 && asset.Purpose == "image" && asset.SizeBytes > imageMaxBytes) {
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
// the storage owner. A workspace asset needs workspace edit access; a
// standalone material is edited only by its owner. Accounts lock before the
// material row, matching standalone material saves.
func (s *Store) lockEditorAssetScopeTx(ctx context.Context, tx pgx.Tx, workspaceID, materialID, actorID string) (string, error) {
	if workspaceID != "" {
		ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actorID)
		if err != nil || materialID == "" {
			return ownerID, err
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
		return ownerID, nil
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
