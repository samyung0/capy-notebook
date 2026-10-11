package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// TestMaterialWritersStorePreview: each Go writer of materials.content stores
// the list-card preview with it, and the material list returns it.
func TestMaterialWritersStorePreview(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_preview")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Preview workspace", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note := func(text string) string {
		t.Helper()
		content, err := materialdoc.Marshal(materialdoc.Envelope{
			SchemaVersion: materialdoc.SchemaVersion,
			Value: []map[string]any{
				{"type": "p", "id": "p1", "children": []any{map[string]any{"text": text}}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return content
	}
	previewText := func(id string) string {
		t.Helper()
		var text string
		if err := s.pool.QueryRow(ctx, `SELECT COALESCE(preview->'blocks'->0->>'text', '')
			FROM materials WHERE id=$1`, id).Scan(&text); err != nil {
			t.Fatal(err)
		}
		return text
	}

	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
		Kind: "note", Title: "Preview note", Content: note("Created"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := previewText(material.ID); got != "Created" {
		t.Fatalf("created preview = %q", got)
	}
	updated := note("Updated")
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{Content: &updated, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if got := previewText(material.ID); got != "Updated" {
		t.Fatalf("updated preview = %q", got)
	}
	page, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || string(page.Items[0].Preview) == "" {
		t.Fatalf("material list = %+v, want the stored preview", page.Items)
	}
	clone, err := s.CloneMaterial(ctx, ownerID, material.ID, CloneTarget{Name: "Clone"})
	if err != nil {
		t.Fatal(err)
	}
	if got := previewText(clone.ID); got != "Updated" {
		t.Fatalf("cloned preview = %q", got)
	}
}

// TestBackfillMaterialPreviews: the one-shot backfill fills a material written
// without a preview, and a rerun finds nothing left to fill.
func TestBackfillMaterialPreviews(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_backfill")
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Old note", Privacy: "private",
		Content: `{"schemaVersion":1,"value":[{"type":"p","id":"p1","children":[{"text":"Before 0073"}]}]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET preview=NULL WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.BackfillMaterialPreviews(ctx, 2); err != nil {
		t.Fatal(err)
	}
	var text string
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(preview->'blocks'->0->>'text', '')
		FROM materials WHERE id=$1`, material.ID).Scan(&text); err != nil {
		t.Fatal(err)
	}
	if text != "Before 0073" {
		t.Fatalf("backfilled preview text = %q", text)
	}
	if filled, _, err := s.BackfillMaterialPreviews(ctx, 2); err != nil || filled != 0 {
		t.Fatalf("rerun filled %d, %v; want nothing left", filled, err)
	}
}
