package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestOfficeFileLinksPresignTheAuthorizedEditableSource(t *testing.T) {
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
	handler := httpapi.New(st, memory, nil, nil, "opendataloader", httpapi.Config{
		AuthDisabled:  true,
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_other"},
		ModelRegistry: registry,
	})

	workspace, err := st.CreateWorkspace(
		ctx, "u_owner", store.WorkspaceCreate{Name: "Preview authorization", Tags: []store.TagRef{}},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := uploadSource(
		ctx, st, workspace.ID, "u_owner", "lesson.pptx", 100,
		"sources/lesson.pptx",
	)
	if err != nil {
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
		bytes.Contains(owner.Body.Bytes(), []byte(`"previewUrl"`)) {
		t.Fatalf("owner links = %d body=%s", owner.Code, owner.Body.String())
	}

	got := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID, "u_owner", nil)
	if got.Code != http.StatusOK || bytes.Contains(got.Body.Bytes(), []byte(`"previewUrl"`)) {
		t.Fatalf("file preview contract = %d body=%s", got.Code, got.Body.String())
	}
}

func TestPDFPreviewUsesTheOriginalSourceBlob(t *testing.T) {
	st := openAccessTestStoreForPreview(t)
	ctx := context.Background()
	workspace, err := st.CreateWorkspace(
		ctx, "u_owner", store.WorkspaceCreate{Name: "PDF preview", Tags: []store.TagRef{}},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := uploadSource(
		ctx, st, workspace.ID, "u_owner", "paper.pdf", 20,
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
	handler := httpapi.New(st, memory, nil, nil, "opendataloader", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner"},
	})
	workspace, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "View trim", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := uploadSource(ctx, st, workspace.ID, "u_owner", "book.xlsx", 100, "sources/book.xlsx")
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
	seed := strings.Repeat("a", 64)
	if _, err := st.Pool().Exec(ctx, `UPDATE source_documents SET checkpoint=checkpoint+1,state='\x01',state_seed_sha256=$2 WHERE file_id=$1`, file.ID, seed); err != nil {
		t.Fatal(err)
	}
	// The saved change rides along with the seed it was taken over.
	edited := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil)
	if edited.Code != http.StatusOK ||
		!bytes.Contains(edited.Body.Bytes(), []byte(`"state":"AQ=="`)) ||
		!bytes.Contains(edited.Body.Bytes(), []byte(`"stateSeedSHA256":"`+seed+`"`)) ||
		bytes.Contains(edited.Body.Bytes(), []byte(`pendingEffects`)) ||
		bytes.Contains(edited.Body.Bytes(), []byte(`growthBudgetBytes`)) {
		t.Fatalf("edited view session = %d body=%s", edited.Code, edited.Body.String())
	}
	// An Office editor takes its document from the room's sync: the editor
	// read carries no state, and leaves the effects server-side. It carries
	// what the room may still admit: the export cap (30 MiB in the test
	// catalog) less the 100 byte base, the 1 MiB margin, admission's 64 KiB
	// reserve and the 1 byte saved change.
	full := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil)
	if full.Code != http.StatusOK ||
		!bytes.Contains(full.Body.Bytes(), []byte(`"state":null`)) ||
		!bytes.Contains(full.Body.Bytes(), []byte(`"stateSeedSHA256":null`)) ||
		bytes.Contains(full.Body.Bytes(), []byte(`pendingEffects`)) ||
		!bytes.Contains(full.Body.Bytes(), []byte(`"growthBudgetBytes":30343067`)) {
		t.Fatalf("editor session = %d body=%s", full.Code, full.Body.String())
	}
	// Editing that stays on an older base measures it in the bucket (9 bytes).
	if _, err := st.Pool().Exec(ctx, `UPDATE files SET revision=revision+1 WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	older := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil)
	if older.Code != http.StatusOK ||
		!bytes.Contains(older.Body.Bytes(), []byte(`"growthBudgetBytes":30343158`)) {
		t.Fatalf("editor session over an older base = %d body=%s", older.Code, older.Body.String())
	}
}

// Epo 2026-10-20: a text source published over the plan file limit opens
// view only like an Office file at its size limit, so its edit read carries
// a growth budget too, from its base alone.
func TestTextSourceOverThePlanLimitHasNoGrowthBudget(t *testing.T) {
	ctx := context.Background()
	st := openAccessTestStoreForPreview(t)
	memory := blob.NewMemory()
	handler := httpapi.New(st, memory, nil, nil, "opendataloader", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner"},
	})
	workspace, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Text limit", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := uploadSource(ctx, st, workspace.ID, "u_owner", "notes.md", 100, "sources/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = memory.Put("sources/notes.md", strings.NewReader("# Notes")); err != nil {
		t.Fatal(err)
	}
	// Published past the 30 MiB export cap of the test catalog.
	if _, err = st.Pool().Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`, file.ID, int64(40<<20)); err != nil {
		t.Fatal(err)
	}
	editor := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil)
	if editor.Code != http.StatusOK ||
		!bytes.Contains(editor.Body.Bytes(), []byte(`"format":"text"`)) ||
		!bytes.Contains(editor.Body.Bytes(), []byte(`"growthBudgetBytes":0`)) {
		t.Fatalf("text editor session = %d body=%s", editor.Code, editor.Body.String())
	}
	// The view read says so before any Edit attempt (review r3 E1).
	if view := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil); view.Code != http.StatusOK ||
		!bytes.Contains(view.Body.Bytes(), []byte(`"atSizeLimit":true`)) {
		t.Fatalf("text view session = %d body=%s", view.Code, view.Body.String())
	}
}

