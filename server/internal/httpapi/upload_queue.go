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

// Running uploads share a budget of declared bytes, uploadBudget, the temp
// disk their bodies spool to; at most uploadRunMax run at once, and one user
// at most uploadUserSlots of them (Epo 2026-10-22). Held turns count as
// running. An upload first takes a ticket: a ticket whose file does not fit,
// or whose user is at their share, waits in line, and its browser long-polls
// its place until its turn comes. The line goes oldest first, but a file that
// does not fit is passed by smaller ones until it has waited uploadBlockAfter;
// from then on nobody behind it starts until it fits, so small files cannot
// starve a big one. A user at their share is passed by, as ever. A ticket
// past its user's upload rate class waits in line too, instead of a 429, and
// joins the line's order once the class admits it (Epo 2026-10-24, Q282);
// source and editor-asset tickets share the line and the class. Such a ticket
// counts only toward its user's waiting tickets, not the line's size, and its
// wait clock restarts when the class admits it (Q307). A turn holds
// its share of the budget for uploadTurnTTL; an upload that has not started
// by then passes it to the next ticket. The line lives in this process, since
// the API runs as one instance; a scaled-out API would need it in Redis. A
// ticket holds what it was issued for (uploadClaim), and its upload must
// match it. A source ticket whose turn passes, or that the browser gives up,
// settles as a failed file of its batch at once, or as a removed one when the
// user removed it. The browser never retries an upload itself (Q282).
const (
	// uploadRunMax bounds running uploads and held turns: a sanity bound on
	// connections.
	uploadRunMax = 256
	// uploadUserSlots counts a user's running uploads and held turns.
	uploadUserSlots = 4
	// uploadQueueMax bounds waiting tickets that spend or spent their class
	// token as they take their place (Epo 2026-10-24, Q318: 2,000; a ticket
	// is a small in-memory record). The bound is soft: a ticket the class
	// admits later joins them without a check, and under a burst so can
	// tickets that would start at once as they take their place but do not
	// once their class answers, past 2,000 if the line is full. Each user's
	// 20 holds from the moment a ticket takes its place, so memory stays
	// bounded (Q350).
	uploadQueueMax     = 2000
	uploadQueuePerUser = 20
	// uploadBodyRate is the slowest an upload's body may arrive on average:
	// 100 KB a second.
	uploadBodyRate = 100_000
)

// Tests shorten these.
var (
	// uploadBudget is the declared bytes running uploads and held turns share
	// (Epo 2026-10-22: 1 GB, 10^9 bytes), the temp disk their bodies spool to
	// (the runbook asks for about 2 GB free).
	uploadBudget int64 = 1_000_000_000
	// uploadBlockAfter is how long a ticket that does not fit is passed by
	// before it blocks the tickets behind it.
	uploadBlockAfter = 30 * time.Second
	uploadTurnTTL    = 30 * time.Second
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
	// queued is when the ticket joined the line.
	queued time.Time
	// turn is set when the ticket's turn comes; it frees the ticket's share
	// if the upload does not start in time.
	turn *time.Timer
	// overClass is set while the ticket waits for its user's upload rate
	// class; it neither gets a turn nor blocks the line until cleared.
	overClass bool
	// asking is set while take spends the ticket's class token outside the
	// lock: the ticket holds its place and counts toward the line's limits,
	// but neither gets a turn nor blocks the line until the class answers.
	asking bool
}

type uploadQueue struct {
	mu      sync.Mutex
	used    int64                    // declared bytes of running uploads and held turns
	running int                      // running uploads and held turns
	active  map[string]int           // each user's running uploads and held turns
	line    []*uploadTicket          // waiting tickets, oldest first
	tickets map[string]*uploadTicket // waiting and turn-holding tickets
	moved   chan struct{}            // closed and replaced when the line moves
	// settle counts a source ticket that ended without its upload as a
	// failed file of its batch, or a removed one.
	settle func(batch string, removed bool)
	// admitClass spends one request of the user's upload rate class: 0 when
	// it admits, else how long until it would (ratelimit.Limiter.TakeUpload).
	admitClass func(ctx context.Context, user string) (time.Duration, error)
	// after runs f once d has passed; tests run it themselves.
	after func(d time.Duration, f func())
}

