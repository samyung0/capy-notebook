package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Q468 (Epo 2026-10-28): a file this workspace's chat edited, now in a
// workspace the user cannot read, answers `moved_out` to the next edit and
// read, so the model can tell the user it was moved out. Security: a file
// with no edit receipt in this workspace, living in another one, stays a
// plain not found, so the answer never confirms it exists elsewhere. Fails
// if the refusal ignores the receipt (always or never `moved_out`).
func TestAFileEditedHereThenMovedOutAnswersMovedOut(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	elsewhere, err := st.CreateWorkspace(ctx, "u_other", store.WorkspaceCreate{Name: "Not yours " + suffix, Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, elsewhere.ID)
	})
	file, stranger := "f_moved_"+suffix, "f_stranger_"+suffix
	for id, ws := range map[string]string{file: "ws_e2e_private", stranger: elsewhere.ID} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO files (id,workspace_id,user_id,created_by,name,kind,size_bytes,status,parse_mode)
			VALUES ($1,$2,'u_owner','u_owner','notes.txt','txt',0,'ready','none')`, id, ws); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id) })
	}
	// The room commits the edit's receipt with its checkpoint.
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Operation store.DocumentOperation `json:"operation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		effect := fmt.Sprintf(`{"operation":"edited","resource":{"kind":"source_file","id":%q}}`, file)
		if _, err := st.Pool().Exec(context.Background(), `INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,workspace_id,outcome,effect)
			VALUES ($1,'edit_document',$2,'u_editor','ws_e2e_private','succeeded',$3)`, body.Operation.ID, body.Operation.RequestHash, effect); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"operationId": body.Operation.ID, "outcome": "succeeded", "kind": "edit_document", "effect": json.RawMessage(effect)})
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	edit := func(id, call string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"assistantMessageId": msgID, "toolCallId": call,
			"target":   map[string]any{"kind": "source_file", "id": id},
			"commands": []map[string]any{{"type": "replace_text", "target_id": "t1", "expected_text": "a", "text": "b"}},
		})
	}
	read := func(id string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/documents/inspect", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"target": map[string]any{"kind": "source_file", "id": id},
		})
	}
	code := func(rec *httptest.ResponseRecorder) string {
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Code
	}

	if rec := edit(file, "call_before"); rec.Code != http.StatusOK {
		t.Fatalf("the edit before the Move: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE files SET workspace_id=$2 WHERE id=$1`, file, elsewhere.ID); err != nil {
		t.Fatal(err)
	}
	for name, rec := range map[string]*httptest.ResponseRecorder{"edit": edit(file, "call_after"), "read": read(file)} {
		if rec.Code != http.StatusNotFound || code(rec) != "moved_out" {
			t.Fatalf("the %s after the Move: %d %s, want moved_out", name, rec.Code, rec.Body.String())
		}
	}
	for name, rec := range map[string]*httptest.ResponseRecorder{"edit": edit(stranger, "call_stranger"), "read": read(stranger)} {
		if rec.Code != http.StatusNotFound || code(rec) != "" {
			t.Fatalf("the %s of a file never edited here: %d %s, want a plain not found", name, rec.Code, rec.Body.String())
		}
	}
}
