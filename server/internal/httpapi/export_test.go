package httpapi

import (
	"testing"
	"time"
)

// SetUploadPutBound shortens the bound on an upload's B2 PUT for one test.
func SetUploadPutBound(t *testing.T, bound time.Duration) {
	previous := uploadPutBound
	uploadPutBound = bound
	t.Cleanup(func() { uploadPutBound = previous })
}
