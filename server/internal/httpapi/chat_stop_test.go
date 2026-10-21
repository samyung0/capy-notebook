package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
		`"activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","detail":"listing sources","outcome":"succeeded"},{"id":"c2","kind":"tool","callId":"c2","name":"list_sources","detail":"listing sources","outcome":"succeeded"}],` +
		`"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"},{"name":"list_sources","text":"slow listing"}],"passages":[],"skills":[]}}`
)

// stopPipe is a fake retrieval service for one turn. Its stream sends first,
// then waits until the test releases it (or Go hangs up) and sends what late
// writes; /chat/stop answers stopStatus.
type stopPipe struct {
	first      []string
	late       func(w io.Writer, msgID string)
	stopStatus int

	release       chan struct{}
	stops         atomic.Int32
	lateCancelled atomic.Bool

	mu             sync.Mutex
	msgID, spendID string
	history        json.RawMessage // the last request's
}

func newStopPipe(late func(w io.Writer, msgID string)) *stopPipe {
	return &stopPipe{
		first:      []string{turnToolStart, turnToolEnd, turnCheckpoint, slowToolStart},
		late:       late,
		stopStatus: http.StatusOK,
		release:    make(chan struct{}),
	}
}

func frames(w io.Writer, list ...string) {
	for _, frame := range list {
		_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
	}
}

