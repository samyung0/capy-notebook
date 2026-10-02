package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A standalone material uploads editor assets into its own scope, charged to
// its owner, and an abandoned reservation releases its bytes through the
// asset-to-session cascade.
func TestStandaloneMaterialEditorAssetUpload(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_asset_owner")
	otherID := newBlobTestUser(t, s, "u_asset_other")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Standalone figures", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Figures", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	workspaceMaterial, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
		Kind: "note", Title: "Workspace figures", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	reserve := func(actorID, materialID string) (EditorAsset, EditorAssetUpload, error) {
		assetID, uploadID := uid("asset"), uid("eau")
		return s.CreateEditorAssetReservation(ctx, NewEditorAssetReservation{
			AssetID: assetID, UploadID: uploadID, MaterialID: materialID, CreatedBy: actorID,
			Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uploadID,
			FinalPath: "editor-assets/" + assetID, ContentType: "image/png", DeclaredSize: 100,
			ExpiresAt: time.Now().Add(time.Hour),
		})
	}
	storage := func() (used, reserved int64) {
		if err := s.pool.QueryRow(ctx, `SELECT used_bytes, reserved_bytes
			FROM user_storage WHERE user_id=$1`, ownerID).Scan(&used, &reserved); err != nil {
			t.Fatal(err)
		}
		return used, reserved
	}

	if _, _, err := reserve(otherID, material.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-owner reservation err = %v, want not found", err)
	}
	if _, _, err := reserve(ownerID, workspaceMaterial.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("workspace material reservation err = %v, want the workspace route", err)
	}
	usedBefore, reservedBefore := storage()
	asset, upload, err := reserve(ownerID, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if asset.MaterialID != material.ID || asset.WorkspaceID != "" || upload.MaterialID != material.ID {
		t.Fatalf("asset scope = %+v / %+v", asset, upload)
	}
	if _, reserved := storage(); reserved != reservedBefore+100 {
		t.Fatalf("reserved = %d, want owner charged 100 bytes", reserved-reservedBefore)
	}
	if asset, err = s.FinalizeEditorAssetUpload(ctx, upload.ID, "etag"); err != nil || asset.Status != "ready" {
		t.Fatalf("finalize = %+v, %v", asset, err)
	}
	if used, reserved := storage(); used != usedBefore+100 || reserved != reservedBefore {
		t.Fatalf("after finalize used +%d reserved +%d, want 100 used and nothing reserved",
			used-usedBefore, reserved-reservedBefore)
	}

	abandoned, abandonedUpload, err := reserve(ownerID, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MarkEditorAssetUploadExpired(ctx, abandonedUpload.ID); err != nil {
		t.Fatal(err)
	}
	var sessions int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM upload_sessions WHERE asset_id=$1`,
		abandoned.ID).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if _, reserved := storage(); sessions != 0 || reserved != reservedBefore {
		t.Fatalf("abandoned upload left %d sessions and %d reserved bytes", sessions, reserved-reservedBefore)
	}
}