func newUploadQueue(settle func(batch string, removed bool)) *uploadQueue {
	return &uploadQueue{
		active: map[string]int{}, tickets: map[string]*uploadTicket{},
		moved: make(chan struct{}), settle: settle,
		admitClass: func(context.Context, string) (time.Duration, error) { return 0, nil },
		after:      func(d time.Duration, f func()) { time.AfterFunc(d, f) },
	}
}

func sourceUploadTarget(workspaceID string) string { return "sources:" + workspaceID }
func editorAssetTarget(materialID string) string   { return "assets:" + materialID }

// take gives user a ticket for target: its turn at once when its upload rate
// class admits it, its file fits, the user is under their share and no ticket
// blocks the line, else a place in line, or uploadQueueFull when the line, or
// the user's share of it, is full (roomLocked). A file larger than the whole
// budget is refused (413), and a class Redis cannot count refuses (503).
func (q *uploadQueue) take(user, target string, claim uploadClaim) (uploadTurn, error) {
	// It would never fit, and once it had waited it would block every
	// ticket behind it.
	if claim.size > uploadBudget {
		return uploadTurn{}, huma.Error413RequestEntityTooLarge("the upload is larger than the gateway's upload budget")
	}
	t := &uploadTicket{id: randID("utk"), user: user, target: target, claim: claim, asking: true}
	// The ticket takes its place before it spends its class token, so a
	// ticket the line refuses spends none (Q307, Q350). The token is spent
	// outside the lock: a slow Redis delays only this ticket.
	q.mu.Lock()
	if err := q.roomLocked(t); err != nil {
		q.mu.Unlock()
		return uploadTurn{}, err
	}
	q.tickets[t.id] = t
	q.line = append(q.line, t)
	q.mu.Unlock()
	retry, err := q.askClass(user)
	q.mu.Lock()
	defer q.mu.Unlock()
	t.asking = false
	if err != nil {
		q.dropLocked(t)
		return uploadTurn{}, &huma.ErrorModel{
			Status: http.StatusServiceUnavailable, Title: http.StatusText(http.StatusServiceUnavailable),
			Detail: "try again shortly", Errors: []*huma.ErrorDetail{{Message: "rate_limit_unavailable"}},
		}
	}
	if retry > 0 {
		// Refused by its class, it spent nothing and keeps its place,
		// counting toward its user's share alone (Q307).
		t.overClass = true
		q.after(retry, func() { q.recheckClass(t) })
		return uploadTurn{TicketID: t.id, Position: q.positionLocked(t)}, nil
	}
	// It spent its token, so it keeps its place: its turn now if the line
	// grants it, else its wait clock starts.
	t.queued = time.Now()
	q.advanceLocked()
	if t.turn != nil {
		return uploadTurn{TicketID: t.id}, nil
	}
	return uploadTurn{TicketID: t.id, Position: q.positionLocked(t)}, nil
}

func (q *uploadQueue) askClass(user string) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return q.admitClass(ctx, user)
}

