package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

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
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", s.collaborationSecret)
	response, err := s.collaborationHTTP.Do(req)
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
	return raw, response.StatusCode, nil
}
