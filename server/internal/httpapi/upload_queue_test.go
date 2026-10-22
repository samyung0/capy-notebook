package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// fillSlots takes the 32 slots with 8 users' 4 turns each; it returns the
// first turn.
func fillSlots(t *testing.T, q *uploadQueue) uploadTurn {
	t.Helper()
	first := takeOrFail(t, q, "r0", 0)
	for i := 1; i < uploadSlots; i++ {
		takeOrFail(t, q, fmt.Sprintf("r%d", i/uploadUserSlots), 0)
	}
	return first
}

func takeOrFail(t *testing.T, q *uploadQueue, user string, position int) uploadTurn {
	t.Helper()
	turn, err := q.take(user, "sources:ws", uploadClaim{})
	if err != nil || turn.Position != position {
		t.Fatalf("%s's ticket = %+v, %v; want position %d", user, turn, err, position)
	}
	return turn
}

// The line holds at most 128 waiting tickets and 20 of one user's (Epo
// 2026-10-22); a ticket past either is refused as busy.
func TestUploadQueueHoldsAtMost128And20PerUser(t *testing.T) {
	q := newUploadQueue(nil)
	fillSlots(t, q)
	for i := 1; i <= 20; i++ {
		takeOrFail(t, q, "u0", i)
	}
	if _, err := q.take("u0", "sources:ws", uploadClaim{}); errorStatus(err) != 503 {
		t.Fatalf("u0's 21st waiting ticket: %v", err)
	}
	for i := 21; i <= 128; i++ {
		takeOrFail(t, q, fmt.Sprintf("u%d", (i-1)/20), i)
	}
	if _, err := q.take("newcomer", "sources:ws", uploadClaim{}); errorStatus(err) != 503 {
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
	first := fillSlots(t, q)
	takeOrFail(t, q, "u1", 1)
	second := takeOrFail(t, q, "u1", 2)
	asked := time.Now()
	answered := make(chan uploadTurn, 1)
	go func() {
		turn, _ := q.wait(context.Background(), second.TicketID, "u1", 2)
		answered <- turn
	}()
	_, release, err := q.start(first.TicketID, "r0", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	release()
	turn := <-answered
	if took := time.Since(asked); turn.Position != 1 || took < uploadPollGap {
		t.Fatalf("the poll answered %+v after %v", turn, took)
	}
}

// A poll whose ticket does not move answers its unchanged place once its
// bound passes, before Cloudflare would cut it off.
func TestUploadPollAnswersWithinItsBound(t *testing.T) {
	previous := uploadPollWait
	uploadPollWait = 200 * time.Millisecond
	t.Cleanup(func() { uploadPollWait = previous })
	q := newUploadQueue(nil)
	fillSlots(t, q)
	waiting := takeOrFail(t, q, "u1", 1)
	asked := time.Now()
	answered := make(chan uploadTurn, 1)
	go func() {
		turn, _ := q.wait(context.Background(), waiting.TicketID, "u1", 1)
		answered <- turn
	}()
	select {
	case turn := <-answered:
		if took := time.Since(asked); turn.Position != 1 || took < uploadPollWait {
			t.Fatalf("the poll answered %+v after %v", turn, took)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the poll did not answer within its bound")
	}
}

// One user runs at most 4 uploads at once, counting held turns and running
// uploads (Epo 2026-10-22): their 5th waits while another user's ticket gets
// a free slot at once, and gets its turn when one of theirs ends.
func TestUploadQueueCapsAUsersUploads(t *testing.T) {
	q := newUploadQueue(nil)
	var mine []uploadTurn
	for range uploadUserSlots {
		mine = append(mine, takeOrFail(t, q, "a", 0))
	}
	fifth := takeOrFail(t, q, "a", 1)
	takeOrFail(t, q, "b", 0)
	// A running upload counts as its turn did.
	_, release, err := q.start(mine[0].TicketID, "a", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	takeOrFail(t, q, "c", 0)
	if turn, _ := q.wait(context.Background(), fifth.TicketID, "a", -1); turn.Position != 1 {
		t.Fatalf("a's 5th is at %d while a runs 4", turn.Position)
	}
	release()
	if turn, _ := q.wait(context.Background(), fifth.TicketID, "a", -1); turn.Position != 0 {
		t.Fatalf("a's 5th is at %d after one of a's uploads ended", turn.Position)
	}
}

// A freed slot passes over the oldest waiting ticket when its user is at
// their share, to the next user's (Epo 2026-10-22).
func TestUploadQueuePassesOverAUserAtTheirShare(t *testing.T) {
	q := newUploadQueue(nil)
	for range uploadUserSlots {
		takeOrFail(t, q, "a", 0)
	}
	fifth := takeOrFail(t, q, "a", 1)
	var last uploadTurn
	for i := uploadUserSlots; i < uploadSlots; i++ {
		last = takeOrFail(t, q, fmt.Sprintf("r%d", i/uploadUserSlots), 0)
	}
	next := takeOrFail(t, q, "b", 2)
	if err := q.cancel(last.TicketID, fmt.Sprintf("r%d", (uploadSlots-1)/uploadUserSlots), false); err != nil {
		t.Fatal(err)
	}
	if turn, _ := q.wait(context.Background(), next.TicketID, "b", -1); turn.Position != 0 {
		t.Fatalf("b's ticket is at %d after a slot freed", turn.Position)
	}
	if turn, _ := q.wait(context.Background(), fifth.TicketID, "a", -1); turn.Position != 1 {
		t.Fatalf("a's 5th is at %d while a runs 4", turn.Position)
	}
}

// An upload's body has 30 s plus its size at 100 KB/s, at most 5 minutes:
// a 30 MiB file still gets the full 5 minutes (Epo 2026-10-22).
func TestUploadBodyDeadlineScalesWithItsSize(t *testing.T) {
	for size, want := range map[int64]time.Duration{
		0:         30 * time.Second,
		1_000_000: 40 * time.Second,
		10 << 20:  30*time.Second + time.Duration(10<<20)*time.Second/100_000,
		30 << 20:  5 * time.Minute,
	} {
		if got := bodyDeadline(size); got != want {
			t.Fatalf("bodyDeadline(%d) = %v, want %v", size, got, want)
		}
	}
}
