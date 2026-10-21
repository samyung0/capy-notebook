package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/auth"
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

func TestChatTurnStoppedAfterACheckpointKeepsItAndItsReceipts(t *testing.T) {
	var st *store.Store
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AssistantMessageID string `json:"assistantMessageId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		// A write the checkpoint never saw: its receipt is all Go has of it.
		// It goes with the conversation.
		if _, err := st.Pool().Exec(r.Context(), `
			INSERT INTO agent_operations (id, kind, request_hash, workspace_id, conversation_id, message_id, call_id, outcome, effect)
			SELECT $1, 'create_material', 'h', 'ws_e2e_private', conversation_id, id, 'c2', 'succeeded',
			       '{"operation":"created","resource":{"kind":"material","id":"mat_turn","title":"Note"}}'
			  FROM messages WHERE id=$2`,
			"op_turn_"+body.AssistantMessageID, body.AssistantMessageID); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range []string{turnToolStart, turnToolEnd, turnCheckpoint} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
		w.(http.Flusher).Flush()
		// The turn goes on until the gateway hangs up.
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	t.Cleanup(upstream.Close)
	h, opened, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	st = opened
	convID := newTurnConversation(t, h, st)

	raw, err := json.Marshal(map[string]any{"conversationId": convID, "text": "make me a note"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(t.Context())
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", bytes.NewReader(raw)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		h.ServeHTTP(httptest.NewRecorder(), req)
	}()

	// The checkpoint reaches the streaming row before the user stops.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var streaming bool
		err := st.Pool().QueryRow(t.Context(), `
			SELECT status='streaming' AND metadata ? 'toolEvidence' FROM messages
			 WHERE conversation_id=$1 AND role='assistant'`, convID).Scan(&streaming)
		if err == nil && streaming {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the turn checkpoint never reached the streaming row")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("the stream did not end after the stop")
	}

	turn := readTurn(t, st, convID)
	checkTurn(t, turn, "aborted", "checkpoint listing")
	if len(turn.Activity) != 2 || turn.Activity[1].CallID != "c2" || len(turn.Activity[1].Effects) != 1 {
		t.Fatalf("the receipt was not merged into the checkpoint's activity: %+v", turn.Activity)
	}
}
