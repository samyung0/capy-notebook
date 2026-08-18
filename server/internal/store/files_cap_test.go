package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func seedWorkspaceFiles(t *testing.T, s *Store, wsID, ownerID string, n int) {
	t.Helper()
	ctx := context.Background()
	for i := range n {
		_, err := s.CreateSourceReady(ctx, wsID, ownerID,
			fmt.Sprintf("f%d.pdf", i), "pdf", nil, "", 1, "sources/"+uid("f"))
		if err != nil {
			t.Fatalf("seed file %d: %v", i, err)
		}
	}
}

func TestWorkspaceFileCapRejectsThe101stFile(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_files")
	ws, err := s.CreateWorkspace(ctx, owner, "Cap", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	seedWorkspaceFiles(t, s, ws.ID, owner, MaxFilesPerWorkspace)

	_, err = s.CreateSourceReady(ctx, ws.ID, owner, "overflow.pdf", "pdf",
		nil, "", 1, "sources/"+uid("f"))
	var limit *FileLimitExceededError
	if !errors.As(err, &limit) {
		t.Fatalf("err = %v, want FileLimitExceededError", err)
	}
	if limit.Kind != "workspace" || limit.Code() != "files_limit_exceeded" {
		t.Fatalf("kind=%s code=%s", limit.Kind, limit.Code())
	}
	if limit.Limit != MaxFilesPerWorkspace {
		t.Fatalf("limit = %d, want %d", limit.Limit, MaxFilesPerWorkspace)
	}
}

func TestPendingUploadSessionsOccupyFileSlots(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_slot")
	ws, err := s.CreateWorkspace(ctx, owner, "Slots", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	seedWorkspaceFiles(t, s, ws.ID, owner, MaxFilesPerWorkspace-1)

	_, err = s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "held.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 1, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "blocked.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 1, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	var limit *FileLimitExceededError
	if !errors.As(err, &limit) || limit.Kind != "workspace" {
		t.Fatalf("err = %v, want workspace file cap", err)
	}
}

func TestExpiredUploadSessionsDoNotOccupyFileSlots(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_exp")
	ws, err := s.CreateWorkspace(ctx, owner, "Expired", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	seedWorkspaceFiles(t, s, ws.ID, owner, MaxFilesPerWorkspace-1)

	_, err = s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "stale.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 1, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "ok.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 1, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("expired session still occupied a slot: %v", err)
	}
}

func TestFileBatchCapRejectsMoreThanTwenty(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_batch")
	ws, err := s.CreateWorkspace(ctx, owner, "Batch", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}

	err = s.AssertWorkspaceFileRoom(ctx, ws.ID, MaxFilesPerUpload+1)
	var limit *FileLimitExceededError
	if !errors.As(err, &limit) {
		t.Fatalf("err = %v, want FileLimitExceededError", err)
	}
	if limit.Kind != "batch" || limit.Code() != "files_batch_exceeded" {
		t.Fatalf("kind=%s code=%s", limit.Kind, limit.Code())
	}
	if limit.Limit != MaxFilesPerUpload {
		t.Fatalf("limit = %d, want %d", limit.Limit, MaxFilesPerUpload)
	}
}

func TestWorkspacePayloadReportsFileLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_lim")
	ws, err := s.CreateWorkspace(ctx, owner, "Limit", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetWorkspace(ctx, owner, ws.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.FilesLimit != MaxFilesPerWorkspace {
		t.Fatalf("filesLimit = %d, want %d", got.FilesLimit, MaxFilesPerWorkspace)
	}
	if got.FileCount != 0 {
		t.Fatalf("fileCount = %d, want 0", got.FileCount)
	}
}
