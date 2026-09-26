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
// lock (LOCK_MS in collaboration/src/sourceHandoff.ts: a 60 s acknowledgement
// wait plus one 120 s Office engine call), so the gateway never abandons a
// publication the coordinator can still complete. Other collaboration calls
// keep the client's 20 s.
const sourcePublishTimeout = 200 * time.Second

// SourceAuthority forwards only these two internal source operations through
// the existing private collaboration connection.
func (s *Store) SourceAuthority(ctx context.Context, operation string, body json.RawMessage) (json.RawMessage, int, error) {
	if operation != "/internal/source-changes/resolve" && operation != "/internal/source-refresh/publish" {
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
	if operation == "/internal/source-refresh/publish" {
		publish := *client
		publish.Timeout = sourcePublishTimeout
		client = &publish
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
