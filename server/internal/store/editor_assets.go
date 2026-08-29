package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrEditorAssetUploadExpired = errors.New("editor asset upload expired")
	ErrEditorAssetUploadState   = errors.New("editor asset upload is not pending")
)

type EditorAsset struct {
	ID          string     `json:"assetId"`
	WorkspaceID string     `json:"workspaceId"`
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
}

// EditorAssetUpload is an upload_sessions row with target='editor_asset'. The
// two upload flows share the table (and therefore one reservation trigger and
// one sweeper) while their destinations stay separate.
type EditorAssetUpload struct {
	ID           string
	AssetID      string
	WorkspaceID  string
	UserID       string
	ObjectPath   string
	FinalPath    string
	ContentType  string
	DeclaredSize int64
	Status       string
	ExpiresAt    time.Time
}

type NewEditorAssetReservation struct {
	AssetID      string
	UploadID     string
	WorkspaceID  string
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

	ownerID, err := s.storageOwnerTx(ctx, tx, in.WorkspaceID)
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
		(id, workspace_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
		in.AssetID, in.WorkspaceID, ownerID, in.CreatedBy, in.Name, in.Purpose,
		finalPath, in.ContentType, in.DeclaredSize); err != nil {
		return EditorAsset{}, EditorAssetUpload{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO upload_sessions
		(id, target, asset_id, workspace_id, user_id, created_by, object_path, final_path,
		 content_type, declared_size, reserved_size, expires_at)
		VALUES ($1,'editor_asset',$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,
		in.UploadID, in.AssetID, in.WorkspaceID, ownerID, nullStr(in.CreatedBy),
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

const editorAssetCols = `id, workspace_id, user_id, created_by, name, purpose, object_path,
	content_type, size_bytes, status, COALESCE(etag,''), created_at, completed_at`

func scanEditorAsset(row interface{ Scan(...any) error }) (EditorAsset, error) {
	var asset EditorAsset
	err := row.Scan(&asset.ID, &asset.WorkspaceID, &asset.UserID, &asset.CreatedBy, &asset.Name,
		&asset.Purpose, &asset.ObjectPath, &asset.ContentType, &asset.SizeBytes, &asset.Status,
		&asset.ETag, &asset.CreatedAt, &asset.CompletedAt)
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

const editorAssetUploadCols = `id, asset_id, workspace_id, user_id, object_path, final_path,
	content_type, declared_size, status, expires_at`

func scanEditorAssetUpload(row interface{ Scan(...any) error }) (EditorAssetUpload, error) {
	var upload EditorAssetUpload
	err := row.Scan(&upload.ID, &upload.AssetID, &upload.WorkspaceID, &upload.UserID,
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

	var ownerID string
	if err := tx.QueryRow(ctx,
		`SELECT user_id`+editorAssetUploadFrom+`id=$1`, uploadID).
		Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return EditorAsset{}, ErrNotFound
		}
		return EditorAsset{}, err
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
