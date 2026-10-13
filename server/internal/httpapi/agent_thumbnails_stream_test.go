package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A chat response whose agent committed edits to a DOCX starts one capture
// when it finishes, after the message is final: the collaboration server
// draws the file once, though the response edited it twice.
func TestAFinishedChatResponseCapturesItsEditedFileOnce(t *testing.T) {
	var st *store.Store
	var captures atomic.Int32
	collaboration := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captures.Add(1)
		w.Header().Set("Content-Type", "image/webp")
		_, _ = w.Write(webpLossless)
	}))
	t.Cleanup(collaboration.Close)
	// The agent's two edits of the file commit while the response streams.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AssistantMessageID string `json:"assistantMessageId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for i := range 2 {
			op := fmt.Sprintf("op_stream_thumb_%d", i)
			if _, err := st.Pool().Exec(r.Context(), `INSERT INTO agent_operations (id, kind, request_hash, actor_user_id, workspace_id, message_id, outcome, effect)
				VALUES ($1,'edit_document','h','u_editor','ws_e2e_private',$2,'succeeded',
				        '{"operation":"edited","resource":{"kind":"source_file","id":"f_stream_thumb"}}')`, op, body.AssistantMessageID); err != nil {
				t.Error(err)
			}
			if _, err := st.Pool().Exec(r.Context(), `INSERT INTO agent_edit_inverses (operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id, incarnation, revision, inverse, guards)
				VALUES ($1,'source_file','f_stream_thumb','u_editor','u_owner','ws_e2e_private',1,$2,'{"commands":[]}','[]')`, op, i+1); err != nil {
				t.Error(err)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"done\",\"answer\":\"Edited the plan.\"}\n\n")
	}))
	t.Cleanup(upstream.Close)
	h, opened, _, _ := openInternalHTTPWith(t, pipeline.New(upstream.URL, ""), func(s *store.Store, _ *httpapi.Config) {
		s.ConfigureCollaboration(collaboration.URL, "secret")
	})
	st = opened
	ctx := t.Context()
	if _, err := st.Pool().Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, name, kind, size_bytes, status)
		VALUES ('f_stream_thumb','ws_e2e_private','u_owner','plan.docx','doc',1,'ready')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(ctx, `DELETE FROM agent_operations WHERE id LIKE 'op_stream_thumb_%'`)
		_, _ = st.Pool().Exec(ctx, `DELETE FROM files WHERE id='f_stream_thumb'`)
	})
	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor", map[string]any{"title": "Thumbs"})
	var conv store.Conversation
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &conv) != nil {
		t.Fatalf("create conversation: %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(ctx, `DELETE FROM conversations WHERE id=$1`, conv.ID) })
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": conv.ID, "text": "edit the plan"})
	if rec.Code != http.StatusOK {
		t.Fatalf("chat stream: %d %s", rec.Code, rec.Body.String())
	}
	// The capture runs after the response; wait for its stored key.
	key := captureKey("f_stream_thumb", webpLossless)
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var got string
		if err := st.Pool().QueryRow(ctx, `SELECT COALESCE(thumbnail_key,'') FROM files WHERE id='f_stream_thumb'`).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got == key {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("thumbnail_key = %q after the response, want %q", got, key)
		}
	}
	if captures.Load() != 1 {
		t.Fatalf("captures asked = %d, want one", captures.Load())
	}
}
