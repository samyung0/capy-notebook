package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

// The gateway runs at most uploadSlots uploads at once (Epo 2026-10-22). An
// upload first takes a ticket: a ticket that finds every slot taken waits in
// line, and its browser long-polls its place until its turn comes. A turn
// holds a slot for uploadTurnTTL; an upload that has not started by then
// passes the slot to the next ticket. The line lives in this process, since
// the API runs as one instance; a scaled-out API would need it in Redis.
const (
	uploadSlots        = 32
	uploadQueueMax     = 128
	uploadQueuePerUser = 20
)

// Tests shorten these.
var (
	uploadTurnTTL = 30 * time.Second
	// uploadBodyDeadline is how long an upload has to send its body, from
	// the gateway's first read of it.
	uploadBodyDeadline = 5 * time.Minute
	// uploadPollWait bounds a long poll well under Cloudflare's 100 s.
	uploadPollWait = 25 * time.Second
	// uploadPollGap is the soonest a poll answers a move in line, so a line
	// moving fast costs each waiting browser one poll per gap, inside the
	// per-user rate limit. A turn answers at once.
	uploadPollGap = 2 * time.Second
)

// uploadQueueFull refuses a ticket when the line, or the user's share of it,
// is full: busy, try again.
func uploadQueueFull() error {
	return &huma.ErrorModel{
		Status: http.StatusServiceUnavailable,
		Title:  http.StatusText(http.StatusServiceUnavailable),
		Detail: "too many uploads are waiting; try again shortly",
		Errors: []*huma.ErrorDetail{{Message: "upload_queue_full"}},
	}
}

func uploadTicketGone() error {
	return huma.Error410Gone("the upload's ticket is unknown or its turn has passed")
}

// uploadTurn answers a ticket: its place in line, 0 once its turn has come.
type uploadTurn struct {
	TicketID string `json:"ticketId"`
	Position int    `json:"position"`
}

type uploadTicket struct {
	// target is the route the ticket admits: a workspace's source uploads or
	// a material's editor assets.
	id, user, target string
	// turn is set when the ticket's turn comes; it frees the slot if the
	// upload does not start in time.
	turn *time.Timer
}

type uploadQueue struct {
	mu      sync.Mutex
	free    int                      // slots neither uploading nor held by a turn
	line    []*uploadTicket          // waiting tickets, oldest first
	tickets map[string]*uploadTicket // waiting and turn-holding tickets
	moved   chan struct{}            // closed and replaced when the line moves
}

func newUploadQueue() *uploadQueue {
	return &uploadQueue{free: uploadSlots, tickets: map[string]*uploadTicket{}, moved: make(chan struct{})}
}

func sourceUploadTarget(workspaceID string) string { return "sources:" + workspaceID }
func editorAssetTarget(materialID string) string   { return "assets:" + materialID }

// take gives user a ticket for target: its turn at once when a slot is free,
// else a place in line, or uploadQueueFull when the line, or the user's
// share of it, is full.
func (q *uploadQueue) take(user, target string) (uploadTurn, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t := &uploadTicket{id: randID("utk"), user: user, target: target}
	// A free slot means nobody waits: every move grants the line first.
	if q.free > 0 {
		q.tickets[t.id] = t
		q.grantLocked(t)
		return uploadTurn{TicketID: t.id}, nil
	}
	if len(q.line) >= uploadQueueMax || q.waitingLocked(user) >= uploadQueuePerUser {
		return uploadTurn{}, uploadQueueFull()
	}
	q.tickets[t.id] = t
	q.line = append(q.line, t)
	return uploadTurn{TicketID: t.id, Position: len(q.line)}, nil
}

func (q *uploadQueue) waitingLocked(user string) int {
	n := 0
	for _, t := range q.line {
		if t.user == user {
			n++
		}
	}
	return n
}

func (q *uploadQueue) grantLocked(t *uploadTicket) {
	q.free--
	t.turn = time.AfterFunc(uploadTurnTTL, func() { q.pass(t) })
}

// pass frees the slot of a turn its upload did not take.
func (q *uploadQueue) pass(t *uploadTicket) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.tickets[t.id] != t {
		return // the upload started
	}
	delete(q.tickets, t.id)
	q.free++
	q.advanceLocked()
}

// advanceLocked grants free slots to the line, oldest first, and wakes the
// polls.
func (q *uploadQueue) advanceLocked() {
	for q.free > 0 && len(q.line) > 0 {
		next := q.line[0]
		q.line = q.line[1:]
		q.grantLocked(next)
	}
	close(q.moved)
	q.moved = make(chan struct{})
}

// start spends a ticket whose turn has come on its upload, before the
// gateway reads the upload's body. A ticket of another user or target is
// as unknown as an expired one. The upload calls release once it is done.
func (q *uploadQueue) start(id, user, target string) (release func(), err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tickets[id]
	if !ok || t.user != user || t.target != target {
		return nil, uploadTicketGone()
	}
	if t.turn == nil {
		return nil, huma.Error409Conflict("the upload's ticket is still waiting for its turn")
	}
	t.turn.Stop()
	delete(q.tickets, id)
	var once sync.Once
	return func() { once.Do(q.release) }, nil
}

func (q *uploadQueue) release() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.free++
	q.advanceLocked()
}

// wait answers a ticket's poll once its place differs from known (no sooner
// than uploadPollGap after the ask) or its turn comes, else after
// uploadPollWait.
func (q *uploadQueue) wait(ctx context.Context, id, user string, known int) (uploadTurn, error) {
	asked := time.Now()
	timeout := time.NewTimer(uploadPollWait)
	defer timeout.Stop()
	for {
		q.mu.Lock()
		t, ok := q.tickets[id]
		if !ok || t.user != user {
			q.mu.Unlock()
			return uploadTurn{}, uploadTicketGone()
		}
		turn := uploadTurn{TicketID: id}
		if t.turn == nil {
			turn.Position = q.positionLocked(t)
		}
		moved := q.moved
		q.mu.Unlock()
		if turn.Position == 0 {
			return turn, nil
		}
		var gap <-chan time.Time
		if turn.Position != known {
			left := uploadPollGap - time.Since(asked)
			if left <= 0 {
				return turn, nil
			}
			gap = time.After(left)
		}
		select {
		case <-moved:
		case <-gap:
		case <-timeout.C:
			return turn, nil
		case <-ctx.Done():
			// The browser left; the answer goes nowhere.
			return turn, nil
		}
	}
}

func (q *uploadQueue) positionLocked(t *uploadTicket) int {
	for i, waiting := range q.line {
		if waiting == t {
			return i + 1
		}
	}
	return 0
}

// waitUploadTicket is a ticket's long poll. position is the place the
// browser last saw; without it the poll answers at once.
func (a *api) waitUploadTicket(w http.ResponseWriter, r *http.Request) {
	known := -1
	if v := r.URL.Query().Get("position"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			answerError(w, r, huma.Error400BadRequest("position must be a number"))
			return
		}
		known = n
	}
	turn, err := a.uploads.wait(r.Context(), chi.URLParam(r, "ticketId"), uid(r), known)
	if err != nil {
		answerError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, turn)
}
