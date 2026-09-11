package httpapi

import (
	"strconv"
	"testing"
)

func TestEventStreamLimitsArePerUserAndGlobal(t *testing.T) {
	a := &api{streamByUser: make(map[string]int)}

	for i := 0; i < maxEventStreamsUser; i++ {
		if !a.acquireEventStream("u_1") {
			t.Fatalf("stream %d should be accepted for one user", i)
		}
	}
	if a.acquireEventStream("u_1") {
		t.Fatal("per-user stream limit was not enforced")
	}
	a.releaseEventStream("u_1")
	if !a.acquireEventStream("u_1") {
		t.Fatal("released stream should be reusable")
	}

	for i := 0; i < maxEventStreams-maxEventStreamsUser; i++ {
		if !a.acquireEventStream("other-" + strconv.Itoa(i)) {
			t.Fatalf("global stream slot %d should be accepted", i)
		}
	}
	if a.acquireEventStream("u_over_limit") {
		t.Fatal("global stream limit was not enforced")
	}
}
