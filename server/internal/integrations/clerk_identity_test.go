package integrations

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"testing"

	"github.com/clerk/clerk-sdk-go/v2"
)

func TestClerkNotFoundDetectionSurvivesWrapping(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &clerk.APIErrorResponse{
		HTTPStatusCode: http.StatusNotFound,
	})
	if !identityAlreadyDeleted(err) {
		t.Fatal("wrapped Clerk not-found response was not detectable")
	}
}

func TestRevokeUserSessionsPaginatesBeforeRevoking(t *testing.T) {
	all := make([]string, 250)
	for i := range all {
		all[i] = fmt.Sprintf("sess_%03d", i)
	}
	revoked := map[string]bool{}
	attempted := make([]string, 0, len(all))
	list := func(_ context.Context, _ string, limit, offset int64) ([]string, int64, error) {
		active := make([]string, 0, len(all))
		for _, id := range all {
			if !revoked[id] {
				active = append(active, id)
			}
		}
		total := int64(len(active))
		if offset >= total {
			return nil, total, nil
		}
		end := min(offset+limit, total)
		return slices.Clone(active[offset:end]), total, nil
	}
	revoke := func(_ context.Context, id string) error {
		attempted = append(attempted, id)
		revoked[id] = true
		return nil
	}
	if err := revokeUserSessions(context.Background(), "user_1", list, revoke); err != nil {
		t.Fatal(err)
	}
	last := ""
	if len(attempted) > 0 {
		last = attempted[len(attempted)-1]
	}
	if len(attempted) != 250 || last != "sess_249" {
		t.Fatalf("revoked %d sessions, last=%q", len(attempted), last)
	}
}

func TestRevokeUserSessionsDoesNotHideSafetyBound(t *testing.T) {
	generation := 0
	list := func(_ context.Context, _ string, _, _ int64) ([]string, int64, error) {
		return []string{fmt.Sprintf("sess_%d", generation)}, 1, nil
	}
	revoke := func(_ context.Context, _ string) error {
		generation++
		return nil
	}
	err := revokeUserSessions(context.Background(), "user_1", list, revoke)
	if !errors.Is(err, errClerkSessionsRemain) {
		t.Fatalf("safety-bound error=%v", err)
	}
}

func TestRevokeUserSessionsRejectsShortProviderPage(t *testing.T) {
	list := func(_ context.Context, _ string, _, _ int64) ([]string, int64, error) {
		return nil, 1, nil
	}
	err := revokeUserSessions(
		context.Background(), "user_1", list,
		func(context.Context, string) error { return nil },
	)
	if !errors.Is(err, errClerkSessionsRemain) {
		t.Fatalf("short-page error=%v", err)
	}
}

func TestRevokeUserSessionsAttemptsLaterPagesAfterFailure(t *testing.T) {
	all := make([]string, 150)
	for i := range all {
		all[i] = fmt.Sprintf("sess_%03d", i)
	}
	attempted := map[string]bool{}
	revoked := map[string]bool{}
	list := func(_ context.Context, _ string, limit, offset int64) ([]string, int64, error) {
		active := make([]string, 0, len(all))
		for _, id := range all {
			if !revoked[id] {
				active = append(active, id)
			}
		}
		total := int64(len(active))
		if offset >= total {
			return nil, total, nil
		}
		end := min(offset+limit, total)
		return slices.Clone(active[offset:end]), total, nil
	}
	revoke := func(_ context.Context, id string) error {
		attempted[id] = true
		if id == "sess_000" {
			return errors.New("provider refused revoke")
		}
		revoked[id] = true
		return nil
	}
	err := revokeUserSessions(context.Background(), "user_1", list, revoke)
	if err == nil || !attempted["sess_149"] {
		t.Fatalf("error=%v attempted last page=%v", err, attempted["sess_149"])
	}
}

func TestRevokeUserSessionsAcceptsConfirmedEmptyAfterRevokeError(t *testing.T) {
	listCalls := 0
	list := func(_ context.Context, _ string, _, _ int64) ([]string, int64, error) {
		listCalls++
		if listCalls == 1 {
			return []string{"sess_uncertain"}, 1, nil
		}
		return nil, 0, nil
	}
	revoke := func(context.Context, string) error {
		return errors.New("provider timed out after applying revoke")
	}
	if err := revokeUserSessions(context.Background(), "user_1", list, revoke); err != nil {
		t.Fatalf("confirmed empty sweep returned stale error: %v", err)
	}
}

func TestRevokeUserSessionsTreatsNotFoundAsRevoked(t *testing.T) {
	active := true
	list := func(_ context.Context, _ string, _, _ int64) ([]string, int64, error) {
		if active {
			return []string{"sess_gone"}, 1, nil
		}
		return nil, 0, nil
	}
	revoke := func(context.Context, string) error {
		active = false
		return &clerk.APIErrorResponse{HTTPStatusCode: http.StatusNotFound}
	}
	if err := revokeUserSessions(context.Background(), "user_1", list, revoke); err != nil {
		t.Fatalf("not-found revoke returned an error: %v", err)
	}
}
