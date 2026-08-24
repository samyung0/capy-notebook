package httpapi

import (
	"context"
	"time"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/store"
)

// settleTimeout bounds the detached write that closes a reservation. Short:
// the alternative to a slow settle is an expired reservation, which
// self-corrects, so there is no reason to hold a goroutine open.
const settleTimeout = 10 * time.Second

// spend is an open lease against the actor's inference budget. Callers
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

// beginSpend opens a lease before any model is called. Platform-paid calls
// take one of ConcurrentLLMLeases slots and fail when used is already at the
// cap. BYOK skips the lease: query embeddings are not billed, so those
// requests cost us nothing to start.
func (a *api) beginSpend(
	ctx context.Context,
	actorUserID, workspaceID, surface, paidBy string,
) (*spend, error) {
	if paidBy == models.PaidByUser {
		return &spend{api: a}, nil
	}
	id, err := a.s.BeginSpend(ctx, actorUserID, workspaceID, surface)
	if err != nil {
		return nil, err
	}
	return &spend{api: a, id: id}, nil
}

func (a *api) beginProviderSession(
	ctx context.Context,
	actorUserID, workspaceID, surface, paidBy string,
	llm, embedding store.TokenRates,
) (*spend, error) {
	id, err := a.s.BeginProviderSession(
		ctx,
		actorUserID,
		workspaceID,
		surface,
		paidBy,
		llm,
		embedding,
	)
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
