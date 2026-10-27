package httpapi_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// An agent edit's Undo payload rides its tool_end to the browser and is
// never stored (Epo 2026-10-21): the turn's saved row holds none of it, and
// a payload past the 12 MiB bound is dropped rather than cut. Fails if the
// relay saves payloads with the turn or forwards an oversized one.
func TestChatUndoPayloadsReachTheBrowserOnly(t *testing.T) {
	for _, tc := range []struct {
		name      string
		size      int
		forwarded bool
	}{
		{"within the bound", 256 << 10, true},
		{"past the bound", 12<<20 + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			marker := "UNDOPAYLOADMARKER" + strings.Repeat("A", tc.size)
			toolEnd := fmt.Sprintf(`{"type":"tool_end","callId":"c1","outcome":"succeeded","endedAt":"2026-10-21T00:00:01.000Z","undoPayloads":[{"operationId":"op_1","documentId":"mat_1","epoch":1,"updates":{"content":%q},"mac":"ff"}]}`, marker)
			frames := []string{turnToolStart, toolEnd, turnCheckpoint, `{"type":"done","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				for _, frame := range frames {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
				}
			}))
			t.Cleanup(upstream.Close)
			h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
			convID := newTurnConversation(t, h, st)

			rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": convID, "text": "edit my note"})

			body := rec.Body.String()
			if !strings.Contains(body, `"tool_end"`) || strings.Contains(body, "UNDOPAYLOADMARKER") != tc.forwarded {
				t.Fatalf("stream forwarded the payload = %v, want %v", strings.Contains(body, "UNDOPAYLOADMARKER"), tc.forwarded)
			}
			var stored int
			if err := st.Pool().QueryRow(t.Context(), `
				SELECT count(*) FROM messages m
				 WHERE m.conversation_id=$1 AND m::text LIKE '%UNDOPAYLOADMARKER%'`, convID).Scan(&stored); err != nil {
				t.Fatal(err)
			}
			if stored != 0 {
				t.Fatalf("%d stored messages hold the payload", stored)
			}
			checkTurn(t, readTurn(t, st, convID), "complete", "checkpoint listing")
		})
	}
}
