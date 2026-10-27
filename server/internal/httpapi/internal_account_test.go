package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
		Kind         string   `json:"kind"`
		WorkspaceIDs []string `json:"workspaceIds"`
		WorkspaceID  string   `json:"workspaceId"`
		UserID       string   `json:"userId"`
	}
	if err := json.Unmarshal(account["scope"], &scope); err != nil {
		t.Fatal(err)
	}
	if scope.Kind != "account" || scope.UserID != "u_editor" ||
		!slices.Contains(scope.WorkspaceIDs, "ws_e2e_private") || !slices.Contains(scope.WorkspaceIDs, "ws_e2e_agent") ||
		slices.Contains(scope.WorkspaceIDs, "ws_e2e_edit") {
		t.Fatalf("account scope = %+v", scope)
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

	code, body = call("/api/internal/documents/list", map[string]any{"userId": "u_editor"})
	var listed struct {
		Items []struct {
			ID, WorkspaceID, WorkspaceName string
		}
	}
	if err := json.Unmarshal([]byte(body), &listed); err != nil || code != http.StatusOK {
		t.Fatalf("account list: %d %s", code, body)
	}
	ids := map[string]string{}
	for _, item := range listed.Items {
		ids[item.ID] = item.WorkspaceName
	}
	if ids["f_e2e_private"] != "E2E Private Workspace" || ids[created] != "" {
		t.Fatalf("account list = %+v", listed.Items)
	}
	if _, ok := ids[created]; !ok {
		t.Fatal("account list misses the standalone note")
	}
	if _, ok := ids["f_e2e_edit"]; ok {
		t.Fatal("account list shows a link-reached workspace's file")
	}
}
