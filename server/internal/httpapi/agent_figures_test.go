package httpapi_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// fakeJPEG is a small JPEG padded to about size bytes: it passes the
// signature check and the header read.
func fakeJPEG(size int) []byte {
	return sizedJPEG(8, 8, size)
}

func sizedJPEG(width, height, size int) []byte {
	var out bytes.Buffer
	if err := jpeg.Encode(&out, image.NewGray(image.Rect(0, 0, width, height)), nil); err != nil {
		panic(err)
	}
	return append(out.Bytes(), bytes.Repeat([]byte{7}, max(0, size-out.Len()))...)
}

func assetObjects(t *testing.T, mem *blob.Memory, assetID string) int {
	t.Helper()
	listing, err := mem.ListObjects(t.Context(), "editor-assets/"+assetID+"/", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	return len(listing.Keys)
}

// A library figure an agent places in a note becomes the note's own editor
// asset, charged to the chat's actor like an upload: stored once per tool
// call (a replay stores nothing again), and only for the figures the
// markdown uses.
func TestAgentNoteStoresItsFiguresAsAssets(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := t.Context()
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	image := fakeJPEG(2000)
	body := noteBody(msgID, "call_fig_note", "Figures "+msgID,
		"# Neurons\n\n![Figure 16.10: The action potential (CC BY 4.0)](figure:fig_a)")
	body["figures"] = []map[string]any{{"id": "fig_a", "image": image}, {"id": "fig_unused", "image": image}}
	for range 2 {
		if rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body); rec.Code != http.StatusOK {
			t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
		}
	}
	noteID := store.ChatMaterialID(msgID, "call_fig_note")
	cleanupMaterial(t, st, noteID)

	assetID := store.ChatAssetID(msgID, "call_fig_note/figure/fig_a")
	var materialID, status, payer string
	var size int64
	if err := st.Pool().QueryRow(ctx, `SELECT material_id, status, size_bytes, user_id
		FROM editor_assets WHERE id=$1`, assetID).
		Scan(&materialID, &status, &size, &payer); err != nil {
		t.Fatal(err)
	}
	if materialID != noteID || status != "ready" || size != int64(len(image)) || payer != "u_editor" {
		t.Fatalf("asset = %s %s %d paid by %s, want the note's ready image paid by the actor", materialID, status, size, payer)
	}
	var assets int
	if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE material_id=$1`, noteID).Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if assets != 1 || assetObjects(t, mem, assetID) != 1 ||
		assetObjects(t, mem, store.ChatAssetID(msgID, "call_fig_note/figure/fig_unused")) != 0 {
		t.Fatalf("assets = %d, objects = %d, want the used figure stored once", assets, assetObjects(t, mem, assetID))
	}
	stored, err := st.GetMaterial(ctx, noteID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored.Content, assetID) || strings.Contains(stored.Content, "figure:") ||
		!strings.Contains(stored.Content, "The action potential (CC BY 4.0)") {
		t.Fatalf("content = %s, want the image pointing at its asset with its caption", stored.Content)
	}
}

// A figure the write did not render, or one over the payer's image cap,
// refuses the note and leaves nothing stored.
func TestAgentNoteRefusesFiguresItCannotStore(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")

	missing := noteBody(msgID, "call_fig_missing", "Missing "+msgID, "# A\n\n![x](figure:fig_gone)")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, missing)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "fig_gone") {
		t.Fatalf("unrendered figure status = %d body=%s", rec.Code, rec.Body.String())
	}

	large := noteBody(msgID, "call_fig_large", "Large "+msgID, "# A\n\n![x](figure:fig_big)")
	large["figures"] = []map[string]any{{"id": "fig_big", "image": fakeJPEG(5 << 20)}}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, large)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusConflict || body.Code != "quota_rejected" {
		t.Fatalf("over-cap figure status = %d body=%s", rec.Code, rec.Body.String())
	}
	// Security regression (Q348, review N2): a figure past the editors'
	// 2,400 px limit is refused from its header.
	wide := noteBody(msgID, "call_fig_wide", "Wide "+msgID, "# A\n\n![x](figure:fig_wide)")
	wide["figures"] = []map[string]any{{"id": "fig_wide", "image": sizedJPEG(2401, 1, 0)}}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, wide)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "invalid_input") ||
		!strings.Contains(rec.Body.String(), "fig_wide") {
		t.Fatalf("wide figure status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, call := range []string{"call_fig_missing", "call_fig_large", "call_fig_wide"} {
		if _, err := st.GetMaterial(t.Context(), store.ChatMaterialID(msgID, call)); err == nil {
			t.Fatalf("%s created a note", call)
		}
	}
	if listing, _ := mem.ListObjects(t.Context(), "editor-assets/", "", 10); len(listing.Keys) != 0 {
		t.Fatalf("objects left = %+v", listing.Keys)
	}
}

// An edit's figures are the note's assets before the blocks that reference
// them reach the authority; a refused edit trashes them, and its retry
// reuses them instead of storing them again.
func TestAgentEditStoresFiguresBeforeTheirBlocks(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	assetID := store.ChatAssetID(msgID, "call_fig_edit/figure/fig_b")
	var inserted []map[string]any
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Commands []struct {
				Blocks []map[string]any `json:"blocks"`
			} `json:"commands"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, err := st.GetEditorAsset(r.Context(), assetID); err != nil {
			t.Errorf("the edit reached the authority before its asset: %v", err)
		}
		inserted = append(inserted, body.Commands[0].Blocks...)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"stale_target","message":"retry"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_fig_edit_note", "Edit "+msgID, "# Lecture"))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := store.ChatMaterialID(msgID, "call_fig_edit_note")
	cleanupMaterial(t, st, noteID)
	edit := map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_fig_edit",
		"target":   map[string]any{"kind": "material", "id": noteID},
		"commands": []map[string]any{{"type": "insert_markdown", "after_block_id": nil, "markdown": "![Figure 1 (Public domain)](figure:fig_b)"}},
		"figures":  []map[string]any{{"id": "fig_b", "image": fakeJPEG(900)}},
	}
	for range 2 { // the authority refuses, so the second call is a retry
		doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	}
	if len(inserted) != 2 || inserted[0]["type"] != "img" || inserted[0]["assetId"] != assetID ||
		inserted[1]["assetId"] != assetID {
		t.Fatalf("inserted blocks = %+v, want the image pointing at %s both times", inserted, assetID)
	}
	asset, err := st.GetEditorAsset(t.Context(), assetID)
	if err != nil || asset.MaterialID != noteID || !asset.Trashed {
		t.Fatalf("asset = %+v (%v), want the note's, trashed after the refusal", asset, err)
	}
	if n := assetObjects(t, mem, assetID); n != 1 {
		t.Fatalf("objects = %d, want the retry's second upload deleted", n)
	}
}

