package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A slow second call (c2) that is still running when the user stops.
const (
	slowToolStart = `{"type":"tool_start","callId":"c2","name":"list_sources","detail":"listing sources","startedAt":"2026-10-21T00:00:02.000Z"}`
	slowToolEnd   = `{"type":"tool_end","callId":"c2","outcome":"succeeded","endedAt":"2026-10-21T00:00:09.000Z"}`
	stoppedFinal  = `{"type":"turn_checkpoint","stopped":true,"tokenCount":42,` +
		`"activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"},{"id":"c2","kind":"tool","callId":"c2","name":"list_sources","outcome":"succeeded"}],` +
		`"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"},{"name":"list_sources","text":"slow listing"}],"passages":[],"skills":[]}}`
)

// browserTurn starts a chat turn as u_editor the way a browser does; cancel
// is the browser going away. done closes when the handler returns.
func browserTurn(t *testing.T, h http.Handler, convID string) (cancel context.CancelFunc, done chan struct{}) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"conversationId": convID, "text": "list my sources"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", bytes.NewReader(raw)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	done = make(chan struct{})
	go func() {
		defer close(done)
		h.ServeHTTP(httptest.NewRecorder(), req)
	}()
	t.Cleanup(cancel)
	return cancel, done
}

// waitForCheckpoint waits until the turn's first checkpoint is on its
// streaming row and returns the row's id.
func waitForCheckpoint(t *testing.T, st *store.Store, convID string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var id string
		err := st.Pool().QueryRow(t.Context(), `
			SELECT id FROM messages WHERE conversation_id=$1 AND role='assistant'
			   AND status='streaming' AND metadata ? 'toolEvidence'`, convID).Scan(&id)
		if err == nil {
			return id
		}
		if time.Now().After(deadline) {
			t.Fatal("the turn checkpoint never reached the streaming row")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitClosed(t *testing.T, ch chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func sessionStatus(t *testing.T, st *store.Store, id string) string {
	t.Helper()
	var status string
	if err := st.Pool().QueryRow(t.Context(), `SELECT status FROM provider_sessions WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

// Stop ends the turn at once (Epo 2026-10-21): the row is listed aborted right
// away, the call still running finishes on a pipeline request the browser's
// departure does not cancel, and its call and result join the row once, with
// its receipt; credits settle after it, once.
func TestChatStopSavesTheTurnAtOnceAndAddsTheRunningCall(t *testing.T) {
	var (
		st                 *store.Store
		stopOnce           sync.Once
		mu                 sync.Mutex
		spendID, messageID string
		lateCancelled      atomic.Bool
	)
	stopped, release := make(chan struct{}), make(chan struct{})
	lateCancelled.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/stop" {
			var body struct {
				AssistantMessageID string `json:"assistantMessageId"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			running := messageID
			mu.Unlock()
			if body.AssistantMessageID == running {
				stopOnce.Do(func() { close(stopped) })
			}
			_, _ = w.Write([]byte(`{"stopped":true}`))
			return
		}
		var body struct {
			AssistantMessageID string `json:"assistantMessageId"`
			SpendSessionID     string `json:"spendSessionId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		mu.Lock()
		messageID, spendID = body.AssistantMessageID, body.SpendSessionID
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range []string{turnToolStart, turnToolEnd, turnCheckpoint, slowToolStart} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
		w.(http.Flusher).Flush()
		select {
		case <-stopped:
		case <-time.After(10 * time.Second):
			return
		}
		select {
		case <-release:
		case <-time.After(10 * time.Second):
			return
		}
		lateCancelled.Store(r.Context().Err() != nil)
		// The running call committed a write: its receipt names c2 as well.
		if _, err := st.Pool().Exec(context.Background(), `
			INSERT INTO agent_operations (id, kind, request_hash, workspace_id, conversation_id, message_id, call_id, outcome, effect)
			SELECT $1, 'create_material', 'h', 'ws_e2e_private', conversation_id, id, 'c2', 'succeeded',
			       '{"operation":"created","resource":{"kind":"material","id":"mat_stop","title":"Note"}}'
			  FROM messages WHERE id=$2`, "op_stop_"+body.AssistantMessageID, body.AssistantMessageID); err != nil {
			t.Error(err)
		}
		for _, frame := range []string{slowToolEnd, stoppedFinal} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
	}))
	t.Cleanup(upstream.Close)
	h, opened, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	st = opened
	convID := newTurnConversation(t, h, st)
	leave, finished := browserTurn(t, h, convID)
	msgID := waitForCheckpoint(t, st, convID)
	mu.Lock()
	spend := spendID
	mu.Unlock()
	stopPath := fmt.Sprintf("/api/conversations/%s/messages/%s/stop", convID, msgID)

	// Someone else's turn, or a row that is not this conversation's turn.
	if rec := doAsUser(t, h, http.MethodPost, stopPath, "u_owner", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("the workspace owner stopped another user's turn: %d %s", rec.Code, rec.Body.String())
	}
	var userID string
	if err := st.Pool().QueryRow(t.Context(), `SELECT id FROM messages WHERE conversation_id=$1 AND role='user'`, convID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if rec := doAsUser(t, h, http.MethodPost, fmt.Sprintf("/api/conversations/%s/messages/%s/stop", convID, userID), "u_editor", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a user message was stopped: %d", rec.Code)
	}

	if rec := doAsUser(t, h, http.MethodPost, stopPath, "u_editor", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("stop: %d %s", rec.Code, rec.Body.String())
	}
	// History lists the stopped turn now, with what it had finished.
	rec := doAsUser(t, h, http.MethodGet, "/api/conversations/"+convID+"/messages", "u_editor", nil)
	var listed []store.Message
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed) != 2 {
		t.Fatalf("messages: %s, %v", rec.Body.String(), err)
	}
	if got := listed[1]; got.Status != "aborted" || len(got.Activity) != 1 || got.Activity[0].CallID != "c1" {
		t.Fatalf("the stopped turn is not listed at once: %+v", got)
	}
	if status := sessionStatus(t, st, spend); status != "open" {
		t.Fatalf("credits settled before the running call finished: %s", status)
	}
	leave() // the browser stops reading
	if rec := doAsUser(t, h, http.MethodPost, stopPath, "u_editor", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("a second stop: %d", rec.Code)
	}
	close(release)
	waitClosed(t, finished, "the turn's end")

	if lateCancelled.Load() {
		t.Fatal("the pipeline request was cancelled after the stop")
	}
	turn := readTurn(t, st, convID)
	checkTurn(t, turn, "aborted", "checkpoint listing", "slow listing")
	if len(turn.Activity) != 2 || turn.Activity[1].CallID != "c2" || len(turn.Activity[1].Effects) != 1 {
		t.Fatalf("the running call was not added once with its receipt: %+v", turn.Activity)
	}
	var tokens int
	if err := st.Pool().QueryRow(t.Context(), `SELECT token_count FROM messages WHERE id=$1`, msgID).Scan(&tokens); err != nil || tokens != 42 {
		t.Fatalf("token count = %d, %v", tokens, err)
	}
	if status := sessionStatus(t, st, spend); status != "settled" {
		t.Fatalf("credits = %s, want settled", status)
	}
	// Stopping a finished turn does nothing.
	if rec := doAsUser(t, h, http.MethodPost, stopPath, "u_editor", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("stop after the end: %d", rec.Code)
	}
}

// A turn whose browser leaves without Stop runs to completion and is saved
// with its answer (Epo 2026-10-21).
func TestChatTurnRunsToCompletionAfterTheBrowserLeaves(t *testing.T) {
	left := make(chan struct{})
	var lateCancelled atomic.Bool
	lateCancelled.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range []string{turnToolStart, turnToolEnd, turnCheckpoint} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
		w.(http.Flusher).Flush()
		select {
		case <-left:
		case <-time.After(10 * time.Second):
			return
		}
		lateCancelled.Store(r.Context().Err() != nil)
		for _, frame := range []string{
			`{"type":"block_start","blockId":"b2"}`,
			`{"type":"block_delta","blockId":"b2","text":"Finished answer"}`,
			`{"type":"block_end","blockId":"b2","kind":"answer"}`,
			`{"type":"done","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`,
		} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
	}))
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	convID := newTurnConversation(t, h, st)
	leave, finished := browserTurn(t, h, convID)
	waitForCheckpoint(t, st, convID)

	leave()
	close(left)
	waitClosed(t, finished, "the turn's end")

	if lateCancelled.Load() {
		t.Fatal("the browser leaving cancelled the pipeline request")
	}
	checkTurn(t, readTurn(t, st, convID), "complete", "checkpoint listing")
	var content string
	if err := st.Pool().QueryRow(t.Context(), `SELECT content FROM messages WHERE conversation_id=$1 AND role='assistant'`, convID).Scan(&content); err != nil || content != "Finished answer" {
		t.Fatalf("answer = %q, %v", content, err)
	}
}
