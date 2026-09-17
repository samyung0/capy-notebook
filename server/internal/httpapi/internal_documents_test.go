package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A curate turn writes a material in several edits, so the second edit's books
// are appended to the record the creation stored rather than replacing it. The
// gateway merges and revalidates, then hands the authority the record it
// commits with the content.
func TestInternalEditAppendsProvenance(t *testing.T) {
	h, st := openInternalHTTP(t)
	var sent struct {
		Provenance *store.Provenance `json:"provenance"`
	}
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	create := noteBody(msgID, "call_edit_prov_create", "Appended attribution", "# Regression\n\nA fitted line.")
	create["provenance"] = map[string]any{
		"books": []map[string]any{{
			"id": "ahss", "title": "Advanced High School Statistics",
			"license": "CC BY-SA 3.0", "excerptIds": []string{"e_1"}, "version": 2,
		}},
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, create)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	materialID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, materialID)

	edit := map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_edit_prov",
		"target":   map[string]any{"kind": "material", "id": materialID},
		"commands": []map[string]any{{"type": "insert_block", "text": "A second section."}},
		"provenance": map[string]any{"books": []map[string]any{{
			"id": "osp", "title": "OpenStax Prealgebra",
			"license": "CC BY-SA 4.0", "excerptIds": []string{"e_9"}, "version": 1,
		}}},
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	if rec.Code != http.StatusOK {
		t.Fatalf("edit status = %d body=%s", rec.Code, rec.Body.String())
	}
	if sent.Provenance == nil || len(sent.Provenance.Books) != 2 ||
		sent.Provenance.Books[0].ID != "ahss" || sent.Provenance.Books[1].ID != "osp" {
		t.Fatalf("authority provenance = %+v, want both books credited", sent.Provenance)
	}
	if sent.Provenance.License != "CC BY-SA 4.0" {
		t.Fatalf("license = %q, want the newest version of the family", sent.Provenance.License)
	}

	// A second copyleft family refuses the edit; nothing reaches the authority.
	sent.Provenance = nil
	edit["toolCallId"] = "call_edit_prov_conflict"
	edit["provenance"] = map[string]any{"books": []map[string]any{{
		"id": "wiki", "title": "Wikibooks Statistics",
		"license": "GFDL 1.3", "excerptIds": []string{"e_5"}, "version": 1,
	}}}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("conflicting family status = %d body=%s", rec.Code, rec.Body.String())
	}
	if sent.Provenance != nil {
		t.Fatalf("a refused edit reached the authority: %+v", sent.Provenance)
	}
}

// Provenance is the server's record: the user-facing material routes cannot
// add, change or clear it.
func TestMaterialUpdateCannotTouchProvenance(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	body := noteBody(msgID, "call_prov_patch", "Guarded attribution", "# Regression\n\nA fitted line.")
	body["provenance"] = map[string]any{
		"books": []map[string]any{{
			"id": "ahss", "title": "Advanced High School Statistics",
			"license": "CC BY-SA 4.0", "excerptIds": []string{"e_1"}, "version": 2,
		}},
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	materialID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, materialID)

	// The update contract has no provenance field, so a forged one is refused
	// outright rather than quietly dropped.
	forged := doAsUser(t, h, http.MethodPatch, "/api/materials/"+materialID+"/metadata", "u_editor",
		map[string]any{"title": "Forged", "provenance": map[string]any{"books": []map[string]any{{
			"id": "forged", "title": "Forged", "excerptIds": []string{"e_x"}, "version": 1,
		}}}})
	if forged.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(forged.Body.String(), "body.provenance") {
		t.Fatalf("forged patch status = %d body=%s", forged.Code, forged.Body.String())
	}
	patch := doAsUser(t, h, http.MethodPatch, "/api/materials/"+materialID+"/metadata", "u_editor",
		map[string]any{"title": "Renamed"})
	if patch.Code != http.StatusOK {
		t.Fatalf("patch status = %d body=%s", patch.Code, patch.Body.String())
	}
	stored, err := st.GetMaterial(t.Context(), materialID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Provenance == nil || len(stored.Provenance.Books) != 1 ||
		stored.Provenance.Books[0].ID != "ahss" {
		t.Fatalf("provenance = %+v, want the stored record untouched", stored.Provenance)
	}
}
