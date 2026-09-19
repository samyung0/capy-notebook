package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestOwnedMaterialListingScopesFiltersAndPages(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_list_owner")
	memberID := newBlobTestUser(t, s, "u_list_member")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Listing", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`,
		ws.ID, memberID); err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Alpha note",
		Content: "# Alpha\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"True?","correct":true}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Zulu standalone", Content: "# Zulu\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "mindmap", Title: "Map",
		Content: "```mermaid\nmindmap\n  root\n```",
	}); err != nil {
		t.Fatal(err)
	}

	all, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Items) != 3 || all.NextCursor != "" {
		t.Fatalf("expected the note, its quiz and the standalone note, got %+v", all.Items)
	}
	for _, item := range all.Items {
		if item.ID == embedded.ID {
			if item.ParentMaterialID != note.ID || item.ParentTitle != "Alpha note" || item.QuestionCount == nil || *item.QuestionCount != 1 {
				t.Fatalf("embedded row = %+v", item)
			}
		}
	}
	memberView, err := s.ListOwnedMaterials(ctx, memberID, MaterialListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(memberView.Items) != 0 {
		t.Fatalf("membership does not surface another owner's materials: %+v", memberView.Items)
	}

	embeddedOnly, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Location: "embedded"})
	if err != nil {
		t.Fatal(err)
	}
	if len(embeddedOnly.Items) != 1 || embeddedOnly.Items[0].ID != embedded.ID {
		t.Fatalf("embedded filter = %+v", embeddedOnly.Items)
	}
	standaloneOnly, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Location: "standalone", Kinds: []string{"note"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(standaloneOnly.Items) != 1 || standaloneOnly.Items[0].ID != standalone.ID {
		t.Fatalf("standalone filter = %+v", standaloneOnly.Items)
	}

	// Title order, one row per page, cursor resumes after the served row.
	first, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Sort: "title", Ascending: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 || first.Items[0].Title != "Alpha note" || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	second, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Sort: "title", Ascending: true, Limit: 1, Cursor: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != embedded.ID {
		t.Fatalf("second page = %+v", second.Items)
	}
	third, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Sort: "title", Ascending: true, Limit: 1, Cursor: second.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(third.Items) != 1 || third.Items[0].ID != standalone.ID || third.NextCursor != "" {
		t.Fatalf("third page = %+v", third)
	}

	file, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "notes.md", "md", nil, "", 4096, "sources/"+uid("blob")+"/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	files, err := s.ListOwnedFiles(ctx, ownerID, FileListFilter{Kinds: []string{"md"}, Sort: "size", Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(files.Items) != 1 || files.Items[0].ID != file.ID || files.NextCursor != "" {
		t.Fatalf("owned files = %+v", files)
	}
	memberFiles, err := s.ListOwnedFiles(ctx, memberID, FileListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(memberFiles.Items) != 0 {
		t.Fatalf("membership does not surface another owner's files: %+v", memberFiles.Items)
	}
}
