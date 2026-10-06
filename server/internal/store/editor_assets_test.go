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

// editorAssetFixture uploads ready editor assets through materials and reads
// back their rows and the payer's storage.
type editorAssetFixture struct {
	t   *testing.T
	s   *Store
	ctx context.Context
}

func (f editorAssetFixture) reserve(actorID, workspaceID, materialID string) (EditorAsset, EditorAssetUpload) {
	f.t.Helper()
	assetID, uploadID := uid("asset"), uid("eau")
	asset, upload, err := f.s.CreateEditorAssetReservation(f.ctx, NewEditorAssetReservation{
		AssetID: assetID, UploadID: uploadID, WorkspaceID: workspaceID, MaterialID: materialID, CreatedBy: actorID,
		Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uploadID,
		FinalPath: "editor-assets/" + assetID, ContentType: "image/png", DeclaredSize: 100,
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return asset, upload
}

// ready uploads an asset completed two minutes ago, past the prune grace.
func (f editorAssetFixture) ready(actorID, workspaceID, materialID string) EditorAsset {
	f.t.Helper()
	asset := f.fresh(actorID, workspaceID, materialID)
	if _, err := f.s.pool.Exec(f.ctx, `UPDATE editor_assets
		SET completed_at=now()-interval '2 minutes' WHERE id=$1`, asset.ID); err != nil {
		f.t.Fatal(err)
	}
	return asset
}

func (f editorAssetFixture) fresh(actorID, workspaceID, materialID string) EditorAsset {
	f.t.Helper()
	_, upload := f.reserve(actorID, workspaceID, materialID)
	asset, err := f.s.FinalizeEditorAssetUpload(f.ctx, upload.ID, "etag")
	if err != nil {
		f.t.Fatal(err)
	}
	return asset
}

func (f editorAssetFixture) exists(assetID string) bool {
	f.t.Helper()
	var found bool
	if err := f.s.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM editor_assets WHERE id=$1)`,
		assetID).Scan(&found); err != nil {
		f.t.Fatal(err)
	}
	return found
}

func (f editorAssetFixture) used(userID string) int64 {
	f.t.Helper()
	var used int64
	if err := f.s.pool.QueryRow(f.ctx, `SELECT used_bytes FROM user_storage WHERE user_id=$1`,
		userID).Scan(&used); err != nil {
		f.t.Fatal(err)
	}
	return used
}

func quizWithImages(t *testing.T, assetIDs ...string) string {
	t.Helper()
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

func noteWithImages(t *testing.T, assetIDs ...string) string {
	t.Helper()
	value := []map[string]any{materialdoc.ParagraphNode("Look.")}
	for _, id := range assetIDs {
		value = append(value, map[string]any{
			"type": "img", "id": "img-" + id, "assetId": id,
			"children": []any{map[string]any{"text": ""}},
		})
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: value})
	if err != nil {
		t.Fatal(err)
	}
	return content
}

// A workspace note's or quiz's assets name it: a save deletes the ready ones it
// no longer references once they are a minute old (pending and fresh ones
// stay), trashing keeps them, a workspace clone carries them to the cloned
// material, and purging deletes them, releasing their bytes each time.
func TestWorkspaceEditorAssetsFollowTheirMaterial(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	for kind, content := range map[MaterialKind]func(*testing.T, ...string) string{
		"note": noteWithImages, "quiz": quizWithImages,
	} {
		t.Run(string(kind), func(t *testing.T) {
			f.t = t
			ownerID := newBlobTestUser(t, s, "u_asset_owner")
			clonerID := newBlobTestUser(t, s, "u_asset_cloner")
			workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Figures", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			material, err := s.CreateMaterial(ctx, Material{
				CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
				Kind: kind, Title: "Figures", Content: content(t),
			})
			if err != nil {
				t.Fatal(err)
			}

			kept := f.ready(ownerID, workspace.ID, material.ID)
			if kept.WorkspaceID != workspace.ID || kept.MaterialID != material.ID {
				t.Fatalf("asset scope = %q/%q, want the workspace and the material", kept.WorkspaceID, kept.MaterialID)
			}
			dropped := f.ready(ownerID, workspace.ID, material.ID)
			fresh := f.fresh(ownerID, workspace.ID, material.ID)
			pending, _ := f.reserve(ownerID, workspace.ID, material.ID)
			usedBefore := f.used(ownerID)
			next := content(t, kept.ID)
			if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
				Content: &next, UpdatedBy: ownerID, ExpectedRevision: &material.Revision,
			}); err != nil {
				t.Fatal(err)
			}
			if !f.exists(kept.ID) || f.exists(dropped.ID) || !f.exists(fresh.ID) || !f.exists(pending.ID) {
				t.Fatalf("after save kept=%v dropped=%v fresh=%v pending=%v, want only the old unreferenced one gone",
					f.exists(kept.ID), f.exists(dropped.ID), f.exists(fresh.ID), f.exists(pending.ID))
			}
			if used := f.used(ownerID); used != usedBefore-100 {
				t.Fatalf("save released %d bytes, want 100", usedBefore-used)
			}

			op, err := s.TrashMaterial(ctx, ownerID, material.ID, "", AgentOperation{})
			if err != nil {
				t.Fatal(err)
			}
			if !f.exists(kept.ID) {
				t.Fatal("trashing deleted the material's asset")
			}
			if _, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindMaterial, material.ID, op.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
				t.Fatal(err)
			}

			if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='editor' WHERE id=$1`, workspace.ID); err != nil {
				t.Fatal(err)
			}
			clone, err := s.CloneWorkspace(ctx, clonerID, workspace.ID)
			if err != nil {
				t.Fatal(err)
			}
			var clonedContent, clonedAssetID string
			if err := s.pool.QueryRow(ctx, `SELECT m.content::text, a.id FROM materials m
				JOIN editor_assets a ON a.material_id=m.id AND a.workspace_id=m.workspace_id
				WHERE m.workspace_id=$1 AND a.completed_at < now()-interval '1 minute'`, clone.ID).
				Scan(&clonedContent, &clonedAssetID); err != nil {
				t.Fatalf("cloned asset: %v", err)
			}
			if clonedAssetID == kept.ID || !strings.Contains(clonedContent, clonedAssetID) {
				t.Fatalf("cloned asset %q, content %s", clonedAssetID, clonedContent)
			}

			usedBefore = f.used(ownerID)
			if err := trashAndPurgeMaterial(ctx, s, ownerID, material.ID); err != nil {
				t.Fatal(err)
			}
			if f.exists(kept.ID) || f.exists(fresh.ID) || f.exists(pending.ID) || !f.exists(clonedAssetID) {
				t.Fatal("purge should delete every asset of the material and keep the clone's")
			}
			if used := f.used(ownerID); used != usedBefore-200 {
				t.Fatalf("purge released %d bytes, want 200", usedBefore-used)
			}
		})
	}
}

