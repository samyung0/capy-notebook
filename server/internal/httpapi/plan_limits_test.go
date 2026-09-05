package httpapi_test

import (
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/planlimits"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func mustPlanLimits(
	t *testing.T,
	st *store.Store,
	tier store.PlanTier,
) planlimits.Limits {
	t.Helper()
	limits, err := st.PlanLimits(tier)
	if err != nil {
		t.Fatal(err)
	}
	return limits
}
