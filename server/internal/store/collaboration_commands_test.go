package store

import (
	"errors"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A replace-block the collaboration server refuses because the note is in
// the blocks layout (422 unsupported_operation) is the named refusal, an
// invalid request for that note, not an unavailable authority.
func TestBlocksLayoutContentCommandIsNamed(t *testing.T) {
	response := &http.Response{StatusCode: http.StatusUnprocessableEntity, Header: http.Header{}}
	body := []byte(`{"code":"unsupported_operation","message":"a note in the blocks layout takes no server edits yet"}`)
	err := contentCommandAnswer(response, body)
	if !errors.Is(err, ErrBlocksLayout) || !errors.Is(err, materialdoc.ErrInvalid) || errors.Is(err, ErrAuthorityUnavailable) {
		t.Fatalf("err = %v", err)
	}
}
