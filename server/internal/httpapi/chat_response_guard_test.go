package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestFlaggedChatClearsPartialAnswerAndPersistsNotice(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range []string{
			`{"type":"block_start","blockId":"b1"}`,
			`{"type":"block_delta","blockId":"b1","text":"Partial answer"}`,
			`{"type":"block_end","blockId":"b1","kind":"answer"}`,
			`{"type":"citations","citations":[{"fileId":"f1","fileName":"source","snippet":"old"}]}`,
			`{"type":"error","code":"response_flagged","message":"Response flagged due to safety concern","activity":[{"id":"earlier","kind":"narration","text":"Earlier completed work"}]}`,
		} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
	}))
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor", map[string]any{"title": "Guard"})
	var conv store.Conversation
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &conv) != nil {
		t.Fatalf("create conversation: %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(t.Context(), `DELETE FROM conversations WHERE id=$1`, conv.ID) })
	rec = doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": conv.ID, "text": "hello"})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"code":"response_flagged"`) {
		t.Fatalf("missing live safety notice: %d %s", rec.Code, rec.Body.String())
	}
	messages, err := st.ListMessages(t.Context(), "u_editor", conv.ID)
	if err != nil || len(messages) != 2 {
		t.Fatalf("messages: %+v, %v", messages, err)
	}
	message := messages[1]
	if message.Status != "error" || message.ErrorCode != "response_flagged" || message.Content != "" || len(message.Citations) != 0 || len(message.Activity) != 1 {
		t.Fatalf("flagged turn retained partial output or lost completed activity: %+v", message)
	}
}
