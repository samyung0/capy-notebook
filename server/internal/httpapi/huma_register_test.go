package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestMapHTTPErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("quiz: %w", store.ErrConflict), http.StatusConflict, "revision_conflict"},
		{store.ErrNothingToProcess, http.StatusConflict, "nothing_to_process"},
		{store.ErrAccountDeletionBusy, http.StatusConflict, "account_deletion_busy"},
		{store.ErrSubscriptionExists, http.StatusConflict, "subscription_exists"},
		{fmt.Errorf("clone: %w", store.ErrCloneSourceChanged), http.StatusConflict, "clone_source_changed"},
		{store.ErrTitleTaken, http.StatusConflict, "title_taken"},
		{store.ErrInvalidPDFAnnotation, http.StatusBadRequest, ""},
	} {
		var model *huma.ErrorModel
		if !errors.As(mapHTTPError(tc.err), &model) || model.Status != tc.status {
			t.Fatalf("%v = %#v, want %d", tc.err, model, tc.status)
		}
		if tc.code != "" && (len(model.Errors) != 1 || model.Errors[0].Message != tc.code) {
			t.Fatalf("%v code = %#v, want %s", tc.err, model.Errors, tc.code)
		}
	}
}
