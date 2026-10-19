package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Security regression (live-items REVIEW5, pending references): an imported
// quiz fence becomes a "pending" reference whose body holds the quiz's answer
// keys, until Go resolves it to the row made for it. No document stores one
// (the embed catalog forbids "pending"): a note write refuses it, and a note
// planted with one past the checks fails closed, so no read, shared page or
// clone serves the fence body. Fails if the write check is reverted or a
// reader serves the body.
func TestPendingReferencesNeverReachReaders(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	const secret = "SECRET-KEY-7f3a"
	pending := map[string]any{
		"type": "material_ref", "id": "fence", "materialId": "", "refKind": "quiz",
		"pending":  "questions:\n  - type: short_answer\n    prompt: Q\n    answer: " + secret,
		"children": []any{map[string]any{"text": ""}},
	}
	body := map[string]any{"type": "p", "id": "body", "children": []any{map[string]any{"text": "Body"}}}
	content := map[string]any{"schemaVersion": 1, "value": []any{body, pending}}

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/materials", "u_owner",
		map[string]any{"kind": "note", "title": "Pending fence", "content": content})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a note write holding a pending reference = %d %s, want 400", rec.Code, rec.Body.String())
	}

	legacy := `{"schemaVersion":1,"value":[{"type":"p","id":"body","children":[{"text":"Body"}]},` +
		`{"type":"material_ref","id":"fence","materialId":"","refKind":"quiz","pending":"answer: ` + secret + `","children":[{"text":""}]}]}`
	plant := func(id string) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, `UPDATE materials SET content=$2::jsonb WHERE id=$1`, id, legacy); err != nil {
			t.Fatal(err)
		}
	}
	original := ""
	if err := st.Pool().QueryRow(ctx, `SELECT content::text FROM materials WHERE id='note_e2e_private'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `UPDATE materials SET content=$1::jsonb WHERE id='note_e2e_private'`, original)
	})
	plant("note_e2e_private")
	for _, user := range []string{"u_viewer", "u_owner"} {
		rec := doAsUser(t, h, http.MethodGet, "/api/materials/note_e2e_private", user, nil)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("%s read = %d %s, want a refusal without the fence body", user, rec.Code, rec.Body.String())
		}
	}

	shared, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", Kind: "note", Title: "Shared fence", Content: noteTestContent(t, "body")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, shared.ID)
	if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", shared.ID, "", store.PrivacyLink); err != nil {
		t.Fatal(err)
	}
	plant(shared.ID)
	rec = doReq(t, h, http.MethodGet, "/api/public/notes/"+store.ShareToken(nil, shared.ID), "", nil)
	if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("shared note page = %d %s, want a refusal without the fence body", rec.Code, rec.Body.String())
	}

	if clone, err := st.CloneMaterial(ctx, "u_other", shared.ID, store.CloneTarget{Name: "Clone"}); err == nil {
		cleanupMaterial(t, st, clone.ID)
		t.Fatalf("a note holding a pending reference was cloned: %s", clone.Content)
	}
}
