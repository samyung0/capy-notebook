package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Seeded reach (e2e/fixtures/seed.sql): u_editor edits ws_e2e_private and
// ws_e2e_agent as a member and reaches ws_e2e_edit by link only; u_viewer
// views ws_e2e_private and is a member of ws_e2e_edit, whose link grants
// editing.

// seedAccountMessage is seedAssistantMessage in an account conversation.
func seedAccountMessage(t *testing.T, st *store.Store, userID string) string {
	t.Helper()
	ctx := context.Background()
	convID := fmt.Sprintf("conv_acct_%d", time.Now().UnixNano())
	msgID := fmt.Sprintf("m_acct_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO conversations (id, user_id) VALUES ($1,$2)`, convID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO messages (id, conversation_id, role, status) VALUES ($1,$2,'assistant','streaming')`,
		msgID, convID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, convID)
	})
	return msgID
}

// An account turn names its scope (owned and member workspaces, never one
// reached by link) instead of a workspace, role, open item or study progress;
// a workspace turn names its workspace in scope too. The account conversation
// is listed to its owner alone and never continues on a workspace route.
func TestAccountChatStreamSendsItsScope(t *testing.T) {
	h, st, bodies := streamCapture(t)
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM conversations WHERE workspace_id IS NULL AND user_id='u_editor' AND title LIKE 'teach me%'`)
	})
	rec := doAsUser(t, h, http.MethodPost, "/api/chat/stream", "u_editor",
		map[string]any{"text": "teach me across my files", "openResource": map[string]any{"id": "f_e2e_private", "kind": "file"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("account turn: status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
		map[string]any{"text": "teach me in a workspace"})
	if rec.Code != http.StatusOK {
		t.Fatalf("workspace turn: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(*bodies) != 2 {
		t.Fatalf("relayed turns = %d", len(*bodies))
	}
	account := (*bodies)[0]
	var scope struct {
		Kind        string                 `json:"kind"`
		Workspaces  []store.ScopeWorkspace `json:"workspaces"`
		WorkspaceID string                 `json:"workspaceId"`
		UserID      string                 `json:"userId"`
	}
	if err := json.Unmarshal(account["scope"], &scope); err != nil {
		t.Fatal(err)
	}
	named := map[string]store.ScopeWorkspace{}
	for _, ws := range scope.Workspaces {
		named[ws.ID] = ws
	}
	if scope.Kind != "account" || scope.UserID != "u_editor" ||
		named["ws_e2e_private"].Name == "" || named["ws_e2e_agent"].Name == "" {
		t.Fatalf("account scope = %+v", scope)
	}
	if _, ok := named["ws_e2e_edit"]; ok {
		t.Fatalf("account scope holds a link-reached workspace: %+v", scope)
	}
	for _, key := range []string{"workspaceId", "role", "openResource", "studyProgress"} {
		if _, ok := account[key]; ok {
			t.Errorf("account turn carries %s", key)
		}
	}
	ops := operationsOf(t, account)
	for _, op := range []string{"source.read", "material.read", "material.create", "document.edit", "library.read"} {
		if !slices.Contains(ops, op) {
			t.Errorf("account turn lacks %s: %v", op, ops)
		}
	}
	if slices.Contains(ops, "resource.trash") || slices.Contains(ops, "trash.restore") {
		t.Errorf("account turn was granted trash: %v", ops)
	}
	if err := json.Unmarshal((*bodies)[1]["scope"], &scope); err != nil {
		t.Fatal(err)
	}
	if scope.Kind != "workspace" || scope.WorkspaceID != "ws_e2e_private" {
		t.Fatalf("workspace scope = %+v", scope)
	}

	var listed []store.Conversation
	rec = doAsUser(t, h, http.MethodGet, "/api/conversations", "u_editor", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("account list: %d %s", rec.Code, rec.Body.String())
	}
	at := slices.IndexFunc(listed, func(c store.Conversation) bool { return c.Title == "teach me across my files" })
	if at < 0 || listed[at].WorkspaceID != "" {
		t.Fatalf("account list = %+v", listed)
	}
	convID := listed[at].ID
	rec = doAsUser(t, h, http.MethodGet, "/api/conversations", "u_viewer", nil)
	if strings.Contains(rec.Body.String(), convID) {
		t.Fatal("another user lists the account conversation")
	}
	if rec := doAsUser(t, h, http.MethodGet, "/api/conversations/"+convID+"/messages", "u_viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("another user's messages: status = %d", rec.Code)
	}
	if rec := doAsUser(t, h, http.MethodGet, "/api/conversations/"+convID+"/messages", "u_editor", nil); rec.Code != http.StatusOK {
		t.Fatalf("owner's messages: status = %d", rec.Code)
	}
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
		map[string]any{"conversationId": convID, "text": "teach me more"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("account conversation on a workspace route: status = %d", rec.Code)
	}
}

func TestInternalDocumentAccess(t *testing.T) {
	h, st := openInternalHTTP(t)
	standalone := fmt.Sprintf("f_acct_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(t.Context(), `INSERT INTO files (id, user_id, created_by, name, kind, size_bytes, status)
		VALUES ($1,'u_editor','u_editor','mine.md','md',10,'ready')`, standalone); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM files WHERE id=$1`, standalone) })
	type row struct {
		Kind, ID, WorkspaceID, WorkspaceName string
		CanRead, CanEdit                     bool
	}
	ask := func(user string, ids ...string) []row {
		t.Helper()
		items := []map[string]string{}
		for _, id := range ids {
			items = append(items, map[string]string{"kind": "source_file", "id": id})
		}
		rec := doInternal(t, h, http.MethodPost, "/api/internal/documents/access", pipeSecret,
			map[string]any{"actorUserId": user, "items": items})
		var out struct{ Items []row }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("access %s: %d %s", user, rec.Code, rec.Body.String())
		}
		return out.Items
	}
	got := ask("u_viewer", "f_e2e_private", "f_e2e_edit", "f_e2e_link", standalone)
	want := []row{
		{"source_file", "f_e2e_private", "ws_e2e_private", "E2E Private Workspace", true, false},
		{"source_file", "f_e2e_edit", "ws_e2e_edit", "E2E Editable Link Workspace", true, true},
		{"source_file", "f_e2e_link", "", "", false, false},
		{"source_file", standalone, "", "", false, false},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("viewer access = %+v, want %+v", got, want)
	}
	got = ask("u_editor", "f_e2e_private", "f_e2e_edit", standalone)
	if !got[0].CanEdit || got[1].CanRead || !got[2].CanRead || !got[2].CanEdit || got[2].WorkspaceID != "" {
		t.Fatalf("editor access = %+v", got)
	}
	if rec := doInternal(t, h, http.MethodPost, "/api/internal/documents/access", "", map[string]any{"actorUserId": "u_editor"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no secret: status = %d", rec.Code)
	}
}

