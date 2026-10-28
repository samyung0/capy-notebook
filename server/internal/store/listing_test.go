package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestEmptyQuizListingHasZeroQuestions(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_empty_quiz_listing")
	if _, err := s.CreateQuiz(ctx, Quiz{UserID: ownerID, Name: "Empty quiz", Questions: json.RawMessage(`[]`)}); err != nil {
		t.Fatal(err)
	}
	result, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Kinds: []string{"quiz"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].QuestionCount == nil || *result.Items[0].QuestionCount != 0 {
		t.Fatalf("empty quiz listing = %+v", result.Items)
	}
}

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
		Content: materialTestContent(t, "# Alpha\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Zulu standalone", Content: materialTestContent(t, "# Zulu\n\nbody"),
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
	// The note's embedded quiz opens only inside the note.
	if len(all.Items) != 2 || all.NextCursor != "" || all.Items[0].ID == embedded.ID || all.Items[1].ID == embedded.ID {
		t.Fatalf("expected the note and the standalone note, got %+v", all.Items)
	}
	memberView, err := s.ListOwnedMaterials(ctx, memberID, MaterialListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(memberView.Items) != 0 {
		t.Fatalf("membership does not surface another owner's materials: %+v", memberView.Items)
	}

	quizzes, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Locations: []string{"workspace"}, Kinds: []string{"quiz"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(quizzes.Items) != 0 {
		t.Fatalf("workspace quizzes = %+v, want no embedded quiz", quizzes.Items)
	}
	standaloneOnly, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Locations: []string{"standalone"}, Kinds: []string{"note"}})
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
	if len(second.Items) != 1 || second.Items[0].ID != standalone.ID || second.NextCursor != "" {
		t.Fatalf("second page = %+v", second)
	}

	file, err := s.createReadyFile(ctx, ws.ID, ownerID, "notes.md", "md", nil, "", 4096, "sources/"+uid("blob")+"/notes.md")
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
	// Workspace order resumes across pages by workspace name; a standalone
	// material has none and comes first ascending.
	byWorkspace, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Sort: "workspace", Ascending: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(byWorkspace.Items) != 1 || byWorkspace.Items[0].ID != standalone.ID || byWorkspace.NextCursor == "" {
		t.Fatalf("first workspace page = %+v", byWorkspace)
	}
	byWorkspace, err = s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Sort: "workspace", Ascending: true, Limit: 1, Cursor: byWorkspace.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(byWorkspace.Items) != 1 || byWorkspace.Items[0].ID != note.ID {
		t.Fatalf("second workspace page = %+v", byWorkspace)
	}
	other, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Archive", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	otherFile, err := s.createReadyFile(ctx, other.ID, ownerID, "old.md", "md", nil, "", 10, "sources/"+uid("blob")+"/old.md")
	if err != nil {
		t.Fatal(err)
	}
	filePage, err := s.ListOwnedFiles(ctx, ownerID, FileListFilter{Sort: "workspace", Ascending: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(filePage.Items) != 1 || filePage.Items[0].ID != otherFile.ID || filePage.NextCursor == "" {
		t.Fatalf("first file workspace page = %+v", filePage)
	}
	filePage, err = s.ListOwnedFiles(ctx, ownerID, FileListFilter{Sort: "workspace", Ascending: true, Limit: 1, Cursor: filePage.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(filePage.Items) != 1 || filePage.Items[0].ID != file.ID || filePage.NextCursor != "" {
		t.Fatalf("second file workspace page = %+v", filePage)
	}

	memberFiles, err := s.ListOwnedFiles(ctx, memberID, FileListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(memberFiles.Items) != 0 {
		t.Fatalf("membership does not surface another owner's files: %+v", memberFiles.Items)
	}

	// Member scope adds the workspaces the caller belongs to, never another
	// owner's standalone rows, and hides a deletion-pending owner's workspace.
	shared, err := s.ListOwnedMaterials(ctx, memberID, MaterialListFilter{
		Member: true, Locations: []string{"workspace", "standalone"}, Kinds: []string{"note", "quiz", "mindmap"}, Sort: "title", Ascending: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(shared.Items) != 2 || shared.Items[0].ID != note.ID || shared.Items[1].Title != "Map" {
		t.Fatalf("member materials = %+v", shared.Items)
	}
	sharedFiles, err := s.ListOwnedFiles(ctx, memberID, FileListFilter{Member: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(sharedFiles.Items) != 1 || sharedFiles.Items[0].ID != file.ID {
		t.Fatalf("member files = %+v", sharedFiles.Items)
	}
	// The quick open's ids filter keeps the asked rows the caller can open: another
	// owner's standalone note stays out.
	picked, err := s.ListOwnedMaterials(ctx, memberID, MaterialListFilter{
		Member: true, IDs: []string{note.ID, standalone.ID}, Locations: []string{"workspace", "standalone"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(picked.Items) != 1 || picked.Items[0].ID != note.ID {
		t.Fatalf("materials by id = %+v", picked.Items)
	}
	pickedFiles, err := s.ListOwnedFiles(ctx, ownerID, FileListFilter{Member: true, IDs: []string{otherFile.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if len(pickedFiles.Items) != 1 || pickedFiles.Items[0].ID != otherFile.ID {
		t.Fatalf("files by id = %+v", pickedFiles.Items)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now() WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	hidden, err := s.ListOwnedMaterials(ctx, memberID, MaterialListFilter{Member: true})
	if err != nil {
		t.Fatal(err)
	}
	hiddenFiles, err := s.ListOwnedFiles(ctx, memberID, FileListFilter{Member: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(hidden.Items) != 0 || len(hiddenFiles.Items) != 0 {
		t.Fatalf("deletion-pending owner still listed: %+v %+v", hidden.Items, hiddenFiles.Items)
	}
}

// The Files page's All files (Epo 2026-10-28): what the caller pays for plus
// every file of its own and member workspaces, never a link workspace it
// only opened, each row with what the caller may do with it.
func TestAllFilesAddsMemberWorkspacesWithEachRowsRights(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_all_owner")
	member := newBlobTestUser(t, s, "u_all_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	link, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "By link", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`,
		ws.ID, member); err != nil {
		t.Fatal(err)
	}
	theirs := uploadWorkspaceFile(t, s, owner, ws.ID)
	mine := uploadWorkspaceFile(t, s, member, ws.ID)
	standalone := uploadStandaloneFile(t, s, member, 1024)
	linked := uploadWorkspaceFile(t, s, owner, link.ID)
	// A viewer now: it still pays for its upload.
	for _, q := range []string{
		`UPDATE workspace_members SET role='viewer' WHERE workspace_id='` + ws.ID + `' AND user_id='` + member + `'`,
		`UPDATE workspaces SET privacy='link' WHERE id='` + link.ID + `'`,
		`INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ('` + link.ID + `', '` + member + `')`,
	} {
		if _, err := s.pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RecordWorkspaceVisit(ctx, member, link.ID); err != nil {
		t.Fatal(err)
	}

	listed := func(f FileListFilter) map[string]FileRights {
		t.Helper()
		page, err := s.ListOwnedFiles(ctx, member, f)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]FileRights{}
		for _, file := range page.Items {
			if file.Rights == nil {
				t.Fatalf("%s listed without rights", file.ID)
			}
			out[file.ID] = *file.Rights
		}
		return out
	}
	if mineOnly := listed(FileListFilter{}); len(mineOnly) != 2 || !mineOnly[standalone.ID].Rename {
		t.Fatalf("My files = %+v, want the two the member pays for", mineOnly)
	}
	all := listed(FileListFilter{All: true})
	if _, ok := all[linked.ID]; ok || len(all) != 3 {
		t.Fatalf("All files = %+v, want its own two and the member workspace's other file", all)
	}
	for id, want := range map[string]FileRights{
		theirs.ID:     {Clone: true},
		mine.ID:       {Trash: true, Move: true, Clone: true},
		standalone.ID: {Rename: true, Trash: true, Move: true, Clone: true},
	} {
		if all[id] != want {
			t.Fatalf("rights of %s = %+v, want %+v", id, all[id], want)
		}
	}
	if inWorkspaces := listed(FileListFilter{All: true, Locations: []string{"workspace"}}); len(inWorkspaces) != 2 {
		t.Fatalf("All files in workspaces = %+v, want the member workspace's two", inWorkspaces)
	}
}