func (p *stopPipe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/chat/stop" {
		p.stops.Add(1)
		w.WriteHeader(p.stopStatus)
		return
	}
	var body struct {
		AssistantMessageID string          `json:"assistantMessageId"`
		SpendSessionID     string          `json:"spendSessionId"`
		History            json.RawMessage `json:"history"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	p.mu.Lock()
	p.msgID, p.spendID, p.history = body.AssistantMessageID, body.SpendSessionID, body.History
	p.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	frames(w, p.first...)
	w.(http.Flusher).Flush()
	select {
	case <-p.release:
	case <-r.Context().Done():
	case <-time.After(10 * time.Second):
		return
	}
	p.lateCancelled.Store(r.Context().Err() != nil)
	if r.Context().Err() == nil {
		p.late(w, body.AssistantMessageID)
	}
}

func (p *stopPipe) spend() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.spendID
}

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

// stopTurnRun is one turn of a stopPipe as u_editor, up to its first
// checkpoint on the streaming row.
type stopTurnRun struct {
	h        http.Handler
	st       *store.Store
	pipe     *stopPipe
	convID   string
	msgID    string
	leave    context.CancelFunc
	finished chan struct{}
}

func startStopTurn(t *testing.T, pipe *stopPipe, setStore func(*store.Store)) stopTurnRun {
	t.Helper()
	upstream := httptest.NewServer(pipe)
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	if setStore != nil {
		setStore(st)
	}
	run := stopTurnRun{h: h, st: st, pipe: pipe, convID: newTurnConversation(t, h, st)}
	run.leave, run.finished = browserTurn(t, h, run.convID)
	run.msgID = waitForCheckpoint(t, st, run.convID)
	return run
}

func (r stopTurnRun) stopAs(t *testing.T, userID, convID string) int {
	t.Helper()
	return doAsUser(t, r.h, http.MethodPost, fmt.Sprintf("/api/conversations/%s/messages/%s/stop", convID, r.msgID), userID, nil).Code
}

func (r stopTurnRun) status(t *testing.T) string {
	t.Helper()
	var status string
	if err := r.st.Pool().QueryRow(t.Context(), `SELECT status FROM messages WHERE id=$1`, r.msgID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
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

// lateRunningCall finishes c2 and sends the stopped turn's last checkpoint.
func lateRunningCall(w io.Writer, _ string) { frames(w, slowToolEnd, stoppedFinal) }

// Stop ends the turn at once (Epo 2026-10-21): the row is listed aborted right
// away, the call still running finishes on a pipeline request the browser's
// departure does not cancel, and its call and result join the row once, with
// its receipt; credits settle after it, once.
func TestChatStopSavesTheTurnAtOnceAndAddsTheRunningCall(t *testing.T) {
	var st *store.Store
	pipe := newStopPipe(func(w io.Writer, msgID string) {
		// The running call committed a write: its receipt names c2 as well.
		if _, err := st.Pool().Exec(context.Background(), `
			INSERT INTO agent_operations (id, kind, request_hash, workspace_id, conversation_id, message_id, call_id, outcome, effect)
			SELECT $1, 'create_material', 'h', 'ws_e2e_private', conversation_id, id, 'c2', 'succeeded',
			       '{"operation":"created","resource":{"kind":"material","id":"mat_stop","title":"Note"}}'
			  FROM messages WHERE id=$2`, "op_stop_"+msgID, msgID); err != nil {
			t.Error(err)
		}
		lateRunningCall(w, msgID)
	})
	run := startStopTurn(t, pipe, func(opened *store.Store) { st = opened })

	// Someone else's turn, or a row that is not this conversation's turn.
	if code := run.stopAs(t, "u_owner", run.convID); code != http.StatusNotFound {
		t.Fatalf("the workspace owner stopped another user's turn: %d", code)
	}
	var userMsg string
	if err := st.Pool().QueryRow(t.Context(), `SELECT id FROM messages WHERE conversation_id=$1 AND role='user'`, run.convID).Scan(&userMsg); err != nil {
		t.Fatal(err)
	}
	if code := doAsUser(t, run.h, http.MethodPost, fmt.Sprintf("/api/conversations/%s/messages/%s/stop", run.convID, userMsg), "u_editor", nil).Code; code != http.StatusNotFound {
		t.Fatalf("a user message was stopped: %d", code)
	}

	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	// History lists the stopped turn now, with what it had finished.
	rec := doAsUser(t, run.h, http.MethodGet, "/api/conversations/"+run.convID+"/messages", "u_editor", nil)
	var listed []store.Message
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed) != 2 {
		t.Fatalf("messages: %s, %v", rec.Body.String(), err)
	}
	if got := listed[1]; got.Status != "aborted" || len(got.Activity) != 1 || got.Activity[0].CallID != "c1" {
		t.Fatalf("the stopped turn is not listed at once: %+v", got)
	}
	if status := sessionStatus(t, st, pipe.spend()); status != "open" {
		t.Fatalf("credits settled before the running call finished: %s", status)
	}
	run.leave() // the browser stops reading
	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("a second stop: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")

	if pipe.lateCancelled.Load() {
		t.Fatal("the pipeline request was cancelled after the stop")
	}
	turn := readTurn(t, st, run.convID)
	checkTurn(t, turn, "aborted", "checkpoint listing", "slow listing")
	if len(turn.Activity) != 2 || turn.Activity[1].CallID != "c2" || len(turn.Activity[1].Effects) != 1 {
		t.Fatalf("the running call was not added once with its receipt: %+v", turn.Activity)
	}
	var tokens int
	if err := st.Pool().QueryRow(t.Context(), `SELECT token_count FROM messages WHERE id=$1`, run.msgID).Scan(&tokens); err != nil || tokens != 42 {
		t.Fatalf("token count = %d, %v", tokens, err)
	}
	if status := sessionStatus(t, st, pipe.spend()); status != "settled" {
		t.Fatalf("credits = %s, want settled", status)
	}
	// Stopping a finished turn does nothing.
	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop after the end: %d", code)
	}
}

// A stopped turn replays every call on its row into the next turn's prompt,
// the one that finished after the Stop included (Epo 2026-10-21): no answer
// says what it did, and only full-retention results replay otherwise.
func TestStoppedTurnReplaysTheCallsMergedAfterTheStop(t *testing.T) {
	pipe := newStopPipe(lateRunningCall)
	run := startStopTurn(t, pipe, nil)
	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the stopped turn's end")

	_, next := browserTurn(t, run.h, run.convID)
	waitClosed(t, next, "the next turn")
	pipe.mu.Lock()
	raw := pipe.history
	pipe.mu.Unlock()
	var history []struct {
		Role, Status string
		Calls        []struct{ Name, Detail, Outcome string }
	}
	if err := json.Unmarshal(raw, &history); err != nil || len(history) != 2 {
		t.Fatalf("history: %s, %v", raw, err)
	}
	got := fmt.Sprint(history[1])
	if want := "{assistant aborted [{list_sources listing sources succeeded} {list_sources listing sources succeeded}]}"; got != want {
		t.Fatalf("stopped turn replayed as %s, want %s", got, want)
	}
	if history[0].Calls != nil {
		t.Fatalf("a user row carries calls: %s", raw)
	}
}

// Security regression: user B cannot stop user A's running turn by naming it
// under B's own conversation.
func TestChatStopRefusesAnotherUsersTurnThroughItsOwnConversation(t *testing.T) {
	pipe := newStopPipe(lateRunningCall)
	run := startStopTurn(t, pipe, nil)
	rec := doAsUser(t, run.h, http.MethodPost, "/api/workspaces/ws_e2e_private/conversations", "u_owner", map[string]any{"title": "Owner's chat"})
	var own store.Conversation
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &own) != nil {
		t.Fatalf("create conversation: %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() {
		_, _ = run.st.Pool().Exec(context.Background(), `DELETE FROM conversations WHERE id=$1`, own.ID)
	})

	if code := run.stopAs(t, "u_owner", own.ID); code != http.StatusNotFound {
		t.Fatalf("another user's turn was stopped through their own conversation: %d", code)
	}
	if status, stops := run.status(t), pipe.stops.Load(); status != "streaming" || stops != 0 {
		t.Fatalf("the turn was touched: status %s, %d stop requests", status, stops)
	}
	// Its owner still can.
	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")
}

// A stop the pipeline does not take (not running there yet, unreachable) hangs
// up on the pipeline request instead: the turn ends, saved and settled.
func TestChatStopHangsUpWhenThePipelineCannotStop(t *testing.T) {
	pipe := newStopPipe(lateRunningCall)
	pipe.stopStatus = http.StatusNotFound
	run := startStopTurn(t, pipe, nil)

	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	waitClosed(t, run.finished, "the turn's end")

	if !pipe.lateCancelled.Load() || pipe.stops.Load() != 1 {
		t.Fatalf("the pipeline request was not hung up on (stop requests %d)", pipe.stops.Load())
	}
	checkTurn(t, readTurn(t, run.st, run.convID), "aborted", "checkpoint listing")
	if status := sessionStatus(t, run.st, pipe.spend()); status != "settled" {
		t.Fatalf("credits = %s, want settled", status)
	}
}

// A row the stop could not save is saved aborted when the turn ends, with the
// calls that ran on, instead of staying hidden as streaming.
func TestChatStopSavesTheRowAtTheEndWhenTheStopCouldNot(t *testing.T) {
	var st *store.Store
	pipe := newStopPipe(func(w io.Writer, msgID string) {
		// As if the save at the stop had failed.
		if _, err := st.Pool().Exec(context.Background(), `UPDATE messages SET status='streaming' WHERE id=$1`, msgID); err != nil {
			t.Error(err)
		}
		lateRunningCall(w, msgID)
	})
	run := startStopTurn(t, pipe, func(opened *store.Store) { st = opened })

	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")

	checkTurn(t, readTurn(t, st, run.convID), "aborted", "checkpoint listing", "slow listing")
}

// A turn that finishes as it is stopped keeps its answer's citations and
// generation id.
func TestChatStopAsTheTurnFinishesKeepsItsCitations(t *testing.T) {
	pipe := newStopPipe(func(w io.Writer, _ string) {
		frames(w,
			`{"type":"citations","version":1,"citations":[{"fileId":"f_e2e_private","fileName":"secret-notes.md","snippet":"notes","n":1}]}`,
			`{"type":"done","generationId":"gen_stop","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`,
		)
	})
	// The checkpoint last, so the answer is in when the test sees it saved.
	pipe.first = []string{
		`{"type":"block_start","blockId":"b2"}`,
		`{"type":"block_delta","blockId":"b2","text":"The answer"}`,
		`{"type":"block_end","blockId":"b2","kind":"answer"}`,
		turnToolStart, turnToolEnd, turnCheckpoint,
	}
	run := startStopTurn(t, pipe, nil)

	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")

	var (
		content, genID string
		citations      int
	)
	if err := run.st.Pool().QueryRow(t.Context(), `
		SELECT content, COALESCE(metadata->>'generationId',''), jsonb_array_length(COALESCE(metadata->'citations','[]'))
		  FROM messages WHERE id=$1`, run.msgID).Scan(&content, &genID, &citations); err != nil {
		t.Fatal(err)
	}
	if run.status(t) != "aborted" || content != "The answer" || genID != "gen_stop" || citations != 1 {
		t.Fatalf("saved %q, generation %q, %d citations", content, genID, citations)
	}
}

