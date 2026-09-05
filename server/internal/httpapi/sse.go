package httpapi

import (
	"fmt"
	"net/http"
	"time"
)

// ingestEvents streams live ingest progress for a workspace over SSE.
//
// The Python worker PUBLISHes JSON events to the Redis channel
// `ingest:{workspaceId}` ({fileId, stage, pct, status, message, indexed}); we subscribe
// and relay each event to the browser's EventSource. This replaces polling for
// upload status — the UI patches its file cache as events arrive.
func (a *api) ingestEvents(w http.ResponseWriter, r *http.Request) {
	if !a.assertWSRead(w, r, id(r)) {
		return
	}
	if a.rdb == nil {
		http.Error(w, "redis not configured", http.StatusServiceUnavailable)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	wsID := id(r)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx)

	userID := uid(r)
	ctx, cancelLiveAuthorization := a.liveWorkspaceContext(r.Context(), userID, wsID)
	defer cancelLiveAuthorization()
	sub := a.rdb.Subscribe(ctx, "ingest:"+wsID)
	defer sub.Close()
	ch := sub.Channel()

	// Open the stream so the client's onopen fires promptly.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	// Keep-alive comments so idle connections aren't dropped by proxies.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg.Payload)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
