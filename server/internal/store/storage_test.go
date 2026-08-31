package store

import "testing"

func TestStorageLimitsUseDecimalBytes(t *testing.T) {
	s := openAccessTestStore(t)
	if got := mustPlanLimits(t, s, PlanFree).StorageBytes; got != 100_000_000 {
		t.Fatalf("free storage limit = %d, want 100000000", got)
	}
	if got := mustPlanLimits(t, s, PlanPro).StorageBytes; got != 1_000_000_000 {
		t.Fatalf("Pro storage limit = %d, want 1000000000", got)
	}
}