// Account-scope calls check their own target: an item outside the scope is
// not found, one the actor views is not edited, a workspace message cannot
// stand in for an account one, and creating with no workspace makes a
// standalone item while a workspace needs the actor's editor role there.
func TestAccountScopeCallsCheckTheirTarget(t *testing.T) {
	h, st := openInternalHTTP(t)
	editorMsg := seedAccountMessage(t, st, "u_editor")
	viewerMsg := seedAccountMessage(t, st, "u_viewer")
	call := func(path string, body map[string]any) (int, string) {
		t.Helper()
		body["scope"] = "account"
		rec := doInternal(t, h, http.MethodPost, path, pipeSecret, body)
		return rec.Code, rec.Body.String()
	}
	target := func(id string) map[string]any { return map[string]any{"kind": "source_file", "id": id} }
	edit := []map[string]any{{"type": "replace_text", "target_id": "x", "expected_text": "a", "text": "b"}}

	if code, body := call("/api/internal/documents/inspect", map[string]any{"userId": "u_editor", "target": target("f_e2e_edit")}); code != http.StatusNotFound {
		t.Fatalf("inspect outside the scope: %d %s", code, body)
	}
	if code, body := call("/api/internal/documents/inspect", map[string]any{
		"userId": "u_editor", "workspaceId": "ws_e2e_private", "target": target("f_e2e_private"),
	}); code != http.StatusBadRequest {
		t.Fatalf("inspect naming a workspace: %d %s", code, body)
	}
	if code, body := call("/api/internal/documents/edit", map[string]any{
		"userId": "u_viewer", "assistantMessageId": viewerMsg, "toolCallId": "call_view",
		"target": target("f_e2e_private"), "commands": edit,
	}); code != http.StatusForbidden || !strings.Contains(body, "permission_denied") {
		t.Fatalf("edit of a viewed file: %d %s", code, body)
	}
	if code, body := call("/api/internal/documents/edit", map[string]any{
		"userId": "u_editor", "assistantMessageId": seedAssistantMessage(t, st, "u_editor", "ws_e2e_private"),
		"toolCallId": "call_ws", "target": target("f_e2e_private"), "commands": edit,
	}); code != http.StatusNotFound {
		t.Fatalf("edit through a workspace message: %d %s", code, body)
	}

	note := func(callID, workspaceID string) map[string]any {
		body := noteBody(editorMsg, callID, "Account note "+callID, "# Account\n\nWritten across files.")
		body["workspaceId"] = workspaceID
		return body
	}
	code, body := call("/api/internal/materials", note("call_standalone", ""))
	if code != http.StatusOK {
		t.Fatalf("standalone create: %d %s", code, body)
	}
	created := store.ChatMaterialID(editorMsg, "call_standalone")
	cleanupMaterial(t, st, created)
	var workspaceID *string
	var owner string
	if err := st.Pool().QueryRow(t.Context(), `SELECT workspace_id, owner_user_id FROM materials WHERE id=$1`, created).
		Scan(&workspaceID, &owner); err != nil {
		t.Fatal(err)
	}
	if workspaceID != nil || owner != "u_editor" {
		t.Fatalf("created material workspace=%v owner=%s, want standalone and the actor's", workspaceID, owner)
	}
	if code, body := call("/api/internal/materials", note("call_link", "ws_e2e_edit")); code != http.StatusForbidden {
		t.Fatalf("create in a link-reached workspace: %d %s", code, body)
	}
	code, body = call("/api/internal/materials", note("call_member", "ws_e2e_private"))
	if code != http.StatusOK {
		t.Fatalf("create in a member workspace: %d %s", code, body)
	}
	cleanupMaterial(t, st, store.ChatMaterialID(editorMsg, "call_member"))

	// One workspace, or else no workspace.
	list := func(fields map[string]any) map[string]string {
		t.Helper()
		req := map[string]any{"userId": "u_editor"}
		for k, v := range fields {
			req[k] = v
		}
		code, body := call("/api/internal/documents/list", req)
		var listed struct {
			Items []struct {
				ID, WorkspaceID, WorkspaceName string
			}
		}
		if err := json.Unmarshal([]byte(body), &listed); err != nil || code != http.StatusOK {
			t.Fatalf("account list %v: %d %s", fields, code, body)
		}
		ids := map[string]string{}
		for _, item := range listed.Items {
			ids[item.ID] = item.WorkspaceName
		}
		return ids
	}
	if ids := list(map[string]any{"workspaceId": "ws_e2e_private"}); ids["f_e2e_private"] != "E2E Private Workspace" {
		t.Fatalf("workspace list = %+v", ids)
	} else if _, ok := ids[created]; ok {
		t.Fatal("workspace list shows the standalone note")
	}
	if ids := list(nil); len(ids) == 0 || ids["f_e2e_private"] != "" {
		t.Fatalf("no-workspace list = %+v", ids)
	} else if _, ok := ids[created]; !ok {
		t.Fatal("no-workspace list misses the standalone note")
	}
	if ids := list(map[string]any{"workspaceId": "ws_e2e_edit"}); len(ids) != 0 {
		t.Fatalf("a link-reached workspace listed %+v", ids)
	}
}

