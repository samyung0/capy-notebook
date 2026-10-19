package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
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

	// A shared quiz and flashcard set read the same way, signed in or not.
	quizContent, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1",`+
		`"blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],`+
		`"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	setContent, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: "c1", Front: "a", Back: "b"}})
	if err != nil {
		t.Fatal(err)
	}
	item := func(kind, content string) (string, string) {
		t.Helper()
		created, err := st.CreateMaterial(ctx, store.Material{
			CreatedBy: "u_owner", Kind: store.MaterialKind(kind), Title: "Unreadable " + kind, Content: content, Privacy: "private",
		})
		if err != nil {
			t.Fatal(err)
		}
		cleanupMaterial(t, st, created.ID)
		if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", created.ID, "", store.PrivacyLink); err != nil {
			t.Fatal(err)
		}
		plant(created.ID)
		return created.ID, store.ShareToken(nil, created.ID)
	}
	quiz, quizToken := item("quiz", quizContent)
	set, setToken := item("flashcards", setContent)
	noAnswers := map[string]any{"answers": map[string]any{}}
	expectUnreadable(t, h, []unreadableRead{
		{http.MethodGet, "/api/quizzes/" + quiz, "u_owner", nil},
		{http.MethodGet, "/api/quizzes/" + quiz + "/edit", "u_owner", nil},
		{http.MethodPost, "/api/quizzes/" + quiz + "/attempts", "u_owner", noAnswers},
		{http.MethodPatch, "/api/quizzes/" + quiz + "/sharing", "u_owner", map[string]any{"privacy": "link"}},
		{http.MethodGet, "/api/flashcards/" + set + "/cards", "u_owner", nil},
		{http.MethodGet, "/api/public/quizzes/" + quizToken, "", nil},
		{http.MethodGet, "/api/public/quizzes/" + quizToken + "/assets/asset_1", "", nil},
		{http.MethodPost, "/api/public/quizzes/" + quizToken + "/grade", "", noAnswers},
		{http.MethodGet, "/api/public/flashcards/" + setToken, "", nil},
		{http.MethodGet, "/api/public/flashcards/" + setToken + "/assets/asset_1", "", nil},
	})
}

type unreadableRead struct {
	method, path, user string
	body               any
}

// expectUnreadable asserts each route answers 422 material_content_unreadable.
func expectUnreadable(t *testing.T, h http.Handler, reads []unreadableRead) {
	t.Helper()
	for _, read := range reads {
		rec := doReq(t, h, read.method, read.path, read.user, read.body)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "material_content_unreadable") {
			t.Errorf("%s %s = %d %s, want the unreadable state", read.method, read.path, rec.Code, rec.Body.String())
		}
	}
}

// Study reads a quiz's stored content to rate, check and rank its questions:
// once a rule refuses it, the workspace's Study tab, its attempts, a new or
// resumed review, Learning's Review tab, and rating or checking
// one of its questions answer 422 material_content_unreadable, never a 500
// (Epo 2026-10-20). Fails if any of those routes maps the error to a 500.
func TestStudyOfAQuizARuleRefusesIsUnreadable(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	pool := st.Pool()
	ws, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Study a broken quiz", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws.ID) })
	question := func(id string) string {
		return `{"id":"` + id + `","stem":[],"parts":[{"id":"` + id + `:part:1","blocks":[{"type":"text","text":"True?"}],` +
			`"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`
	}
	content, err := materialdoc.QuizDocument(json.RawMessage(`[`+question("q1")+`,`+question("q2")+`]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_owner", WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "quiz", Title: "Broken later",
		Content: content, Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rec := doReq(t, h, http.MethodPut, "/api/workspaces/"+ws.ID+"/study/enabled", "u_owner",
		map[string]any{"enabled": true}); rec.Code != http.StatusNoContent {
		t.Fatalf("study on = %d %s", rec.Code, rec.Body.String())
	}
	answers := map[string]any{"q1:part:1": true, "q2:part:1": true}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+quiz.ID+"/attempts", "u_owner",
		map[string]any{"answers": answers}); rec.Code != http.StatusCreated {
		t.Fatalf("attempt = %d %s", rec.Code, rec.Body.String())
	}
	// A review session left after its first answer, to resume.
	const session = "6f1c2a8e-0000-4000-8000-000000000001"
	if rec := doReq(t, h, http.MethodPost, "/api/review/check", "u_owner", map[string]any{
		"materialId": quiz.ID, "itemId": "q1", "answers": map[string]any{"q1:part:1": true},
		"session": map[string]any{"id": session, "workspaceId": ws.ID, "group": "workspace", "items": []any{
			map[string]any{"materialId": quiz.ID, "itemId": "q1"}, map[string]any{"materialId": quiz.ID, "itemId": "q2"},
		}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("first review answer = %d %s", rec.Code, rec.Body.String())
	}
	stored := `{"schemaVersion":1,"value":[{"type":"p","id":"p1","children":[{"text":"say "},` +
		`{"type":"mention","value":"Ada","children":[{"text":"hidden"}]},{"text":""}]}]}`
	// A new revision, so no parsed copy of the old content answers for it.
	if _, err := pool.Exec(ctx, `UPDATE materials SET content=$2::jsonb, revision=revision+1 WHERE id=$1`, quiz.ID, stored); err != nil {
		t.Fatal(err)
	}
	expectUnreadable(t, h, []unreadableRead{
		{http.MethodGet, "/api/workspaces/" + ws.ID + "/study", "u_owner", nil},
		{http.MethodGet, "/api/workspaces/" + ws.ID + "/study/attempts", "u_owner", nil},
		{http.MethodGet, "/api/workspaces/" + ws.ID + "/review", "u_owner", nil},
		{http.MethodGet, "/api/review/sessions/" + session, "u_owner", nil},
		{http.MethodGet, "/api/review/overview", "u_owner", nil},
		{http.MethodPost, "/api/review/ratings", "u_owner", map[string]any{"materialId": quiz.ID, "itemId": "q1", "rating": 3}},
		{http.MethodPost, "/api/review/check", "u_owner", map[string]any{"materialId": quiz.ID, "itemId": "q1", "answers": map[string]any{}}},
	})
}

// A workspace clone leaves out a material whose stored content the current
// rules refuse or that is over the material size caps, with the rows it
// embeds and their assets; a note whose embedded quiz is unreadable goes with
// it, counted once. It copies everything else and tells the cloner how many
// files it left out (Epo 2026-10-20); the source stays as it is. Fails if the
// clone refuses the whole workspace, or copies the broken note, the note
// whose quiz is broken (its quiz block dropped), the oversized note or the
// broken note's asset (an orphan the cloner pays for).
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
	embed := func(note string) string {
		t.Helper()
		quiz, err := st.CreateEmbeddedMaterial(ctx, "u_owner", note, store.EmbeddedDraft{
			Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
		})
		if err != nil {
			t.Fatal(err)
		}
		return quiz.ID
	}
	plant := func(id, content string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE materials SET content=$2::jsonb WHERE id=$1`, id, content); err != nil {
			t.Fatal(err)
		}
	}
	stored := `{"schemaVersion":1,"value":[{"type":"p","id":"p1","children":[{"text":"say "},` +
		`{"type":"mention","value":"Ada","children":[{"text":"hidden"}]},{"text":""}]}]}`
	create("Readable")
	broken := create("Unreadable")
	embed(broken)
	plant(broken, stored)
	if _, err := pool.Exec(ctx, `INSERT INTO editor_assets
		(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path, content_type,
		 size_bytes, status, completed_at)
		VALUES ('asset_unreadable_clone', $1, $2, 'u_owner', 'u_owner', 'a.png', 'image', 'editor/asset_unreadable_clone',
		 'image/png', 10, 'ready', now())`, source.ID, broken); err != nil {
		t.Fatal(err)
	}
	plant(embed(create("Host of a broken quiz")), stored)
	// Over the material node cap (Epo 2026-10-20: counts as refused).
	paragraphs := make([]map[string]any, materialdoc.MaxNodes/2+1)
	for i := range paragraphs {
		paragraphs[i] = map[string]any{"type": "p", "id": fmt.Sprintf("p%d", i), "children": []any{map[string]any{"text": ""}}}
	}
	oversized, err := json.Marshal(map[string]any{"schemaVersion": 1, "value": paragraphs})
	if err != nil {
		t.Fatal(err)
	}
	plant(create("Oversized"), string(oversized))

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
	if body.SkippedMaterials != 3 {
		t.Errorf("skippedMaterials = %d, want 3 (each note counted once)", body.SkippedMaterials)
	}
	var titles []string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(array_agg(title ORDER BY title), '{}') FROM materials WHERE workspace_id=$1`,
		body.Workspace.ID).Scan(&titles); err != nil {
		t.Fatal(err)
	}
	if len(titles) != 1 || titles[0] != "Readable" {
		t.Errorf("the copy holds %q, want only the readable note", titles)
	}
	var assets int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE workspace_id=$1`,
		body.Workspace.ID).Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if assets != 0 {
		t.Errorf("the copy holds %d editor assets, want none (the broken note's stays behind)", assets)
	}
	var kept string
	if err := pool.QueryRow(ctx, `SELECT content::text FROM materials WHERE id=$1`, broken).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kept, `"hidden"`) {
		t.Errorf("the source changed: %s", kept)
	}
}

