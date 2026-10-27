package httpapi_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type sseEvent struct {
	Type, Status, CallID string
	UndoPayloads         []json.RawMessage
}

// resume opens the turn's GET stream as userID on a real server, so its
// events arrive as they are written; the channel closes with the response.
func (r stopTurnRun) resume(t *testing.T, userID string) (int, <-chan sseEvent) {
	t.Helper()
	srv := httptest.NewServer(r.h)
	t.Cleanup(srv.Close)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		fmt.Sprintf("%s/api/conversations/%s/messages/%s/stream", srv.URL, r.convID, r.msgID), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan sseEvent, 64)
	go func() {
		defer close(events)
		defer res.Body.Close()
		lines := bufio.NewScanner(res.Body)
		for lines.Scan() {
			if data, ok := strings.CutPrefix(lines.Text(), "data: "); ok {
				var ev sseEvent
				_ = json.Unmarshal([]byte(data), &ev)
				events <- ev
			}
		}
	}()
	return res.StatusCode, events
}

// expectEvents reads the next events and then, with end, the response's end.
func expectEvents(t *testing.T, events <-chan sseEvent, end bool, want ...string) []sseEvent {
	t.Helper()
	var got []sseEvent
	for len(got) < len(want) {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("the stream ended after %+v, want %v", got, want)
			}
			got = append(got, ev)
		case <-time.After(10 * time.Second):
			t.Fatalf("got %+v, want %v", got, want)
		}
	}
	var types []string
	for _, ev := range got {
		types = append(types, ev.Type+ev.CallID)
	}
	if fmt.Sprint(types) != fmt.Sprint(want) {
		t.Fatalf("events %v, want %v", types, want)
	}
	if end {
		select {
		case ev, ok := <-events:
			if ok {
				t.Fatalf("an event after the end: %+v", ev)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the stream did not end")
		}
	}
	return got
}

func listedConversation(t *testing.T, r stopTurnRun) store.Conversation {
	t.Helper()
	rec := doAsUser(t, r.h, http.MethodGet, "/api/workspaces/ws_e2e_private/conversations", "u_editor", nil)
	var list []store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("conversations: %s", rec.Body.String())
	}
	for _, c := range list {
		if c.ID == r.convID {
			return c
		}
	}
	t.Fatalf("conversation %s is not listed", r.convID)
	return store.Conversation{}
}

// A tab that shows a running turn's conversation (a reload, a dropped
// connection) reads its history with the streaming row, then the turn's
// stream: every event so far, then the rest live, until it ends (Epo
// 2026-10-27, T19). The list marks the conversation running meanwhile.
func TestChatResumeReplaysTheTurnThenFollowsIt(t *testing.T) {
	pipe := newStopPipe(func(w io.Writer, _ string) {
		frames(w,
			`{"type":"tool_end","callId":"c2","outcome":"succeeded","undoPayloads":[{"op":"u2"}]}`,
			`{"type":"block_start","blockId":"b2"}`,
			`{"type":"block_delta","blockId":"b2","text":"The answer"}`,
			`{"type":"block_end","blockId":"b2","kind":"answer"}`,
			`{"type":"done","activity":[{"id":"c1","kind":"tool","callId":"c1","name":"list_sources","outcome":"succeeded"}],"toolEvidence":{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}}`,
		)
	})
	run := startStopTurn(t, pipe, nil)

	rec := doAsUser(t, run.h, http.MethodGet, "/api/conversations/"+run.convID+"/messages", "u_editor", nil)
	var listed []store.Message
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed) != 2 || listed[1].Status != "streaming" ||
		len(listed[1].Activity) != 1 {
		t.Fatalf("history without the running turn: %s", rec.Body.String())
	}
	if !listedConversation(t, run).Running {
		t.Fatal("the conversation is not listed running")
	}

	code, events := run.resume(t, "u_editor")
	if code != http.StatusOK {
		t.Fatalf("resume: %d", code)
	}
	expectEvents(t, events, false, "start", "tool_startc1", "tool_endc1", "tool_startc2")
	close(pipe.release)
	got := expectEvents(t, events, true, "tool_endc2", "block_start", "block_delta", "block_end", "done")
	if len(got[0].UndoPayloads) != 1 || got[4].Status != "complete" {
		t.Fatalf("live events %+v", got)
	}
	waitClosed(t, run.finished, "the turn's end")

	if listedConversation(t, run).Running {
		t.Fatal("the finished conversation is listed running")
	}
	// Finished: the browser reads the saved row instead.
	if code, _ := run.resume(t, "u_editor"); code != http.StatusNoContent {
		t.Fatalf("resume after the end: %d", code)
	}
}

