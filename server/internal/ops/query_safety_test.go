package ops

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestReadQuerySourceUsesBoundedRawUsageLedgerQueries(t *testing.T) {
	t.Parallel()
	sourceBytes, err := os.ReadFile("read_store.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	overviewStart := strings.Index(source, "func (s *ReadStore) Overview")
	healthStart := strings.Index(source, "func (s *ReadStore) Health")
	costsStart := strings.Index(source, "func (s *ReadStore) Costs")
	if overviewStart < 0 || healthStart < 0 || costsStart < 0 {
		t.Fatal("read query boundaries were not found")
	}
	if !strings.Contains(source[overviewStart:healthStart], "usage_events") ||
		!strings.Contains(source[overviewStart:healthStart], "date_trunc('month'") {
		t.Fatal("overview must read the raw ledger inside the current UTC month")
	}
	if !strings.Contains(source[costsStart:], "FROM usage_events") ||
		!strings.Contains(source[costsStart:], "LIMIT %d") {
		t.Fatal("usage explorer must read the bounded raw ledger")
	}
	recentQuery := source[strings.Index(source, "func (s *ReadStore) User"):costsStart]
	if strings.Count(recentQuery, "FROM usage_events") != 2 ||
		!strings.Contains(recentQuery, "date_trunc('month'") ||
		!strings.Contains(recentQuery, "ORDER BY ue.created_at DESC, ue.id DESC LIMIT $2") {
		t.Fatal("user detail raw-ledger queries must be current-month or newest-first bounded")
	}
	if recentUsageLimit != 50 || userSearchLimit != 20 || topUsersLimit != 20 {
		t.Fatal("ops result limits changed")
	}
}

func TestReadStoreRejectsBoundsBeforeQuerying(t *testing.T) {
	t.Parallel()
	read := &ReadStore{}
	if _, err := read.Health(context.Background(), 0); !IsValidation(err) {
		t.Fatalf("health threshold error = %v, want validation", err)
	}
	from := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := read.Costs(
		context.Background(), from, from.AddDate(0, 0, 366), "day", "day",
	); !IsValidation(err) {
		t.Fatalf("oversized cost range error = %v, want validation", err)
	}
	if _, err := read.Costs(
		context.Background(), from, from, "day; DROP TABLE usage_events", "day",
	); !IsValidation(err) {
		t.Fatalf("unsafe cost dimension error = %v, want validation", err)
	}
}

func TestHTTPRangeBoundsUseInclusiveCalendarDays(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		"GET",
		"/api/ops/costs?from=2024-01-01&to=2024-12-31",
		nil,
	)
	if _, _, err := costRange(request); err != nil {
		t.Fatalf("366-day leap-year range rejected: %v", err)
	}
	request = httptest.NewRequest(
		"GET",
		"/api/ops/costs?from=2024-01-01&to=2025-01-01",
		nil,
	)
	if _, _, err := costRange(request); !IsValidation(err) {
		t.Fatalf("367-day range error = %v, want validation", err)
	}
}
