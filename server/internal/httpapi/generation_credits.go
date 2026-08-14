package httpapi

import (
	"context"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/store"
)

// settleTimeout bounds the detached write that closes a reservation. Short:
// the alternative to a slow settle is an expired reservation, which
// self-corrects, so there is no reason to hold a goroutine open.
const settleTimeout = 10 * time.Second

// spend is an open reservation against the actor's inference budget. Callers
// must always finish it, either by settling measured usage or releasing it.
//
// Generation has two distinct costs charged to two distinct users: the produced
// material is storage, billed to the workspace owner and enforced by
// gateStorageTx, while the inference that produced it is billed to the actor
// who asked for it. This is the second one.
//
// It is deliberately not AccountAccess. The over-quota states mean "lapsed
// subscription AND over the storage limit", which says nothing about whether an
// actor may spend on inference; using it as a spend gate blocks an editor from
// generating into someone else's healthy workspace for reasons that have
// nothing to do with that workspace.
type spend struct {
	api  *api
	id   string
	done bool
}

// reserveSpend gates an estimated cost before any model is called. A zero
// estimate still opens a reservation, so concurrent requests serialize on the
// counter row rather than all reading the same pre-spend balance.
func (a *api) reserveSpend(
	ctx context.Context,
	actorUserID, workspaceID, surface string,
	estimateMicros int64,
) (*spend, error) {
	id, err := a.s.ReserveCredits(ctx, actorUserID, workspaceID, surface, estimateMicros)
	if err != nil {
		return nil, err
	}
	return &spend{api: a, id: id}, nil
}

// settle records what was actually consumed and closes the reservation.
//
// It runs on a detached context because the most common settlement happens
// after a client disconnects mid-stream, when the request context is already
// cancelled — exactly the case where forgetting to charge is worst.
func (s *spend) settle(ctx context.Context, events ...store.UsageEvent) {
	if s == nil || s.done {
		return
	}
	s.done = true
	settleCtx, cancel := obs.Detach(ctx, settleTimeout)
	defer cancel()
	if err := s.api.s.SettleCredits(settleCtx, s.id, events...); err != nil {
		// A failed settle leaves the reservation to expire, which
		// under-charges rather than over-charges. Worth an alert, not a 500 on
		// a request that already succeeded.
		obs.CaptureErr(settleCtx, err, map[string]string{"stage": "credit_settle"})
	}
}

// release drops the hold without charging, for a request that failed before
// spending anything.
func (s *spend) release(ctx context.Context) {
	if s == nil || s.done {
		return
	}
	s.done = true
	releaseCtx, cancel := obs.Detach(ctx, settleTimeout)
	defer cancel()
	if err := s.api.s.ReleaseCredits(releaseCtx, s.id); err != nil {
		obs.CaptureErr(releaseCtx, err, map[string]string{"stage": "credit_release"})
	}
}
