package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// TestMaterialWritersStorePreview: each Go writer of materials.content stores
// the list-card preview with it, and the workspace list returns it.
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
	refs, err := s.ListMaterialRefs(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || string(refs[0].Preview) == "" {
		t.Fatalf("material refs = %+v, want the stored preview", refs)
	}
	clone, err := s.CloneMaterial(ctx, ownerID, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := previewText(clone.ID); got != "Updated" {
		t.Fatalf("cloned preview = %q", got)
	}
}
