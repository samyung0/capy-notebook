package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func takeOrFail(t *testing.T, q *uploadQueue, user string, position int) uploadTurn {
	t.Helper()
	turn, err := q.take(user, "sources:ws", "")
	if err != nil || turn.Position != position {
		t.Fatalf("%s's ticket = %+v, %v; want position %d", user, turn, err, position)
	}
	return turn
}

// The line holds at most 128 waiting tickets and 20 of one user's (Epo
// 2026-10-22); a ticket past either is refused as busy.
func TestUploadQueueHoldsAtMost128And20PerUser(t *testing.T) {
	q := newUploadQueue(nil)
	for range uploadSlots {
		takeOrFail(t, q, "running", 0)
	}
	for i := 1; i <= 20; i++ {
		takeOrFail(t, q, "u0", i)
	}
	if _, err := q.take("u0", "sources:ws", ""); errorStatus(err) != 503 {
		t.Fatalf("u0's 21st waiting ticket: %v", err)
	}
	for i := 21; i <= 128; i++ {
		takeOrFail(t, q, fmt.Sprintf("u%d", (i-1)/20), i)
	}
	if _, err := q.take("newcomer", "sources:ws", ""); errorStatus(err) != 503 {
		t.Fatalf("the 129th waiting ticket: %v", err)
	}
}

// A poll answers a move in line no sooner than uploadPollGap after it asked,
// so a fast line costs a browser one poll per gap.
func TestUploadPollAnswersAMoveAfterItsGap(t *testing.T) {
	previous := uploadPollGap
	uploadPollGap = 300 * time.Millisecond
	t.Cleanup(func() { uploadPollGap = previous })
	q := newUploadQueue(nil)
	first := takeOrFail(t, q, "running", 0)
	for range uploadSlots - 1 {
		takeOrFail(t, q, "running", 0)
	}
	takeOrFail(t, q, "u1", 1)
	second := takeOrFail(t, q, "u1", 2)
	asked := time.Now()
	answered := make(chan uploadTurn, 1)
	go func() {
		turn, _ := q.wait(context.Background(), second.TicketID, "u1", 2)
		answered <- turn
	}()
	release, err := q.start(first.TicketID, "running", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	release()
	turn := <-answered
	if took := time.Since(asked); turn.Position != 1 || took < uploadPollGap {
		t.Fatalf("the poll answered %+v after %v", turn, took)
	}
}