// Only the conversation's owner follows its turn.
func TestChatResumeRefusesAnotherUser(t *testing.T) {
	pipe := newStopPipe(lateRunningCall)
	run := startStopTurn(t, pipe, nil)
	if code, _ := run.resume(t, "u_owner"); code != http.StatusNotFound {
		t.Fatalf("another user followed the turn: %d", code)
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the turn's end")
}

// Stop ends every browser following the turn at once, with the turn aborted,
// while the calls still running finish on the pipeline (Epo 2026-10-21).
func TestChatStopEndsEveryBrowserFollowingTheTurn(t *testing.T) {
	pipe := newStopPipe(lateRunningCall)
	run := startStopTurn(t, pipe, nil)
	_, events := run.resume(t, "u_editor")
	expectEvents(t, events, false, "start", "tool_startc1", "tool_endc1", "tool_startc2")

	if code := run.stopAs(t, "u_editor", run.convID); code != http.StatusNoContent {
		t.Fatalf("stop: %d", code)
	}
	if got := expectEvents(t, events, true, "done"); got[0].Status != "aborted" {
		t.Fatalf("done %+v", got[0])
	}
	close(pipe.release)
	waitClosed(t, run.finished, "the stopped turn's end")
}

// The user's tabs hear a conversation's turn start and end on /api/stream
// (Epo 2026-10-27, T19), for its running mark.
func TestChatTurnStatusReachesTheUsersEvents(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("run with pnpm test:go for disposable Redis")
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(options)
	t.Cleanup(func() { _ = rdb.Close() })
	keys := []string{"capy:rl:user:base:user:u_editor", "capy:rl:ai:user:u_editor", "capy:rl:ai-burst:user:u_editor"}
	rdb.Del(context.Background(), keys...)
	t.Cleanup(func() { rdb.Del(context.Background(), keys...) })
	sub := rdb.Subscribe(t.Context(), "notif:u_editor")
	t.Cleanup(func() { _ = sub.Close() })
	if _, err := sub.Receive(t.Context()); err != nil {
		t.Fatal(err)
	}

	pipe := newStopPipe(lateRunningCall)
	upstream := httptest.NewServer(pipe)
	t.Cleanup(upstream.Close)
	h, st, _, _ := openInternalHTTPWithRedis(t, pipeline.New(upstream.URL, ""), rdb, nil)
	convID := newTurnConversation(t, h, st)
	_, finished := browserTurn(t, h, convID)
	waitForCheckpoint(t, st, convID)
	close(pipe.release)
	waitClosed(t, finished, "the turn's end")

	var statuses []string
	for len(statuses) < 2 {
		select {
		case msg := <-sub.Channel():
			var ev struct{ Type, ConversationID, Status string }
			if json.Unmarshal([]byte(msg.Payload), &ev) == nil && ev.Type == "chat_turn" && ev.ConversationID == convID {
				statuses = append(statuses, ev.Status)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("chat_turn events %v", statuses)
		}
	}
	// The pipe sends no done, so the turn ends as a lost hop: error.
	if fmt.Sprint(statuses) != "[streaming error]" {
		t.Fatalf("chat_turn events %v", statuses)
	}
}