// A library figure add_question_media places becomes the quiz's own image:
// the question reaches the authority pointing at an asset of the quiz, and a
// figure the request did not render is refused before anything is stored.
func TestAgentQuizEditStoresItsFigureAsTheQuizImage(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	assetID := store.ChatAssetID(msgID, "call_quiz_fig/figure/fig_q")
	var nodes []map[string]any
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Commands []struct {
				Node map[string]any `json:"node"`
			} `json:"commands"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		nodes = append(nodes, body.Commands[0].Node)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"stale_target","message":"retry"}`))
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	question := func(blocks ...map[string]any) map[string]any {
		return map[string]any{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []any{map[string]any{
				"id": "q1:part:1", "marks": 1, "solution": []any{},
				"blocks": append([]map[string]any{{"type": "text", "text": "Which organelle?"}}, blocks...),
				"answer": map[string]any{"type": "mcq", "options": []string{"a", "b"}, "correct": []int{0}},
			}},
		}
	}
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor", "assistantMessageId": msgID,
		"toolCallId": "call_quiz_fig_create", "kind": "quiz", "title": "Cells " + msgID,
		"questions": []any{question()},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	quizID := store.ChatMaterialID(msgID, "call_quiz_fig_create")
	cleanupMaterial(t, st, quizID)
	image := map[string]any{
		"type": "image", "image": map[string]any{"assetId": "figure:fig_q"},
		"width": 640, "height": 480, "description": "A cell", "attribution": "A cell (CC BY 4.0)",
	}
	edit := map[string]any{
		"workspaceId": "ws_e2e_private", "userId": "u_editor",
		"assistantMessageId": msgID, "toolCallId": "call_quiz_fig_unrendered",
		"target":   map[string]any{"kind": "material", "id": quizID},
		"commands": []map[string]any{{"type": "replace_question", "question_id": "q1", "question": question(image)}},
	}

	// A question that already shows an uploaded image keeps it beside the figure.
	uploaded := map[string]any{
		"type": "image", "image": map[string]any{"assetId": "asset_uploaded"},
		"width": 10, "height": 10, "description": "An upload",
	}
	edit["commands"] = []map[string]any{{"type": "replace_question", "question_id": "q1", "question": question(uploaded, image)}}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "figure fig_q was not rendered") {
		t.Fatalf("unrendered figure: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(nodes) != 0 {
		t.Fatalf("the unrendered figure reached the authority: %+v", nodes)
	}

	edit["toolCallId"] = "call_quiz_fig"
	edit["figures"] = []map[string]any{{"id": "fig_q", "image": fakeJPEG(900)}}
	doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, edit)
	if len(nodes) != 1 {
		t.Fatalf("authority calls = %d, want 1", len(nodes))
	}
	blocks := nodes[0]["question"].(map[string]any)["parts"].([]any)[0].(map[string]any)["blocks"].([]any)
	if got := blocks[1].(map[string]any)["image"].(map[string]any)["assetId"]; got != "asset_uploaded" {
		t.Fatalf("uploaded image asset = %v, want it kept", got)
	}
	if got := blocks[2].(map[string]any)["image"].(map[string]any)["assetId"]; got != assetID {
		t.Fatalf("figure image asset = %v, want %s", got, assetID)
	}
	asset, err := st.GetEditorAsset(t.Context(), assetID)
	if err != nil || asset.MaterialID != quizID || !asset.Trashed {
		t.Fatalf("asset = %+v (%v), want the quiz's, trashed after the refusal", asset, err)
	}
	if n := assetObjects(t, mem, assetID); n != 1 {
		t.Fatalf("objects = %d, want 1", n)
	}
}
