package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A stored note a later rule refuses (here a void element holding text,
// Epo 2026-10-18) degrades on every read: it is still listed and its
// discussions and search answer, while a read of its content, its shared
// page and a shared page's image answer the unreadable state (422
// material_content_unreadable), never a 500. Broken materials stay as they
// are (Epo 2026-10-19), so reads must cope with them. Fails if the shared
// page's mapping is reverted.
func TestAStoredNoteARuleRefusesStillListsAndOpens(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	broken := `{"schemaVersion":1,"value":[{"type":"p","id":"p1","children":[{"text":"say "},` +
		`{"type":"mention","value":"Ada","children":[{"text":"hidden"}]},{"text":""}]}]}`
	create := func(m store.Material) string {
		t.Helper()
		m.CreatedBy, m.Kind, m.Content, m.Privacy = "u_owner", "note", noteTestContent(t, "body"), "private"
		created, err := st.CreateMaterial(ctx, m)
		if err != nil {
			t.Fatal(err)
		}
		cleanupMaterial(t, st, created.ID)
		return created.ID
	}
	plant := func(id string) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, `UPDATE materials SET content=$2::jsonb WHERE id=$1`, id, broken); err != nil {
			t.Fatal(err)
		}
	}
	note := create(store.Material{WorkspaceID: "ws_e2e_private", Title: "Unreadable mention"})
	plant(note)

	for _, path := range []string{
		"/api/workspaces/ws_e2e_private/materials",
		"/api/materials?kind=note",
		"/api/workspaces/ws_e2e_private/recent",
	} {
		rec := doAsUser(t, h, http.MethodGet, path, "u_owner", nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), note) {
			t.Errorf("%s = %d %s, want it listed", path, rec.Code, rec.Body.String())
		}
	}
	rec := doAsUser(t, h, http.MethodGet, "/api/materials/"+note, "u_owner", nil)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
		t.Errorf("a read of its content = %d %s, want the unreadable state", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/materials/" + note + "/discussions", "/api/search?q=Unreadable"} {
		if rec := doAsUser(t, h, http.MethodGet, path, "u_owner", nil); rec.Code != http.StatusOK {
			t.Errorf("%s = %d %s", path, rec.Code, rec.Body.String())
		}
	}
	// A single clone answers the read's state (Epo 2026-10-20).
	rec = doAsUser(t, h, http.MethodPost, "/api/materials/"+note+"/clone", "u_owner", map[string]any{"title": "Copy"})
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
		t.Errorf("its clone = %d %s, want the unreadable state", rec.Code, rec.Body.String())
	}
	// Indexing it is final: the ingest worker retries only 5xx and 429.
	rec = doInternal(t, h, http.MethodGet, "/api/internal/materials/"+note+"/index-text?workspaceId=ws_e2e_private", pipeSecret, nil)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
		t.Errorf("its index text = %d %s, want a final 422", rec.Code, rec.Body.String())
	}

	shared := create(store.Material{Title: "Unreadable shared"})
	if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", shared, "", store.PrivacyLink); err != nil {
		t.Fatal(err)
	}
	plant(shared)
	token := store.ShareToken(nil, shared)
	for _, path := range []string{"/api/public/notes/" + token, "/api/public/notes/" + token + "/assets/asset_1"} {
		rec := doReq(t, h, http.MethodGet, path, "", nil)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
			t.Errorf("%s = %d %s, want the unreadable state", path, rec.Code, rec.Body.String())
		}
	}
	rec = doReq(t, h, http.MethodPost, "/api/public/notes/"+token+"/quizzes/mat_any/grade", "", map[string]any{"answers": map[string]any{}})
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
		t.Errorf("grading its embedded quiz = %d %s, want the unreadable state", rec.Code, rec.Body.String())
	}
}

// A workspace clone leaves out a material whose stored content the current
// rules refuse, with the rows it embeds, copies everything else and tells the
// cloner how many files it left out (Epo 2026-10-20); the source stays as it
// is. Fails if the clone refuses the whole workspace or copies the note.
func TestAWorkspaceCloneSkipsAMaterialARuleRefuses(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	pool := st.Pool()
	source, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Clone with a broken note", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, source.ID) })
	create := func(title string) string {
		t.Helper()
		created, err := st.CreateMaterial(ctx, store.Material{
			CreatedBy: "u_owner", WorkspaceID: source.ID, WorkspaceName: source.Name, Kind: "note",
			Title: title, Content: noteTestContent(t, title), Privacy: "private",
		})
		if err != nil {
			t.Fatal(err)
		}
		return created.ID
	}
	create("Readable")
	broken := create("Unreadable")
	if _, err := st.CreateEmbeddedMaterial(ctx, "u_owner", broken, store.EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
	}); err != nil {
		t.Fatal(err)
	}
	stored := `{"schemaVersion":1,"value":[{"type":"p","id":"p1","children":[{"text":"say "},` +
		`{"type":"mention","value":"Ada","children":[{"text":"hidden"}]},{"text":""}]}]}`
	if _, err := pool.Exec(ctx, `UPDATE materials SET content=$2::jsonb WHERE id=$1`, broken, stored); err != nil {
		t.Fatal(err)
	}

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/"+source.ID+"/clone", "u_owner", map[string]any{"name": "Copy"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("clone = %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Workspace        struct{ ID string } `json:"workspace"`
		SkippedMaterials int                 `json:"skippedMaterials"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, body.Workspace.ID)
	})
	if body.SkippedMaterials != 1 {
		t.Errorf("skippedMaterials = %d, want 1", body.SkippedMaterials)
	}
	var titles []string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(array_agg(title ORDER BY title), '{}') FROM materials WHERE workspace_id=$1`,
		body.Workspace.ID).Scan(&titles); err != nil {
		t.Fatal(err)
	}
	if len(titles) != 1 || titles[0] != "Readable" {
		t.Errorf("the copy holds %q, want only the readable note", titles)
	}
	var kept string
	if err := pool.QueryRow(ctx, `SELECT content::text FROM materials WHERE id=$1`, broken).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kept, `"hidden"`) {
		t.Errorf("the source changed: %s", kept)
	}
}
