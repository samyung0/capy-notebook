package httpapi

import (
	"strconv"
	"testing"
)

func TestNotificationStreamLimitsArePerUserAndGlobal(t *testing.T) {
	a := &api{notifByUser: make(map[string]int)}

	for i := 0; i < maxNotificationStreamsUser; i++ {
		if !a.acquireNotificationStream("u_1") {
			t.Fatalf("stream %d should be accepted for one user", i)
		}
	}
	if a.acquireNotificationStream("u_1") {
		t.Fatal("per-user stream limit was not enforced")
	}
	a.releaseNotificationStream("u_1")
	if !a.acquireNotificationStream("u_1") {
		t.Fatal("released stream should be reusable")
	}

	for i := 0; i < maxNotificationStreams-maxNotificationStreamsUser; i++ {
		if !a.acquireNotificationStream("other-" + strconv.Itoa(i)) {
			t.Fatalf("global stream slot %d should be accepted", i)
		}
	}
	if a.acquireNotificationStream("u_over_limit") {
		t.Fatal("global stream limit was not enforced")
	}
}
