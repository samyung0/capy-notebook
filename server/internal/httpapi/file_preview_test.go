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

func TestFileLinksPresignTheAuthorizedNormalizedPDF(t *testing.T) {
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
	handler := httpapi.New(st, memory, nil, nil, "mineru", httpapi.Config{
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

	if _, _, err := memory.Put("sources/lesson.pptx", bytes.NewReader([]byte("PK-source"))); err != nil {
		t.Fatal(err)
	}

	private := doReq(t, handler, http.MethodGet,
		"/api/files/"+file.ID+"/links", "u_other", nil)
	if private.Code != http.StatusNotFound {
		t.Fatalf("private links by nonmember = %d body=%s", private.Code, private.Body.String())
	}

	owner := doReq(t, handler, http.MethodGet,
		"/api/files/"+file.ID+"/links", "u_owner", nil)
	if owner.Code != http.StatusOK ||
		!bytes.Contains(owner.Body.Bytes(), []byte(`"url":"memory://sources/lesson.pptx"`)) ||
		!bytes.Contains(owner.Body.Bytes(), []byte(`"previewUrl":"memory://`+previewPath+`"`)) {
		t.Fatalf("owner links = %d body=%s", owner.Code, owner.Body.String())
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
	source, preview, err := st.FileBlobPaths(ctx, file.ID)
	if err != nil || source != "sources/paper.pdf" || preview != "sources/paper.pdf" {
		t.Fatalf("PDF blob paths = %q, %q err=%v", source, preview, err)
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

func TestSourceSessionViewTrimsStateToUnpublishedEdits(t *testing.T) {
	ctx := context.Background()
	st := openAccessTestStoreForPreview(t)
	memory := blob.NewMemory()
	handler := httpapi.New(st, memory, nil, nil, "mineru", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner"},
	})
	workspace, err := st.CreateWorkspace(ctx, "u_owner", "View trim", store.ColorGreen, []store.TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := st.CreateSourceReady(ctx, workspace.ID, "u_owner", "book.xlsx", "sheet", nil, "", 100, "sources/book.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := memory.Put("sources/book.xlsx", bytes.NewReader([]byte("PK-source"))); err != nil {
		t.Fatal(err)
	}
	// Never edited: the view answers from the file row alone and creates nothing.
	current := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil)
	if current.Code != http.StatusOK ||
		!bytes.Contains(current.Body.Bytes(), []byte(`"state":null`)) ||
		!bytes.Contains(current.Body.Bytes(), []byte(`"indexedState":null`)) ||
		!bytes.Contains(current.Body.Bytes(), []byte(`"sourceURL":"memory://sources/book.xlsx"`)) {
		t.Fatalf("current view session = %d body=%s", current.Code, current.Body.String())
	}
	var rows int
	if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM source_documents WHERE file_id=$1`, file.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("view created %d source_documents rows err=%v", rows, err)
	}
	// The editor read creates the row; a saved checkpoint ahead of the index then rides along.
	if editor := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil); editor.Code != http.StatusOK {
		t.Fatalf("editor session = %d body=%s", editor.Code, editor.Body.String())
	}
	if published := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil); published.Code != http.StatusOK ||
		!bytes.Contains(published.Body.Bytes(), []byte(`"state":null`)) {
		t.Fatalf("published row view session = %d body=%s", published.Code, published.Body.String())
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE source_documents SET checkpoint=checkpoint+1,state='\x01' WHERE file_id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	edited := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil)
	if edited.Code != http.StatusOK ||
		!bytes.Contains(edited.Body.Bytes(), []byte(`"state":"AQ=="`)) ||
		!bytes.Contains(edited.Body.Bytes(), []byte(`"indexedState":null`)) ||
		!bytes.Contains(edited.Body.Bytes(), []byte(`"pendingEffects":null`)) {
		t.Fatalf("edited view session = %d body=%s", edited.Code, edited.Body.String())
	}
	full := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil)
	if full.Code != http.StatusOK || bytes.Contains(full.Body.Bytes(), []byte(`"pendingEffects":null`)) {
		t.Fatalf("editor session must stay untrimmed = %d body=%s", full.Code, full.Body.String())
	}
}
