package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestFilePreviewUsesTheAuthorizedNormalizedPDF(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	registry, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(registry)
	memory := blob.NewMemory()
	handler := httpapi.New(st, memory, nil, nil, "marker", "capy", httpapi.Config{
		AuthDisabled:  true,
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_other"},
		ModelRegistry: registry,
	})

	workspace, err := st.CreateWorkspace(
		ctx, "u_owner", "Preview authorization", store.ColorGreen, []store.TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := st.CreateSourceReady(
		ctx, workspace.ID, "u_owner", "lesson.pptx", "slides", nil, "", 100,
		"sources/lesson.pptx",
	)
	if err != nil {
		t.Fatal(err)
	}
	previewPath := "previews/lesson.pdf"
	if _, _, err := memory.Put(previewPath, bytes.NewReader([]byte("%PDF-preview"))); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx,
		`UPDATE files SET preview_blob_path=$2 WHERE id=$1`, file.ID, previewPath,
	); err != nil {
		t.Fatal(err)
	}

	private := doReq(t, handler, http.MethodGet,
		"/api/files/"+file.ID+"/preview", "u_other", nil)
	if private.Code != http.StatusNotFound {
		t.Fatalf("private preview by nonmember = %d body=%s", private.Code, private.Body.String())
	}

	owner := doReq(t, handler, http.MethodGet,
		"/api/files/"+file.ID+"/preview", "u_owner", nil)
	if owner.Code != http.StatusFound || owner.Header().Get("Location") != "memory://"+previewPath {
		t.Fatalf("owner preview = %d location=%q body=%s",
			owner.Code, owner.Header().Get("Location"), owner.Body.String())
	}

	got := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID, "u_owner", nil)
	if got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"previewUrl":"/api/files/`+file.ID+`/preview"`)) {
		t.Fatalf("file preview contract = %d body=%s", got.Code, got.Body.String())
	}
}

func TestPDFPreviewUsesTheOriginalSourceBlob(t *testing.T) {
	st := openAccessTestStoreForPreview(t)
	ctx := context.Background()
	workspace, err := st.CreateWorkspace(
		ctx, "u_owner", "PDF preview", store.ColorGreen, []store.TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := st.CreateSourceReady(
		ctx, workspace.ID, "u_owner", "paper.pdf", "pdf", nil, "", 20,
		"sources/paper.pdf",
	)
	if err != nil {
		t.Fatal(err)
	}
	path, err := st.FilePreviewBlob(ctx, file.ID)
	if err != nil || path != "sources/paper.pdf" {
		t.Fatalf("PDF preview path = %q err=%v", path, err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE files SET blob_path=NULL WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	withoutBytes, err := st.GetFile(ctx, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if withoutBytes.PreviewURL != nil {
		t.Fatalf("source-less PDF advertised preview URL %q", *withoutBytes.PreviewURL)
	}
}

func openAccessTestStoreForPreview(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.New(context.Background(), testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	registry, err := models.New(context.Background(), st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(registry)
	return st
}