// Account chat's create_workspace (Epo 2026-10-28) makes a workspace of the
// actor's own, named "New Workspace (n)" with the lowest free n when unnamed,
// with a Waves icon; a replayed call creates nothing twice.
func TestAccountChatCreatesAWorkspace(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	msg := seedAccountMessage(t, st, "u_editor")
	create := func(callID string, fields map[string]any) map[string]any {
		t.Helper()
		body := map[string]any{"scope": "account", "userId": "u_editor", "assistantMessageId": msg, "toolCallId": callID}
		for k, v := range fields {
			body[k] = v
		}
		rec := doInternal(t, h, http.MethodPost, "/api/internal/workspaces", pipeSecret, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", callID, rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = st.DeleteWorkspace(ctx, "u_editor", out["workspaceId"].(string)) })
		return out
	}
	first := create("call_ws_1", nil)
	second := create("call_ws_2", nil)
	named := create("call_ws_3", map[string]any{"name": "Organic chemistry", "description": "Year 2", "tags": []string{"chem"}})
	again := create("call_ws_1", nil)

	if first["name"] != "New Workspace (1)" || second["name"] != "New Workspace (2)" || named["name"] != "Organic chemistry" {
		t.Fatalf("names = %v, %v, %v", first["name"], second["name"], named["name"])
	}
	if again["workspaceId"] != first["workspaceId"] {
		t.Fatalf("replay made %v, want %v", again["workspaceId"], first["workspaceId"])
	}
	// The same call with other fields is a conflict, not a second workspace.
	rec := doInternal(t, h, http.MethodPost, "/api/internal/workspaces", pipeSecret, map[string]any{
		"scope": "account", "userId": "u_editor", "assistantMessageId": msg, "toolCallId": "call_ws_1", "name": "Other",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay with other fields: %d %s", rec.Code, rec.Body.String())
	}
	ws, err := st.GetWorkspace(ctx, "u_editor", named["workspaceId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if ws.Description != "Year 2" || len(ws.Tags) != 1 || !strings.HasPrefix(ws.IconID, "waves-") {
		t.Fatalf("created workspace = %+v", ws)
	}
}

// An item's unindexed changes are read by id with the actor's access checked
// per item (Epo 2026-10-28): a member workspace's text file answers its stored
// changes, a standalone Office file's come from the collaboration service
// asked under workspace "", and a file the actor only reached by link is not
// found.
func TestAccountChatReadsAnItemsChanges(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	textID, officeID := fmt.Sprintf("f_chg_%d", time.Now().UnixNano()), fmt.Sprintf("f_chg_o_%d", time.Now().UnixNano())
	exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
		SELECT $1, w.id, w.user_id, w.user_id, 'notes.md', 'md', 10, 'ready' FROM workspaces w WHERE w.id='ws_e2e_private'`, textID)
	exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
		VALUES ($1, NULL, 'u_editor', 'u_editor', 'plan.docx', 'docx', 10, 'ready')`, officeID)
	t.Cleanup(func() { exec(`DELETE FROM files WHERE id = ANY($1)`, []string{textID, officeID}) })
	exec(`INSERT INTO source_documents (user_id, file_id, format, checkpoint, indexed_checkpoint, base_revision, base_blob_path, pending_effects)
		SELECT f.user_id, f.id, 'text', 1, 0, 1, 'x', '[{"id":"e1","operation":"add","after":"new line"}]' FROM files f WHERE f.id=$1`, textID)
	exec(`INSERT INTO source_documents (user_id, file_id, format, checkpoint, indexed_checkpoint, base_revision, base_blob_path)
		VALUES ('u_editor', $1, 'docx', 2, 1, 1, 'x')`, officeID)

	changes := func(id string) (int, map[string]json.RawMessage) {
		t.Helper()
		rec := doInternal(t, h, http.MethodPost, "/api/internal/changes", pipeSecret, map[string]any{
			"actorUserId": "u_editor", "items": []map[string]any{{"kind": "source_file", "id": id}},
		})
		var out map[string]json.RawMessage
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, text := changes(textID)
	if code != http.StatusOK || !strings.Contains(string(text["files"]), "new line") ||
		!strings.Contains(string(text["files"]), `"workspaceId":"ws_e2e_private"`) {
		t.Fatalf("text file changes: %d %s", code, text["files"])
	}
	var asked map[string]any
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&asked)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"files": []any{map[string]any{
			"fileId": officeID, "epoch": 0, "checkpoint": 2,
			"changes": []any{map[string]any{"id": "c1", "kind": "image", "operation": "add", "label": "body, image"}},
		}}, "failed": []any{}})
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	code, office := changes(officeID)
	if code != http.StatusOK || !strings.Contains(string(office["files"]), `"label":"body, image"`) {
		t.Fatalf("standalone Office changes: %d %s", code, office["files"])
	}
	if asked["workspaceId"] != "" {
		t.Fatalf("standalone Office files are asked under workspace %q", asked["workspaceId"])
	}
	if code, _ := changes("f_e2e_edit"); code != http.StatusNotFound {
		t.Fatalf("a link-reached file's changes: %d", code)
	}
	// Another user's file with no workspace is not found, to read or resolve.
	theirs := fmt.Sprintf("f_chg_t_%d", time.Now().UnixNano())
	exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
		VALUES ($1, NULL, 'u_viewer', 'u_viewer', 'theirs.md', 'md', 10, 'ready')`, theirs)
	t.Cleanup(func() { exec(`DELETE FROM files WHERE id=$1`, theirs) })
	if code, _ := changes(theirs); code != http.StatusNotFound {
		t.Fatalf("another user's standalone file's changes: %d", code)
	}
	resolve := func(item map[string]any) int {
		t.Helper()
		return doInternal(t, h, http.MethodPost, "/api/internal/changes/resolve", pipeSecret, map[string]any{
			"actorUserId": "u_editor", "item": item, "blockId": "b1",
		}).Code
	}
	if code := resolve(map[string]any{"kind": "source_file", "id": theirs}); code != http.StatusNotFound {
		t.Fatalf("resolving another user's file: %d", code)
	}
	note, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_editor", Kind: "note", Title: "Mine", Content: noteTestContent(t, "# Mine\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupMaterial(t, st, note.ID) })
	if code := resolve(map[string]any{"kind": "material", "id": note.ID}); code != http.StatusNotFound {
		t.Fatalf("resolving a note with no workspace (never indexed): %d", code)
	}
}

// create_workspace past the plan's workspace cap is refused as the New
// workspace dialog's create is (workspace_limit_exceeded).
func TestAccountChatCreateWorkspaceHonoursTheCap(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	user := fmt.Sprintf("u_cap_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email) VALUES ($1, 'Cap', $1 || '@capynotebook.test')`, user); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(ctx, `DELETE FROM users WHERE id=$1`, user) })
	for i := 0; ; i++ {
		_, err := st.CreateWorkspace(ctx, user, store.WorkspaceCreate{Name: fmt.Sprintf("W%d", i)})
		if errors.Is(err, store.ErrWorkspaceLimitExceeded) {
			break
		}
		if err != nil || i > 100 {
			t.Fatalf("filling the cap: %v", err)
		}
	}
	msg := seedAccountMessage(t, st, user)
	rec := doInternal(t, h, http.MethodPost, "/api/internal/workspaces", pipeSecret, map[string]any{
		"scope": "account", "userId": user, "assistantMessageId": msg, "toolCallId": "call_cap",
	})
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "workspace_limit_exceeded") {
		t.Fatalf("create past the cap: %d %s", rec.Code, rec.Body.String())
	}
}
