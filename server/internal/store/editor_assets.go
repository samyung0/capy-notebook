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

type EditorAssetUpload struct {
	ID           string
	AssetID      string
	WorkspaceID  string
	UserID       string
	ObjectPath   string
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
	if _, err := tx.Exec(ctx, `INSERT INTO editor_asset_uploads
		(id, asset_id, workspace_id, user_id, object_path, content_type, declared_size, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		in.UploadID, in.AssetID, in.WorkspaceID, ownerID, in.ObjectPath,
		in.ContentType, in.DeclaredSize, in.ExpiresAt); err != nil {
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

const editorAssetUploadCols = `id, asset_id, workspace_id, user_id, object_path, content_type,
	declared_size, status, expires_at`

func scanEditorAssetUpload(row interface{ Scan(...any) error }) (EditorAssetUpload, error) {
	var upload EditorAssetUpload
	err := row.Scan(&upload.ID, &upload.AssetID, &upload.WorkspaceID, &upload.UserID,
		&upload.ObjectPath, &upload.ContentType, &upload.DeclaredSize,
		&upload.Status, &upload.ExpiresAt)
	return upload, err
}

func (s *Store) GetEditorAssetUpload(ctx context.Context, uploadID string) (EditorAssetUpload, error) {
	upload, err := scanEditorAssetUpload(s.pool.QueryRow(ctx,
		`SELECT `+editorAssetUploadCols+` FROM editor_asset_uploads WHERE id=$1`, uploadID))
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
	if err := tx.QueryRow(ctx, `SELECT user_id FROM editor_asset_uploads WHERE id=$1`, uploadID).
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
		`SELECT `+editorAssetUploadCols+` FROM editor_asset_uploads WHERE id=$1 FOR UPDATE`, uploadID))
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
	if _, err := tx.Exec(ctx, `UPDATE editor_asset_uploads
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

func (s *Store) ExpiredEditorAssetUploads(ctx context.Context, limit int) ([]EditorAssetUpload, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+editorAssetUploadCols+`
		FROM editor_asset_uploads
		WHERE status='pending' AND expires_at < now()
		ORDER BY expires_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var uploads []EditorAssetUpload
	for rows.Next() {
		upload, err := scanEditorAssetUpload(rows)
		if err != nil {
			return nil, err
		}
		uploads = append(uploads, upload)
	}
	return uploads, rows.Err()
}

func (s *Store) MarkEditorAssetUploadExpired(ctx context.Context, uploadID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var assetID string
	var userID string
	var declaredSize int64
	err = tx.QueryRow(ctx, `SELECT asset_id, user_id, declared_size
		FROM editor_asset_uploads
		WHERE id=$1 AND status='pending'`, uploadID).
		Scan(&assetID, &userID, &declaredSize)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `UPDATE editor_asset_uploads
		SET status='expired' WHERE id=$1 AND status='pending'
		RETURNING asset_id, user_id, declared_size`, uploadID).Scan(&assetID, &userID, &declaredSize)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE editor_assets
		SET status='expired' WHERE id=$1 AND status='pending'`, assetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) PruneEditorAssetUploads(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM editor_asset_uploads
		WHERE (status='completed' AND completed_at < now() - interval '30 days')
		   OR (status='expired' AND expires_at < now() - interval '7 days')`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM editor_assets
		WHERE status='expired' AND created_at < now() - interval '7 days'`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
