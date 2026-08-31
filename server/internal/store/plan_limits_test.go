package store

import (
	"testing"

	"github.com/evonotes/server/internal/planlimits"
)

func mustPlanLimits(t *testing.T, s *Store, tier PlanTier) planlimits.Limits {
	t.Helper()
	limits, err := s.PlanLimits(tier)
	if err != nil {
		t.Fatal(err)
	}
	return limits
}
