package store

import (
	"context"
	"testing"
)

// Source bodies are unbounded and the file list is polled, so the list carries
// refs only. Single-file reads still return the body; the viewer reads it there.
func TestListFilesOmitsContentGetFileKeepsIt(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_file_list_content")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Content workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "notes.md", "md", nil, "", 4096, "sources/"+uid("blob")+"/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	const body = "# notes\n\nthe body the list must not ship"
	if _, err := s.pool.Exec(ctx, `UPDATE files SET content=$2 WHERE id=$1`, file.ID, body); err != nil {
		t.Fatal(err)
	}

	files, err := s.ListFiles(ctx, "", ws.ID)
	if err != nil || len(files) != 1 {
		t.Fatalf("ListFiles = %v, %v", files, err)
	}
	if files[0].Content != nil {
		t.Fatalf("workspace list carried content: %q", *files[0].Content)
	}
	// The user-wide branch is a separate query; it must make the same promise.
	owned, err := s.ListFiles(ctx, ownerID, "")
	if err != nil || len(owned) != 1 {
		t.Fatalf("ListFiles(user) = %v, %v", owned, err)
	}
	if owned[0].Content != nil {
		t.Fatalf("user list carried content: %q", *owned[0].Content)
	}
	if owned[0].ID != file.ID {
		t.Fatalf("user list id = %q, want %q", owned[0].ID, file.ID)
	}

	got, err := s.GetFile(ctx, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content == nil || *got.Content != body {
		t.Fatalf("GetFile content = %v, want %q", got.Content, body)
	}
}
