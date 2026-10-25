package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A chat turn saves its tool calls and results however it ends (Epo
// 2026-10-21): these frames are a turn that finished one list_sources call.
const (
	turnToolStart  = `{"type":"tool_start","callId":"c1","name":"list_sources","detail":"listing sources","startedAt":"2026-10-21T00:00:00.000Z"}`
	turnToolEnd    = `{"type":"tool_end","callId":"c1","outcome":"succeeded","endedAt":"2026-10-21T00:00:01.000Z"}`
	turnCheckpoint = `{"type":"turn_checkpoint","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","detail":"listing sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`
)

type savedTurn struct {
	Status   string
	Activity []store.ActivityBlock `json:"activity"`
	Evidence struct {
		Tools []struct {
			Text string `json:"text"`
		} `json:"tools"`
	} `json:"toolEvidence"`
	ToolCalls int
}

// readTurn reads the conversation's assistant row as stored, evidence
// included, and its tool calls as the Ops view counts them.
func readTurn(t *testing.T, st *store.Store, convID string) savedTurn {
	t.Helper()
	var (
		turn savedTurn
		raw  []byte
	)
	if err := st.Pool().QueryRow(t.Context(), `
		SELECT m.status, m.metadata, jsonb_array_length(o.tool_calls)
		  FROM messages m JOIN ops_assistant_turns o ON o.id = m.id
		 WHERE m.conversation_id=$1 AND m.role='assistant'`, convID).
		Scan(&turn.Status, &raw, &turn.ToolCalls); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &turn); err != nil {
		t.Fatal(err)
	}
	return turn
}

func newTurnConversation(t *testing.T, h http.Handler, st *store.Store) string {
	t.Helper()
	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_editor", map[string]any{"title": "Turn saves"})
	var conv store.Conversation
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &conv) != nil {
		t.Fatalf("create conversation: %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, conv.ID)
	})
	return conv.ID
}

func checkTurn(t *testing.T, turn savedTurn, status string, evidence ...string) {
	t.Helper()
	var texts []string
	for _, tool := range turn.Evidence.Tools {
		texts = append(texts, tool.Text)
	}
	if turn.Status != status || len(turn.Activity) == 0 || turn.Activity[0].CallID != "c1" ||
		turn.ToolCalls != len(turn.Activity) || fmt.Sprint(texts) != fmt.Sprint(evidence) {
		t.Fatalf("saved turn = %+v, evidence %q; want %s with c1 and %q", turn, texts, status, evidence)
	}
}

func TestChatTurnEndingWithoutDoneSavesTheTurnSoFar(t *testing.T) {
	for _, tc := range []struct {
		name     string
		last     []string
		evidence string
	}{
		// The error's own evidence is newer than the checkpoint's.
		{"error", []string{`{"type":"error","code":"agent_failed","message":"The chat agent hit an internal error.","toolEvidence":{"tools":[{"name":"list_sources","text":"error listing"}],"passages":[],"skills":[]}}`}, "error listing"},
		// The pipeline dies: the stream ends without done.
		{"eof", nil, "checkpoint listing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frames := append([]string{turnToolStart, turnToolEnd, turnCheckpoint}, tc.last...)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				for _, frame := range frames {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
				}
			}))
			t.Cleanup(upstream.Close)
			h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
			convID := newTurnConversation(t, h, st)

			doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": convID, "text": "list my sources"})

			checkTurn(t, readTurn(t, st, convID), "error", tc.evidence)
		})
	}
}

// An Office edit the engine cut at a per-call limit (Epo 2026-10-23, Q171):
// the browser gets its tool_progress and its tool_end's counts, and the row
// keeps the counts the turn ended with.
func TestChatRelaysToolProgressAndSavesTheCommandsNotApplied(t *testing.T) {
	block := `{"id":"c1","kind":"tool","callId":"c1","name":"edit_office_document","outcome":"succeeded","applied":30,"total":32}`
	frames := []string{
		`{"type":"tool_start","callId":"c1","name":"edit_office_document","detail":"Budget.xlsx","startedAt":"2026-10-23T00:00:00.000Z"}`,
		`{"type":"tool_progress","callId":"c1","applied":30,"total":32}`,
		`{"type":"tool_end","callId":"c1","outcome":"succeeded","endedAt":"2026-10-23T00:00:01.000Z","applied":30,"total":32}`,
		`{"type":"done","activity":[` + block + `],"toolEvidence":{"tools":[],"passages":[],"skills":[]}}`,
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range frames {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
	}))
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	convID := newTurnConversation(t, h, st)

	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": convID, "text": "fill the budget"})

	counted := map[string]bool{}
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		var ev struct {
			Type    string `json:"type"`
			Applied *int   `json:"applied"`
			Total   *int   `json:"total"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) == nil &&
			ev.Applied != nil && ev.Total != nil && *ev.Applied == 30 && *ev.Total == 32 {
			counted[ev.Type] = true
		}
	}
	if !counted["tool_progress"] || !counted["tool_end"] {
		t.Fatalf("browser frames with 30 of 32: %v\n%s", counted, rec.Body.String())
	}
	saved := readTurn(t, st, convID).Activity
	if len(saved) != 1 || saved[0].Applied == nil || saved[0].Total == nil ||
		*saved[0].Applied != 30 || *saved[0].Total != 32 {
		t.Fatalf("saved activity = %+v, want 30 of 32 applied", saved)
	}
}
