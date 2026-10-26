package httpapi

import (
	"testing"
	"time"
)

// SetTurnstileVerifyURL points siteverify at a local fake for one test.
func SetTurnstileVerifyURL(t *testing.T, url string) {
	previous := turnstileVerifyURL
	turnstileVerifyURL = url
	t.Cleanup(func() { turnstileVerifyURL = previous })
}

// SetUploadPutBound shortens the bound on an upload's B2 PUT for one test.
func SetUploadPutBound(t *testing.T, bound time.Duration) {
	previous := uploadPutBound
	uploadPutBound = bound
	t.Cleanup(func() { uploadPutBound = previous })
}

// SetUploadTicketReadBound shortens how long a ticket request has to send its
// body, for one test.
func SetUploadTicketReadBound(t *testing.T, bound time.Duration) {
	previous := uploadTicketReadBound
	uploadTicketReadBound = bound
	t.Cleanup(func() { uploadTicketReadBound = previous })
}

// SetUploadBudget shrinks the declared bytes running uploads share, for one
// test.
func SetUploadBudget(t *testing.T, bytes int64) {
	previous := uploadBudget
	uploadBudget = bytes
	t.Cleanup(func() { uploadBudget = previous })
}

// SetUploadQueueTimings shortens the upload line's clocks for one test: a
// turn's hold, the base of an upload's body deadline and a poll's longest
// wait. The deadline's 5-minute cap stays.
func SetUploadQueueTimings(t *testing.T, turn, bodyBase, poll time.Duration) {
	previous := []time.Duration{uploadTurnTTL, uploadBodyBase, uploadPollWait}
	uploadTurnTTL, uploadBodyBase, uploadPollWait = turn, bodyBase, poll
	t.Cleanup(func() {
		uploadTurnTTL, uploadBodyBase, uploadPollWait = previous[0], previous[1], previous[2]
	})
}

// The by-id read's caps on ids (internal_documents.go).
const (
	OfficeIDsPerCall = officeIDsPerCall
	OfficeIDBytes    = officeIDBytes
)
