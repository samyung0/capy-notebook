package httpapi

import (
	"testing"
	"time"
)

// SetB2CallBound shortens the bound on each B2 call in an upload's completion
// for one test.
func SetB2CallBound(t *testing.T, bound time.Duration) {
	previous := b2CallBound
	b2CallBound = bound
	t.Cleanup(func() { b2CallBound = previous })
}
