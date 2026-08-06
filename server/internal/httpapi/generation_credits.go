package httpapi

import "context"

// generationCreditsAllowed is the actor-side gate for model spend.
//
// Generation has two distinct costs charged to two distinct users: the produced
// material is storage, billed to the workspace owner and enforced by
// gateStorageTx, while the inference that produced it is billed to the actor
// who asked for it. Only the first exists today.
//
// This is deliberately not AccountAccess. The over-quota states mean "lapsed
// subscription AND over the storage limit", which says nothing about whether an
// actor may spend on inference, and using it as a spend gate produces the
// behaviour described in todo-permissions: an editor blocked from generating
// into someone else's workspace for reasons that have nothing to do with that
// workspace.
//
// See todo-llm-credits for the model this is meant to grow into.
func (a *api) generationCreditsAllowed(_ context.Context, _ string) error {
	return nil
}