// A standalone clone of a note gives each image to the copy of the material
// that uses it: the note's to the cloned note, the embedded quiz's to the
// cloned quiz, so a save of the cloned note keeps the quiz's images.
func TestStandaloneNoteCloneKeepsImagesWithTheirMaterial(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	ownerID := newBlobTestUser(t, s, "u_clone_asset_owner")
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "note", Title: "Note", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	noteImage := f.ready(ownerID, "", note.ID)
	quizImage := f.ready(ownerID, "", quiz.ID)
	quizContent := quizWithImages(t, quizImage.ID)
	if _, err := s.UpdateMaterial(ctx, quiz.ID, MaterialPatch{Content: &quizContent, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	noteContent := noteWithImages(t, noteImage.ID)
	refs := noteWithRefs(t, quiz)
	var value []map[string]any
	for _, raw := range []string{noteContent, refs} {
		doc, err := materialdoc.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		value = append(value, doc.Value...)
	}
	noteContent, err = materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: value})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &noteContent, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneMaterial(ctx, ownerID, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	homes := map[string]string{}
	rows, err := s.pool.Query(ctx, `SELECT a.object_path, m.kind FROM editor_assets a
		JOIN materials m ON m.id=a.material_id WHERE m.id=$1 OR m.parent_material_id=$1`, clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var path, kind string
		if err := rows.Scan(&path, &kind); err != nil {
			t.Fatal(err)
		}
		homes[path] = kind
	}
	rows.Close()
	if homes[noteImage.ObjectPath] != "note" || homes[quizImage.ObjectPath] != "quiz" {
		t.Fatalf("cloned asset homes = %v, want the note's image on the note and the quiz's on the quiz", homes)
	}
}

// Adopting gives the target material its own copy of a readable ready asset
// (same stored object, charged to the target's payer), returns the target's
// own asset unchanged, leaves out what cannot be adopted, and refuses
// non-editors and copies over quota.
func TestAdoptEditorAssets(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	ownerID := newBlobTestUser(t, s, "u_adopt_owner")
	strangerID := newBlobTestUser(t, s, "u_adopt_stranger")
	viewerID := newBlobTestUser(t, s, "u_adopt_viewer")
	workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Adopt", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, workspace.ID, viewerID); err != nil {
		t.Fatal(err)
	}
	newNote := func(title string) Material {
		note, err := s.CreateMaterial(ctx, Material{
			CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
			Kind: "note", Title: title, Content: noteWithImages(t),
		})
		if err != nil {
			t.Fatal(err)
		}
		return note
	}
	source, target := newNote("Source"), newNote("Target")
	foreignNote, err := s.CreateMaterial(ctx, Material{CreatedBy: strangerID, Kind: "note", Title: "Foreign", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	own := f.ready(ownerID, workspace.ID, target.ID)
	readable := f.ready(ownerID, workspace.ID, source.ID)
	pending, _ := f.reserve(ownerID, workspace.ID, source.ID)
	deleted := f.ready(ownerID, workspace.ID, source.ID)
	if _, err := s.pool.Exec(ctx, `DELETE FROM editor_assets WHERE id=$1`, deleted.ID); err != nil {
		t.Fatal(err)
	}
	foreign := f.ready(strangerID, "", foreignNote.ID)

	usedBefore := f.used(ownerID)
	adopted, err := s.AdoptEditorAssets(ctx, ownerID, workspace.ID, target.ID,
		[]string{own.ID, readable.ID, pending.ID, deleted.ID, foreign.ID, "asset_unknown"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(adopted) != 2 || adopted[own.ID] != own.ID || adopted[readable.ID] == "" || adopted[readable.ID] == readable.ID {
		t.Fatalf("adopted = %v, want the own asset unchanged and one copy", adopted)
	}
	copied, err := s.GetEditorAsset(ctx, adopted[readable.ID])
	if err != nil {
		t.Fatal(err)
	}
	if copied.WorkspaceID != workspace.ID || copied.MaterialID != target.ID || copied.Status != "ready" ||
		copied.ObjectPath != readable.ObjectPath || copied.UserID != ownerID {
		t.Fatalf("copy = %+v", copied)
	}
	if refs := blobRefCount(t, s, readable.ObjectPath); refs != 2 {
		t.Fatalf("blob refs = %d, want the copy sharing the source object", refs)
	}
	if used := f.used(ownerID); used != usedBefore+100 {
		t.Fatalf("adopt charged %d bytes, want 100", used-usedBefore)
	}

	// A link-shared standalone note's images become readable, so adoptable.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='link' WHERE id=$1`, foreignNote.ID); err != nil {
		t.Fatal(err)
	}
	if adopted, err := s.AdoptEditorAssets(ctx, ownerID, workspace.ID, target.ID, []string{foreign.ID}, 0); err != nil || adopted[foreign.ID] == "" {
		t.Fatalf("adopt shared foreign asset = %v, %v", adopted, err)
	}

	// A quiz's image cap leaves out a larger image.
	if adopted, err := s.AdoptEditorAssets(ctx, ownerID, workspace.ID, target.ID, []string{readable.ID}, 50); err != nil || adopted[readable.ID] != "" {
		t.Fatalf("adopt over the image cap = %v, %v; want it left out", adopted, err)
	}

	if _, err := s.AdoptEditorAssets(ctx, viewerID, workspace.ID, target.ID, []string{readable.ID}, 0); err == nil {
		t.Fatal("a viewer adopted into the note")
	}
	limit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`, ownerID, limit); err != nil {
		t.Fatal(err)
	}
	var quota *QuotaExceededError
	if _, err := s.AdoptEditorAssets(ctx, ownerID, workspace.ID, target.ID, []string{readable.ID}, 0); !errors.As(err, &quota) {
		t.Fatalf("adopt over quota err = %v, want quota exceeded", err)
	}
}