// A text state is the whole text with its history: its growth over the seed
// (seed_bytes) counts against the budget, as the room's estimate does
// (review r3 S2).
func TestTextSourceGrowthCountsItsStateOverTheSeed(t *testing.T) {
	ctx := context.Background()
	st := openAccessTestStoreForPreview(t)
	memory := blob.NewMemory()
	handler := httpapi.New(st, memory, nil, nil, "opendataloader", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner"},
	})
	workspace, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Text growth", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), "u_owner", workspace.ID) })
	file, err := uploadSource(ctx, st, workspace.ID, "u_owner", "notes.md", 100, "sources/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = memory.Put("sources/notes.md", strings.NewReader("# Notes")); err != nil {
		t.Fatal(err)
	}
	if editor := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil); editor.Code != http.StatusOK {
		t.Fatalf("editor session = %d body=%s", editor.Code, editor.Body.String())
	}
	if _, err = st.Pool().Exec(ctx, `UPDATE source_documents SET checkpoint=checkpoint+1,state=$2,seed_bytes=100 WHERE file_id=$1`, file.ID, make([]byte, 1000)); err != nil {
		t.Fatal(err)
	}
	// 30 MiB less the 100 byte base, the 1 MiB margin, the 64 KiB reserve
	// and the 900 bytes the state grew past its seed.
	editor := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session", "u_owner", nil)
	if editor.Code != http.StatusOK ||
		!bytes.Contains(editor.Body.Bytes(), []byte(`"growthBudgetBytes":30342168`)) {
		t.Fatalf("text editor session = %d body=%s", editor.Code, editor.Body.String())
	}
}

// Office inserts shrink images to the plan cap of the workspace owner, who
// pays for the file, whatever the editor's own plan: only the editor read
// carries it. The editor read also says when the file's card is older than
// its saved document.
func TestSourceSessionEditorCarriesTheOwnersImageCap(t *testing.T) {
	ctx := context.Background()
	st := openAccessTestStoreForPreview(t)
	memory := blob.NewMemory()
	owner, editor := "u_image_cap_owner", "u_image_cap_editor"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users(id,name,email,plan_tier) VALUES($1,'Cap Owner','cap-owner@example.test','free'),($2,'Cap Editor','cap-editor@example.test','pro')`, owner, editor); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id IN ($1,$2)`, owner, editor)
	})
	handler := httpapi.New(st, memory, nil, nil, "opendataloader", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{editor},
	})
	workspace, err := st.CreateWorkspace(ctx, owner, store.WorkspaceCreate{Name: "Image cap", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(context.Background(), owner, workspace.ID) })
	if _, err := st.Pool().Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'editor')`, workspace.ID, editor); err != nil {
		t.Fatal(err)
	}
	file, err := uploadSource(ctx, st, workspace.ID, owner, "plan.docx", 100, "sources/plan.docx")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := memory.Put("sources/plan.docx", bytes.NewReader([]byte("PK-source"))); err != nil {
		t.Fatal(err)
	}
	session := func(query string) string {
		res := doReq(t, handler, http.MethodGet, "/api/files/"+file.ID+"/source-session"+query, editor, nil)
		if res.Code != http.StatusOK {
			t.Fatalf("source session%s = %d body=%s", query, res.Code, res.Body.String())
		}
		return res.Body.String()
	}
	if body := session(""); !strings.Contains(body, `"imageMaxBytes":2097152`) {
		t.Fatalf("editor of a Free owner's file: %s", body)
	}
	if body := session("?view=true"); strings.Contains(body, "imageMaxBytes") {
		t.Fatalf("view read carries the image cap: %s", body)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE users SET plan_tier='pro' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	// 2 MiB on every plan (Epo 2026-10-24).
	if body := session(""); !strings.Contains(body, `"imageMaxBytes":2097152`) {
		t.Fatalf("editor of a Pro owner's file: %s", body)
	}
	if body := session(""); strings.Contains(body, "thumbnailStale") {
		t.Fatalf("a file without saved changes reads stale: %s", body)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE source_documents SET state_seed_sha256=repeat('a',64), log_rows=1 WHERE file_id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if body := session(""); !strings.Contains(body, `"thumbnailStale":true`) {
		t.Fatalf("a saved change over ingest's card: %s", body)
	}
	if body := session("?view=true"); strings.Contains(body, "thumbnailStale") {
		t.Fatalf("view read carries the stale card: %s", body)
	}
}
