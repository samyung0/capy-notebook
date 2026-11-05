package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// create_topic (Epo 2026-10-29) appends a topic named as asked or
// "Topic (n)" with the lowest free n, with its description (Epo 2026-11-03),
// and a replayed call returns the same
// topic; account chat adds only to a workspace the actor edits, and workspace
// chat only for an editor.
func TestChatCreatesATopic(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	ws, err := st.CreateWorkspace(ctx, "u_editor", store.WorkspaceCreate{Name: "Topics test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteWorkspace(ctx, "u_editor", ws.ID) })
	msg := seedAccountMessage(t, st, "u_editor")
	post := func(body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		return doInternal(t, h, http.MethodPost, "/api/internal/topics", pipeSecret, body)
	}
	create := func(callID, name string) map[string]any {
		t.Helper()
		rec := post(map[string]any{
			"scope": "account", "userId": "u_editor", "workspaceId": ws.ID,
			"assistantMessageId": msg, "toolCallId": callID, "name": name,
			"description": name,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", callID, rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := create("call_ch_1", "")
	named := create("call_ch_2", "Kinematics")
	second := create("call_ch_3", "")
	again := create("call_ch_1", "")
	if first["name"] != "Topic (1)" || named["name"] != "Kinematics" || second["name"] != "Topic (2)" {
		t.Fatalf("names = %v, %v, %v", first["name"], named["name"], second["name"])
	}
	if again["topicId"] != first["topicId"] || first["topicId"] != store.ChatTopicID(msg, "call_ch_1") {
		t.Fatalf("replay = %v, first = %v", again["topicId"], first["topicId"])
	}
	topics, err := st.ListTopics(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 3 || topics[2].ID != second["topicId"] || topics[1].Description != "Kinematics" {
		t.Fatalf("topics = %+v", topics)
	}

	// u_editor reaches ws_e2e_edit by link only; u_viewer views ws_e2e_private.
	if rec := post(map[string]any{
		"scope": "account", "userId": "u_editor", "workspaceId": "ws_e2e_edit",
		"assistantMessageId": msg, "toolCallId": "call_ch_4",
	}); rec.Code != http.StatusForbidden {
		t.Fatalf("link-only workspace: %d %s", rec.Code, rec.Body.String())
	}
	viewerMsg := seedAssistantMessage(t, st, "u_viewer", "ws_e2e_private")
	if rec := post(map[string]any{
		"userId": "u_viewer", "workspaceId": "ws_e2e_private",
		"assistantMessageId": viewerMsg, "toolCallId": "call_ch_5",
	}); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer: %d %s", rec.Code, rec.Body.String())
	}
}

// A frozen account adds no topic, as it creates no workspace.
func TestChatCreateTopicRefusesAFrozenAccount(t *testing.T) {
	f := overQuotaFixture(t, 20)
	h, st := openInternalHTTP(t)
	user := f.material.CreatedBy
	rec := doInternal(t, h, http.MethodPost, "/api/internal/topics", pipeSecret, map[string]any{
		"scope": "account", "userId": user, "workspaceId": f.workspaceID,
		"assistantMessageId": seedAccountMessage(t, st, user), "toolCallId": "call_frozen",
	})
	if rec.Code < 400 {
		t.Fatalf("frozen create_topic: %d %s", rec.Code, rec.Body.String())
	}
}
