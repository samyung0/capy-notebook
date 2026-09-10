package httpapi

import (
	"fmt"
	"net/http"
	"time"
)

// ingestEvents streams live ingest progress for a workspace over SSE.
//
// The Python worker PUBLISHes JSON events to the Redis channel
// `ingest:{workspaceId}` ({fileId, stage, pct, status, message, indexed}). One
// process-wide subscription fans those out to every open stream (fanout.go);
// this handler only relays its own channel's events. The UI patches its file
// cache as they arrive, and holds this stream open only while a file is
// actually ingesting.
func (a *api) ingestEvents(w http.ResponseWriter, r *http.Request) {
	if !a.assertWSRead(w, r, id(r)) {
		return
	}
	if a.broker == nil {
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
	sub, err := a.broker.subscribe(ctx, "ingest:"+wsID)
	if err != nil {
		http.Error(w, "ingest stream unavailable", http.StatusServiceUnavailable)
		return
	}
	defer a.broker.unsubscribe(sub)

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
		case <-sub.dropped:
			// Evicted for falling behind. Ending the response is the recovery:
			// the client reconnects and re-reads status from the file list.
			return
		case payload, ok := <-sub.events:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