// A turn whose browser leaves without Stop runs to completion and is saved
// with its answer (Epo 2026-10-21).
func TestChatTurnRunsToCompletionAfterTheBrowserLeaves(t *testing.T) {
	pipe := newStopPipe(func(w io.Writer, _ string) {
		frames(w,
			`{"type":"block_start","blockId":"b2"}`,
			`{"type":"block_delta","blockId":"b2","text":"Finished answer"}`,
			`{"type":"block_end","blockId":"b2","kind":"answer"}`,
			`{"type":"done","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`,
		)
	})
	pipe.first = []string{turnToolStart, turnToolEnd, turnCheckpoint}
	run := startStopTurn(t, pipe, nil)

	run.leave()
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")

	if pipe.lateCancelled.Load() {
		t.Fatal("the browser leaving cancelled the pipeline request")
	}
	checkTurn(t, readTurn(t, run.st, run.convID), "complete", "checkpoint listing")
	var content string
	if err := run.st.Pool().QueryRow(t.Context(), `SELECT content FROM messages WHERE id=$1`, run.msgID).Scan(&content); err != nil || content != "Finished answer" {
		t.Fatalf("answer = %q, %v", content, err)
	}
}

// Each replayed row carries its status, by which the pipeline marks stopped
// and failed turns unfinished (Epo 2026-10-21).
func TestStreamSendsEachHistoryRowsStatus(t *testing.T) {
	h, st, bodies := streamCapture(t)
	if rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"text": "teach me replay"}); rec.Code != http.StatusOK {
		t.Fatalf("first turn: %d", rec.Code)
	}
	var convID string
	if err := st.Pool().QueryRow(t.Context(), `SELECT id FROM conversations WHERE user_id='u_editor' AND title='teach me replay'`).Scan(&convID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(t.Context(), `UPDATE messages SET status='aborted' WHERE conversation_id=$1 AND role='assistant'`, convID); err != nil {
		t.Fatal(err)
	}
	if rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor", map[string]any{"conversationId": convID, "text": "teach me more"}); rec.Code != http.StatusOK {
		t.Fatalf("second turn: %d", rec.Code)
	}
	var history []struct{ Role, Status string }
	if len(*bodies) != 2 || json.Unmarshal((*bodies)[1]["history"], &history) != nil {
		t.Fatalf("relayed bodies: %d", len(*bodies))
	}
	if fmt.Sprint(history) != "[{user complete} {assistant aborted}]" {
		t.Fatalf("history rows = %v", history)
	}
}