// Only stored content the rules refuse reads as unreadable (Epo 2026-10-20):
// a quiz we generate that fails our own validation stays a 500, which
// reaches Sentry, and questions a request sends for an embedded quiz a 400,
// as a create answers them. Fails if either answers
// material_content_unreadable.
func TestContentWeGenerateOrAreSentIsNeverUnreadable(t *testing.T) {
	question := `{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Q?"}],` +
		`"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`
	generator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Two questions with one id: our generator's bug, not the user's.
		_, _ = fmt.Fprintf(w, `{"kind":"quiz","name":"n","questions":[%s,%s]}`, question, question)
	}))
	t.Cleanup(generator.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(generator.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor",
		generateBody("quiz", "Duplicate question ids"))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("generate = %d %s, want 500", rec.Code, rec.Body.String())
	}

	note, err := st.CreateMaterial(context.Background(), store.Material{
		CreatedBy: "u_owner", WorkspaceID: "ws_e2e_private", Kind: "note", Title: "Embeds a sent quiz",
		Content: noteTestContent(t, "body"), Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, note.ID)
	var sent map[string]any
	if err := json.Unmarshal([]byte(question), &sent); err != nil {
		t.Fatal(err)
	}
	rec = doAsUser(t, h, http.MethodPost, "/api/materials/"+note.ID+"/embedded", "u_owner",
		map[string]any{"kind": "quiz", "questions": []any{sent, sent}})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("embedded create = %d %s, want 400", rec.Code, rec.Body.String())
	}
}
