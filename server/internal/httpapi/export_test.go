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

// SetUploadQueueTimings shortens the upload line's clocks for one test: a
// turn's hold, an upload's body deadline and a poll's longest wait.
func SetUploadQueueTimings(t *testing.T, turn, body, poll time.Duration) {
	previous := []time.Duration{uploadTurnTTL, uploadBodyDeadline, uploadPollWait}
	uploadTurnTTL, uploadBodyDeadline, uploadPollWait = turn, body, poll
	t.Cleanup(func() {
		uploadTurnTTL, uploadBodyDeadline, uploadPollWait = previous[0], previous[1], previous[2]
	})
}
