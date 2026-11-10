package store

import (
	"context"
	"slices"
	"testing"
)

// The Files page lists files and blocks as one list that sorts, filters and
// pages across both (Epo 2026-11-09).
func TestItemsListFilesAndBlocksAsOneList(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_items_owner")
	member := newBlobTestUser(t, s, "u_items_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Items", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`,
		ws.ID, member); err != nil {
		t.Fatal(err)
	}
	standaloneFile := uploadStandaloneFile(t, s, owner, 1024) // archive.zip
	wsFile := uploadWorkspaceFile(t, s, owner, ws.ID)         // notes.zip
	memberFile := uploadWorkspaceFile(t, s, member, ws.ID)
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Alpha note",
		Content: materialTestContent(t, "# Alpha\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	standaloneNote, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, Kind: "note", Title: "Zulu standalone", Content: materialTestContent(t, "# Zulu\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}

	ids := func(f ItemListFilter) []string {
		t.Helper()
		page, err := s.ListItems(ctx, owner, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, item := range page.Items {
			switch item.Type {
			case ItemFile:
				out = append(out, item.File.ID)
			case ItemMaterial:
				out = append(out, item.Material.ID)
			default:
				t.Fatalf("unexpected %s row", item.Type)
			}
		}
		return out
	}

	byName := ids(ItemListFilter{Sort: "name", Ascending: true})
	if want := []string{note.ID, standaloneFile.ID, wsFile.ID, standaloneNote.ID}; !slices.Equal(byName, want) {
		t.Fatalf("by name = %v, want %v", byName, want)
	}
	// One per page, newest first, the cursor carrying across tables.
	var paged []string
	for cursor := ""; ; {
		page, err := s.ListItems(ctx, owner, ItemListFilter{Limit: 1, Cursor: cursor})
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page after %q = %+v, %v", cursor, page.Items, err)
		}
		paged = append(paged, ids(ItemListFilter{Limit: 1, Cursor: cursor})...)
		if cursor = page.NextCursor; cursor == "" {
			break
		}
	}
	if want := ids(ItemListFilter{}); len(paged) != 4 || !slices.Equal(paged, want) {
		t.Fatalf("paged %v, want %v", paged, want)
	}
	if notes := ids(ItemListFilter{Kinds: []string{"note"}}); len(notes) != 2 || slices.Contains(notes, wsFile.ID) {
		t.Fatalf("notes = %v", notes)
	}
	standalone := ids(ItemListFilter{Locations: []string{"standalone"}, Sort: "name", Ascending: true})
	if want := []string{standaloneFile.ID, standaloneNote.ID}; !slices.Equal(standalone, want) {
		t.Fatalf("standalone = %v, want %v", standalone, want)
	}
	if all := ids(ItemListFilter{All: true}); len(all) != 5 || !slices.Contains(all, memberFile.ID) {
		t.Fatalf("All files = %v, want the member's upload too", all)
	}
}

// A name or title may hold a bar; the cursor still resumes after that row.
func TestListCursorKeepsABarInTheName(t *testing.T) {
	primary, id, ok, err := decodeListCursor(encodeListCursor("a|b", "material:m_1"))
	if err != nil || !ok || primary != "a|b" || id != "material:m_1" {
		t.Fatalf("decoded %q, %q (%v, %v)", primary, id, ok, err)
	}
}
