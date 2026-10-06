package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
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

// A workspace quiz's images name the quiz: a save that drops one deletes it
// (pending ones too), trashing keeps it, a workspace clone carries it to the
// cloned quiz, and purging the quiz deletes it, releasing its bytes each time.
func TestWorkspaceQuizEditorAssetsFollowTheQuiz(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_quiz_asset_owner")
	clonerID := newBlobTestUser(t, s, "u_quiz_asset_cloner")
	workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Quiz figures", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	quizContent := func(assetIDs ...string) string {
		stem := `{"type":"text","text":"Look."}`
		for _, id := range assetIDs {
			stem += `,{"type":"image","image":{"assetId":"` + id + `"},"width":10,"height":10,"description":"Figure"}`
		}
		content, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[`+stem+`],
			"parts":[{"id":"q1-a","blocks":[{"type":"text","text":"Explain."}],"answer":{"type":"open","accepted":["Because."],"hints":[]},"marks":1,"markscheme":[{"text":"States why","marks":1}],"solution":[]}],
			"layout":"paper","labels":"letters"}]`), nil)
		if err != nil {
			t.Fatal(err)
		}
		return content
	}
	quiz, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
		Kind: "quiz", Title: "Figures quiz", Content: quizContent(),
	})
	if err != nil {
		t.Fatal(err)
	}
	reserve := func() (EditorAsset, EditorAssetUpload) {
		assetID, uploadID := uid("asset"), uid("eau")
		asset, upload, err := s.CreateEditorAssetReservation(ctx, NewEditorAssetReservation{
			AssetID: assetID, UploadID: uploadID, WorkspaceID: workspace.ID, MaterialID: quiz.ID, CreatedBy: ownerID,
			Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uploadID,
			FinalPath: "editor-assets/" + assetID, ContentType: "image/png", DeclaredSize: 100,
			ExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		return asset, upload
	}
	ready := func() EditorAsset {
		_, upload := reserve()
		asset, err := s.FinalizeEditorAssetUpload(ctx, upload.ID, "etag")
		if err != nil {
			t.Fatal(err)
		}
		return asset
	}
	storage := func() (used, reserved int64) {
		if err := s.pool.QueryRow(ctx, `SELECT used_bytes, reserved_bytes
			FROM user_storage WHERE user_id=$1`, ownerID).Scan(&used, &reserved); err != nil {
			t.Fatal(err)
		}
		return used, reserved
	}
	exists := func(assetID string) bool {
		var found bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM editor_assets WHERE id=$1)`,
			assetID).Scan(&found); err != nil {
			t.Fatal(err)
		}
		return found
	}
	revision := quiz.Revision
	save := func(content string) {
		saved, err := s.UpdateMaterial(ctx, quiz.ID, MaterialPatch{
			Content: &content, UpdatedBy: ownerID, ExpectedRevision: &revision,
		})
		if err != nil {
			t.Fatal(err)
		}
		revision = saved.Revision
	}

	kept := ready()
	if kept.WorkspaceID != workspace.ID || kept.MaterialID != quiz.ID {
		t.Fatalf("quiz asset scope = %q/%q, want the workspace and the quiz", kept.WorkspaceID, kept.MaterialID)
	}
	dropped := ready()
	pending, _ := reserve()
	usedBefore, reservedBefore := storage()
	save(quizContent(kept.ID))
	if !exists(kept.ID) || exists(dropped.ID) || exists(pending.ID) {
		t.Fatalf("after save kept=%v dropped=%v pending=%v, want only the referenced image",
			exists(kept.ID), exists(dropped.ID), exists(pending.ID))
	}
	if used, reserved := storage(); used != usedBefore-100 || reserved != reservedBefore-100 {
		t.Fatalf("save released %d used and %d reserved bytes, want 100 each",
			usedBefore-used, reservedBefore-reserved)
	}

	op, err := s.TrashMaterial(ctx, ownerID, quiz.ID, "", AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	if !exists(kept.ID) {
		t.Fatal("trashing the quiz deleted its image")
	}
	if _, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindMaterial, quiz.ID, op.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='editor' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	clone, err := s.CloneWorkspace(ctx, clonerID, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	var clonedQuizID, clonedContent, clonedAssetID string
	if err := s.pool.QueryRow(ctx, `SELECT m.id, m.content::text, a.id FROM materials m
		JOIN editor_assets a ON a.material_id=m.id AND a.workspace_id=m.workspace_id
		WHERE m.workspace_id=$1 AND m.kind='quiz'`, clone.ID).Scan(&clonedQuizID, &clonedContent, &clonedAssetID); err != nil {
		t.Fatalf("cloned quiz image: %v", err)
	}
	if clonedAssetID == kept.ID || !strings.Contains(clonedContent, clonedAssetID) {
		t.Fatalf("cloned asset %q, content %s", clonedAssetID, clonedContent)
	}

	usedBefore, _ = storage()
	if err := trashAndPurgeMaterial(ctx, s, ownerID, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if exists(kept.ID) || !exists(clonedAssetID) {
		t.Fatalf("after purge source=%v clone=%v, want only the clone's image", exists(kept.ID), exists(clonedAssetID))
	}
	if used, _ := storage(); used != usedBefore-100 {
		t.Fatalf("purge released %d image bytes, want 100", usedBefore-used)
	}
}
