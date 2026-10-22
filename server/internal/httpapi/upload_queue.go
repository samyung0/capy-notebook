package httpapi

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

// The gateway runs at most uploadSlots uploads at once, and one user at most
// uploadUserSlots of them (Epo 2026-10-22). An upload first takes a ticket: a
// ticket that finds every slot taken, or its user at their share, waits in
// line, and its browser long-polls its place until its turn comes. A turn
// holds a slot for uploadTurnTTL; an upload that has not started by then
// passes the slot to the next ticket. The line lives in this process, since
// the API runs as one instance; a scaled-out API would need it in Redis. A
// ticket holds what it was issued for (uploadClaim), and its upload must
// match it. A source ticket whose turn passes, or that the browser gives up,
// settles as a failed file of its batch at once; one the browser retries with
// a new ticket does not.
const (
	uploadSlots = 32
	// uploadUserSlots counts a user's running uploads and held turns.
	uploadUserSlots    = 4
	uploadQueueMax     = 128
	uploadQueuePerUser = 20
	// uploadBodyRate is the slowest an upload's body may arrive on average:
	// 100 KB a second.
	uploadBodyRate = 100_000
)

// Tests shorten these.
var (
	uploadTurnTTL = 30 * time.Second
	// An upload has uploadBodyBase plus its declared size at uploadBodyRate
	// to send its body, from the gateway's first read of it, and never more
	// than uploadBodyDeadline (bodyDeadline).
	uploadBodyBase     = 30 * time.Second
	uploadBodyDeadline = 5 * time.Minute
	// uploadPollWait bounds a long poll well under Cloudflare's 100 s.
	uploadPollWait = 25 * time.Second
	// uploadPollGap is the soonest a poll answers a move in line, so a line
	// moving fast costs each waiting browser one poll per gap, inside the
	// per-user rate limit. A turn answers at once.
	uploadPollGap = 2 * time.Second
	// uploadTicketReadBound is how long a ticket request has to send its
	// JSON body.
	uploadTicketReadBound = 10 * time.Second
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

// uploadTicketGone refuses an unknown, foreign, spent, cancelled or passed
// ticket, typed for the browser's own copy.
func uploadTicketGone() error {
	return &huma.ErrorModel{
		Status: http.StatusGone,
		Title:  http.StatusText(http.StatusGone),
		Detail: "the upload's ticket is unknown or its turn has passed",
		Errors: []*huma.ErrorDetail{{Message: "upload_ticket_gone"}},
	}
}

// uploadClaim is what a ticket was issued for: its upload must name the same
// file, size, type and batch (a source upload's; empty for an editor asset).
type uploadClaim struct {
	name, contentType, batch string
	size                     int64
}

// matches refuses an upload whose metadata differs from its ticket's.
func (c uploadClaim) matches(upload uploadClaim) error {
	if c != upload {
		return huma.Error400BadRequest("the upload's metadata differs from its ticket")
	}
	return nil
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
	claim            uploadClaim
	// turn is set when the ticket's turn comes; it frees the slot if the
	// upload does not start in time.
	turn *time.Timer
}

type uploadQueue struct {
	mu      sync.Mutex
	free    int                      // slots neither uploading nor held by a turn
	active  map[string]int           // each user's running uploads and held turns
	line    []*uploadTicket          // waiting tickets, oldest first
	tickets map[string]*uploadTicket // waiting and turn-holding tickets
	moved   chan struct{}            // closed and replaced when the line moves
	// settle counts a source ticket that ended without its upload as a
	// failed file of its batch.
	settle func(batch string)
}

func newUploadQueue(settle func(batch string)) *uploadQueue {
	return &uploadQueue{
		free: uploadSlots, active: map[string]int{}, tickets: map[string]*uploadTicket{},
		moved: make(chan struct{}), settle: settle,
	}
}

func sourceUploadTarget(workspaceID string) string { return "sources:" + workspaceID }
func editorAssetTarget(materialID string) string   { return "assets:" + materialID }

// take gives user a ticket for target: its turn at once when a slot is free
// and the user is under their share, else a place in line, or
// uploadQueueFull when the line, or the user's share of it, is full.
func (q *uploadQueue) take(user, target string, claim uploadClaim) (uploadTurn, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t := &uploadTicket{id: randID("utk"), user: user, target: target, claim: claim}
	// Every move grants the line first, so whoever still waits beside a free
	// slot is at their share: this ticket jumps nobody it could pass.
	if q.free > 0 && q.active[user] < uploadUserSlots {
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
	q.active[t.user]++
	t.turn = time.AfterFunc(uploadTurnTTL, func() { q.pass(t) })
}

// pass frees the slot of a turn its upload did not take.
func (q *uploadQueue) pass(t *uploadTicket) {
	q.mu.Lock()
	unused := q.tickets[t.id] == t // else the upload started
	if unused {
		q.dropLocked(t)
	}
	q.mu.Unlock()
	if unused && t.claim.batch != "" {
		q.settle(t.claim.batch)
	}
}

// cancel drops the user's ticket whose upload the browser gave up, or
// retries with a new ticket, before it started: its place in line, or its
// turn's slot, goes to the next ticket. A given-up source upload counts as a
// failed file of its batch; a retried one does not, since its retry counts
// it.
func (q *uploadQueue) cancel(id, user string, retry bool) error {
	q.mu.Lock()
	t, ok := q.tickets[id]
	if ok && t.user == user {
		q.dropLocked(t)
	}
	q.mu.Unlock()
	if !ok || t.user != user {
		return uploadTicketGone()
	}
	if !retry && t.claim.batch != "" {
		q.settle(t.claim.batch)
	}
	return nil
}

// dropLocked removes a ticket that has not started, from the line or from
// its turn.
func (q *uploadQueue) dropLocked(t *uploadTicket) {
	delete(q.tickets, t.id)
	if t.turn != nil {
		t.turn.Stop()
		q.freeLocked(t.user)
	} else {
		q.line = slices.DeleteFunc(q.line, func(waiting *uploadTicket) bool { return waiting == t })
	}
	q.advanceLocked()
}

// advanceLocked grants free slots to the line, oldest first, passing over
// tickets whose user is at their share, and wakes the polls.
func (q *uploadQueue) advanceLocked() {
	for i := 0; q.free > 0 && i < len(q.line); {
		next := q.line[i]
		if q.active[next.user] >= uploadUserSlots {
			i++
			continue
		}
		q.line = slices.Delete(q.line, i, i+1)
		q.grantLocked(next)
	}
	close(q.moved)
	q.moved = make(chan struct{})
}

// freeLocked gives back a slot user held, by a turn or an upload.
func (q *uploadQueue) freeLocked(user string) {
	q.free++
	if q.active[user]--; q.active[user] == 0 {
		delete(q.active, user)
	}
}

// start spends a ticket whose turn has come on its upload, before the
// gateway reads the upload's body, and returns what the ticket was issued
// for. A ticket of another user or target is as unknown as an expired one.
// The upload calls release once it is done.
func (q *uploadQueue) start(id, user, target string) (claim uploadClaim, release func(), err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tickets[id]
	if !ok || t.user != user || t.target != target {
		return uploadClaim{}, nil, uploadTicketGone()
	}
	if t.turn == nil {
		return uploadClaim{}, nil, huma.Error409Conflict("the upload's ticket is still waiting for its turn")
	}
	t.turn.Stop()
	delete(q.tickets, id)
	var once sync.Once
	return t.claim, func() { once.Do(func() { q.release(user) }) }, nil
}

func (q *uploadQueue) release(user string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.freeLocked(user)
	q.advanceLocked()
}

// bodyDeadline is how long an upload of size bytes has to send its body (Epo
// 2026-10-22): uploadBodyBase plus the size at uploadBodyRate, at most
// uploadBodyDeadline, so a slow trickle cannot hold a slot for long.
func bodyDeadline(size int64) time.Duration {
	return min(uploadBodyBase+time.Duration(size)*time.Second/uploadBodyRate, uploadBodyDeadline)
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
		if turn.Position == 0 || known < 0 {
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

// cancelUploadTicket gives up the caller's ticket whose upload was cancelled;
// ?retry=1 says the browser retries the file with a new ticket.
func (a *api) cancelUploadTicket(w http.ResponseWriter, r *http.Request) {
	retry := r.URL.Query().Get("retry") == "1"
	if err := a.uploads.cancel(chi.URLParam(r, "ticketId"), uid(r), retry); err != nil {
		answerError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