// recheckClass asks the upload rate class again for a ticket waiting on it,
// once its retry-after has passed; when it admits, the ticket takes its place
// in the line's order. While Redis cannot answer it asks again in 5 s.
func (q *uploadQueue) recheckClass(t *uploadTicket) {
	q.mu.Lock()
	waiting := q.tickets[t.id] == t
	q.mu.Unlock()
	if !waiting {
		return
	}
	retry, err := q.askClass(t.user)
	if err != nil {
		retry = 5 * time.Second
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.tickets[t.id] != t {
		return
	}
	if retry > 0 {
		q.after(retry, func() { q.recheckClass(t) })
		return
	}
	t.overClass = false
	t.queued = time.Now()
	q.advanceLocked()
}

// startsLocked is whether t gets its turn at once: every move grants the
// line first, so whoever still waits is at their share, does not fit, or is
// behind a blocking ticket, and t passes only those the line would pass too.
func (q *uploadQueue) startsLocked(t *uploadTicket) bool {
	return q.active[t.user] < uploadUserSlots && q.fitsLocked(t) && !q.blockedLocked()
}

// roomLocked refuses a ticket taking its place when its user already has
// uploadQueuePerUser waiting, or, unless it would start at once, when the
// line already holds uploadQueueMax tickets not waiting on their class; one
// waiting only on its class counts toward its user's share alone (Q307).
func (q *uploadQueue) roomLocked(t *uploadTicket) error {
	if q.waitingLocked(t.user) >= uploadQueuePerUser || (!q.startsLocked(t) && q.classedLocked() >= uploadQueueMax) {
		return uploadQueueFull()
	}
	return nil
}

// classedLocked counts the waiting tickets that spent their class token.
func (q *uploadQueue) classedLocked() int {
	n := 0
	for _, t := range q.line {
		if !t.overClass {
			n++
		}
	}
	return n
}

// fitsLocked is whether t's file fits the budget and the running uploads.
func (q *uploadQueue) fitsLocked(t *uploadTicket) bool {
	return q.running < uploadRunMax && q.used+t.claim.size <= uploadBudget
}

// blocksLocked is whether a waiting ticket holds back every ticket behind
// it: one under its user's share that does not fit and has waited
// uploadBlockAfter.
func (q *uploadQueue) blocksLocked(t *uploadTicket) bool {
	return !t.overClass && !t.asking && q.active[t.user] < uploadUserSlots && !q.fitsLocked(t) &&
		time.Since(t.queued) >= uploadBlockAfter
}

func (q *uploadQueue) blockedLocked() bool {
	return slices.ContainsFunc(q.line, q.blocksLocked)
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
	q.used += t.claim.size
	q.running++
	q.active[t.user]++
	t.turn = time.AfterFunc(uploadTurnTTL, func() { q.pass(t) })
}

// pass frees the share of a turn its upload did not take.
func (q *uploadQueue) pass(t *uploadTicket) {
	q.mu.Lock()
	unused := q.tickets[t.id] == t // else the upload started
	if unused {
		q.dropLocked(t)
	}
	q.mu.Unlock()
	if unused && t.claim.batch != "" {
		q.settle(t.claim.batch, false)
	}
}

// cancel drops the user's ticket whose upload the browser gave up before it
// started: its place in line, or its turn's share, goes to the next ticket. A
// given-up source upload counts as a failed file of its batch, or a removed
// one for reason "removed".
func (q *uploadQueue) cancel(id, user, reason string) error {
	q.mu.Lock()
	t, ok := q.tickets[id]
	if ok && t.user == user {
		q.dropLocked(t)
	}
	q.mu.Unlock()
	if !ok || t.user != user {
		return uploadTicketGone()
	}
	if t.claim.batch != "" {
		q.settle(t.claim.batch, reason == "removed")
	}
	return nil
}

// dropLocked removes a ticket that has not started, from the line or from
// its turn.
func (q *uploadQueue) dropLocked(t *uploadTicket) {
	delete(q.tickets, t.id)
	if t.turn != nil {
		t.turn.Stop()
		q.freeLocked(t)
	} else {
		q.line = slices.DeleteFunc(q.line, func(waiting *uploadTicket) bool { return waiting == t })
	}
	q.advanceLocked()
}

// advanceLocked grants turns to the line, oldest first: it passes over a
// ticket whose user is at their share, and one that does not fit until a
// ticket blocks the line (blocksLocked). It wakes the polls.
func (q *uploadQueue) advanceLocked() {
	for i := 0; i < len(q.line); {
		next := q.line[i]
		if !next.overClass && !next.asking && q.active[next.user] < uploadUserSlots && q.fitsLocked(next) {
			q.line = slices.Delete(q.line, i, i+1)
			q.grantLocked(next)
			continue
		}
		if q.blocksLocked(next) {
			break
		}
		i++
	}
	close(q.moved)
	q.moved = make(chan struct{})
}

// freeLocked gives back the share t held, by its turn or its upload.
func (q *uploadQueue) freeLocked(t *uploadTicket) {
	q.used -= t.claim.size
	q.running--
	if q.active[t.user]--; q.active[t.user] == 0 {
		delete(q.active, t.user)
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
	return t.claim, func() { once.Do(func() { q.release(t) }) }, nil
}

func (q *uploadQueue) release(t *uploadTicket) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.freeLocked(t)
	q.advanceLocked()
}

// bodyDeadline is how long an upload of size bytes has to send its body (Epo
// 2026-10-22): uploadBodyBase plus the size at uploadBodyRate, at most
// uploadBodyDeadline, so a slow trickle cannot hold its share for long.
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
// ?reason=removed says the user removed it.
func (a *api) cancelUploadTicket(w http.ResponseWriter, r *http.Request) {
	reason := r.URL.Query().Get("reason")
	if reason != "" && reason != "removed" {
		answerError(w, r, huma.Error400BadRequest("unknown reason"))
		return
	}
	if err := a.uploads.cancel(chi.URLParam(r, "ticketId"), uid(r), reason); err != nil {
		answerError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
