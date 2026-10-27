package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"io"
	"net/http"
	"time"
)

// sourcePublishTimeout outlasts the collaboration publish coordinator's room
// lock (LOCK in collaboration-rs/crates/sources/src/handoff.rs: a 60 s acknowledgement
// wait plus one 120 s Office engine call), so the gateway never abandons a
// publication the coordinator can still complete. Other collaboration calls
// keep the client's 20 s.
const sourcePublishTimeout = 200 * time.Second

// sourceChangesTimeout outlasts the collaboration service's read budget
// (OFFICE_CHANGES_BUDGET, 20 s, in collaboration-rs/crates/sources/src/pending.rs):
// it answers files not read by then as failed, so the files it did read
// still reach the turn (Q435).
const sourceChangesTimeout = 30 * time.Second

// sourceAuthorityTimeouts are the operations that wait longer than the
// collaboration client's 20 s.
var sourceAuthorityTimeouts = map[string]time.Duration{
	"/internal/source-refresh/publish": sourcePublishTimeout,
	"/internal/source-changes":         sourceChangesTimeout,
}

// SourceAuthority forwards only these three internal source operations through
// the existing private collaboration connection.
func (s *Store) SourceAuthority(ctx context.Context, operation string, body json.RawMessage) (json.RawMessage, int, error) {
	if operation != "/internal/source-changes" && operation != "/internal/source-changes/resolve" && operation != "/internal/source-refresh/publish" {
		return nil, 0, ErrForbidden
	}
	if s.collaborationURL == "" || s.collaborationSecret == "" {
		return nil, 0, ErrAuthorityUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.collaborationURL+operation, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	obs.Inject(ctx, req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", s.collaborationSecret)
	client := s.collaborationHTTP
	if timeout := sourceAuthorityTimeouts[operation]; timeout > 0 {
		longer := *client
		longer.Timeout = timeout
		client = &longer
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (150<<20)+1))
	if err != nil {
		return nil, 0, err
	}
	if len(raw) > 150<<20 {
		return nil, 0, ErrConflict
	}
	if !json.Valid(raw) {
		return nil, 0, ErrAuthorityUnavailable
	}
	if response.StatusCode >= 500 {
		obs.RecordHTTPError(ctx, obs.WithEventID(fmt.Errorf("source authority: %s", response.Status), response.Header.Get(obs.ErrorEventHeader)))
	}
	return raw, response.StatusCode, nil
}