// stuckBrowser is a browser that reads nothing: every write waits until the
// test lets it through.
type stuckBrowser struct {
	header  http.Header
	unblock chan struct{}
	once    sync.Once
	mu      sync.Mutex
	body    bytes.Buffer
}

func (b *stuckBrowser) Header() http.Header { return b.header }
func (b *stuckBrowser) WriteHeader(int)     {}
func (b *stuckBrowser) Flush()              {}
func (b *stuckBrowser) Write(p []byte) (int, error) {
	<-b.unblock
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.body.Write(p)
}
func (b *stuckBrowser) release() { b.once.Do(func() { close(b.unblock) }) }

// A browser that never reads does not hold up the turn: it is saved, its
// credits settle and its AI request slot is free, and the response closes
// only after its last event (Epo 2026-10-21).
func TestChatTurnIsSavedAndSettledWhileTheBrowserReadsNothing(t *testing.T) {
	pipe := newStopPipe(func(io.Writer, string) {})
	pipe.first = []string{turnToolStart, turnToolEnd, turnCheckpoint,
		`{"type":"block_start","blockId":"b2"}`,
		`{"type":"block_delta","blockId":"b2","text":"Saved answer"}`,
		`{"type":"block_end","blockId":"b2","kind":"answer"}`,
		`{"type":"done","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`,
	}
	close(pipe.release)
	upstream := httptest.NewServer(pipe)
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithPipeline(t, pipeline.New(upstream.URL, ""))
	convID := newTurnConversation(t, h, st)

	raw, err := json.Marshal(map[string]any{"conversationId": convID, "text": "list my sources"})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	browser := &stuckBrowser{header: http.Header{}, unblock: make(chan struct{})}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		h.ServeHTTP(browser, req)
	}()
	t.Cleanup(func() {
		browser.release()
		<-finished
	})

	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		_ = st.Pool().QueryRow(t.Context(), `SELECT status FROM messages WHERE conversation_id=$1 AND role='assistant'`, convID).Scan(&status)
		if status == "complete" && sessionStatus(t, st, pipe.spend()) == "settled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the turn was not saved and settled while the browser read nothing (row %q)", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-finished:
		t.Fatal("the response closed before its events were written")
	default:
	}

	browser.release()
	waitClosed(t, finished, "the response")
	browser.mu.Lock()
	defer browser.mu.Unlock()
	body := strings.TrimSpace(browser.body.String())
	first, _, _ := strings.Cut(body, "\n\n")
	if !strings.Contains(first, `"type":"start"`) || !strings.Contains(body, "Saved answer") ||
		!strings.HasSuffix(body, `"type":"done"}`) {
		t.Fatalf("the browser did not get every event in order: %s", body)
	}
}
