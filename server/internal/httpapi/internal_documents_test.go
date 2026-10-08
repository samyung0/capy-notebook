package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestInternalEditAppendsProvenance(t *testing.T) {
	h, st := openInternalHTTP(t)
	var sent struct {
		Provenance *store.Provenance `json:"provenance"`
	}
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
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
		"commands": []map[string]any{{"type": "insert_markdown", "after_block_id": nil, "markdown": "A second section."}},
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

// An embedded quiz is reachable by the id its parent note's inspection shows:
// the internal inspect and edit routes take the child id like any material.
func TestInternalDocumentsReachEmbeddedMaterials(t *testing.T) {
	h, st := openInternalHTTP(t)
	var targets []string
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Target struct {
				ID string `json:"id"`
			} `json:"target"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		targets = append(targets, body.Target.ID)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/internal/documents/inspect" {
			_, _ = w.Write([]byte(`{"roomSchema":1,"blocks":[{"id":"q1","type":"quiz","text":""}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_embed_note", "Lecture", "# Lecture\n\nBody."))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, noteID)
	quiz, err := st.CreateEmbeddedMaterial(context.Background(), "u_editor", noteID, store.EmbeddedDraft{
		Kind:      "quiz",
		Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}

	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/inspect", pipeSecret, map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"target": map[string]any{"kind": "material", "id": quiz.ID},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"materialKind":"quiz"`) {
		t.Fatalf("inspect status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_embed_edit",
		"target":   map[string]any{"kind": "material", "id": quiz.ID},
		"commands": []map[string]any{{"type": "remove_question", "question_id": "q1"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("edit status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(targets) != 2 || targets[0] != quiz.ID || targets[1] != quiz.ID {
		t.Fatalf("authority targets = %v, want the embedded quiz twice", targets)
	}
}

// insert_markdown converts through the collaboration service; a quiz fence
// becomes a row under the note before the reference block is inserted, a
// retried edit finds that row instead of creating another, and an edit the
// authority refuses leaves the row discarded rather than hidden in the note.
func TestInsertMarkdownCreatesItsMiniCheckFirst(t *testing.T) {
	h, st := openInternalHTTP(t)
	var sent []struct {
		Commands []struct {
			Type   string           `json:"type"`
			Blocks []map[string]any `json:"blocks"`
		} `json:"commands"`
	}
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Commands []struct {
				Type   string           `json:"type"`
				Blocks []map[string]any `json:"blocks"`
			} `json:"commands"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"stale_target","message":"retry"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_insert_note", "Insert "+msgID, "# Lecture"))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := store.ChatMaterialID(msgID, "call_insert_note")
	cleanupMaterial(t, st, noteID)
	question := `{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`
	edit := map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_insert",
		"target": map[string]any{"kind": "material", "id": noteID},
		"commands": []map[string]any{{"type": "insert_markdown", "after_block_id": nil,
			"markdown": "Check yourself.\n\n```quiz\n{\"questions\":[" + question + "]}\n```"}},
	}
	for range 2 { // the authority refuses, so the second call is a retry
		doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	}
	var embedded []string
	rows, err := st.Pool().Query(t.Context(), `SELECT id, trashed_at IS NOT NULL FROM materials WHERE parent_material_id=$1`, noteID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var trashed bool
		_ = rows.Scan(&id, &trashed)
		if !trashed {
			t.Fatalf("embedded row %s outlived the refused edit", id)
		}
		embedded = append(embedded, id)
	}
	rows.Close()
	if len(embedded) != 1 {
		t.Fatalf("embedded rows = %v, want one across the retry", embedded)
	}
	if len(sent) != 2 || len(sent[0].Commands) != 1 || sent[0].Commands[0].Type != "insert_block" {
		t.Fatalf("authority commands = %+v", sent)
	}
	blocks := sent[0].Commands[0].Blocks
	if len(blocks) != 2 || blocks[1]["type"] != "material_ref" || blocks[1]["materialId"] != embedded[0] || blocks[1]["pending"] != nil {
		t.Fatalf("inserted blocks = %+v", blocks)
	}
}

// A refused edit's details (the target as it reads now) reach the pipeline
// unchanged beside the code and message.
func TestEditRefusalDetailsReachThePipeline(t *testing.T) {
	h, st := openInternalHTTP(t)
	details := `{"block":{"id":"b1","text":"Alpha beta.","type":"p"}}`
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"stale_target","message":"expected text was not found in the target","details":` + details + `}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_details_note", "Details "+msgID, "# Lecture\n\nAlpha beta."))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, noteID)
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_details_edit",
		"target":   map[string]any{"kind": "material", "id": noteID},
		"commands": []map[string]any{{"type": "replace_text", "target_id": "b1", "expected_text": "gamma", "text": "delta"}},
	})
	var body struct {
		Code    string          `json:"code"`
		Details json.RawMessage `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusConflict || body.Code != "stale_target" || string(body.Details) != details {
		t.Fatalf("edit status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// An insert whose anchor block was gone lands elsewhere, and the authority's
// receipt saying where reaches the pipeline.
func TestEditReceiptKeepsRelocatedInserts(t *testing.T) {
	h, st := openInternalHTTP(t)
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document","effect":{"operation":"edited",` +
			`"resource":{"kind":"material","id":"m"},"relocated":[{"anchor":"b2","after":"b9","end":true}]}}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_relocated_note", "Relocated "+msgID, "# Lecture\n\nBody."))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, noteID)
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_relocated_edit",
		"target":   map[string]any{"kind": "material", "id": noteID},
		"commands": []map[string]any{{"type": "insert_markdown", "after_block_id": "b2", "markdown": "More."}},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"relocated":[{"anchor":"b2","after":"b9","end":true}]`) {
		t.Fatalf("edit status = %d body=%s", rec.Code, rec.Body.String())
	}
}
