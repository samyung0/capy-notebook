package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// A turn's browsers (Epo 2026-10-27, T19): the tab that sent it reads the POST
// response, and a tab that shows its conversation after a reload or a dropped
// connection reads GET .../stream, which replays every event so far and then
// follows. Events are kept for the turn's life without their Undo payloads,
// which only the browsers reading at the time get.

// send gives one event to every browser reading the turn and keeps it for
// browsers that join later.
func (t *runningTurn) send(v any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sendLocked(v)
}

func (t *runningTurn) sendLocked(v any) {
	if t.over {
		return
	}
	data, _ := json.Marshal(v)
	kept := data
	if ev, ok := v.(pipeChatEvent); ok && len(ev.UndoPayloads) > 0 {
		ev.UndoPayloads = nil
		kept, _ = json.Marshal(ev)
	}
	t.events = append(t.events, kept)
	for b := range t.readers {
		b.send(data)
	}
}

// join queues every event so far to b and, unless the turn is over for its
// browsers, adds b for the rest.
func (t *runningTurn) join(b *browserWriter) (over bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, data := range t.events {
		b.send(data)
	}
	if !t.over {
		t.readers[b] = struct{}{}
	}
	return t.over
}

func (t *runningTurn) leave(b *browserWriter) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.readers, b)
}

// end closes the turn for its browsers after the last event (the done, or a
// Stop's), which their responses end with.
func (t *runningTurn) end() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.endLocked()
}

func (t *runningTurn) endLocked() {
	if t.over {
		return
	}
	t.over = true
	t.readers = nil
	close(t.ended)
}

// resumeTurn streams a running turn to a browser showing its conversation:
// the conversation's owner, as for Stop. A turn not running in this process
// (finished since the browser read its row) answers 204, and the browser
// reads the row again.
func (a *api) resumeTurn(w http.ResponseWriter, r *http.Request) {
	convID, msgID := chi.URLParam(r, "id"), chi.URLParam(r, "messageId")
	if _, err := a.s.GetConversation(r.Context(), uid(r), convID); err != nil {
		a.fail(w, err)
		return
	}
	found, _ := a.turns.Load(msgID)
	run, _ := found.(*runningTurn)
	if run == nil || run.convID != convID {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeUnexpected(w, http.StatusInternalServerError)
		return
	}
	extendDeadlines(w, chatStreamDeadline)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	browser := newBrowserWriter(w, flusher.Flush)
	defer browser.finish()
	if run.join(browser) {
		return
	}
	defer run.leave(browser)
	select {
	case <-run.ended:
	case <-r.Context().Done():
	}
}

// publishChatTurn tells the user's tabs a conversation's turn started
// (`streaming`) or saved its ending, for the running mark in the
// conversation list (Epo 2026-10-27, T19).
func (a *api) publishChatTurn(ctx context.Context, userID, convID, status string) {
	a.publishNotificationEvent(ctx, userID, notificationEvent{
		Type: "chat_turn", ConversationID: convID, Status: status,
	})
}
