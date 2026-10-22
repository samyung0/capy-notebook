package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// takeSized takes user's ticket for a file of size bytes and checks its place.
func takeSized(t *testing.T, q *uploadQueue, user string, size int64, position int) uploadTurn {
	t.Helper()
	turn, err := q.take(user, "sources:ws", uploadClaim{size: size})
	if err != nil || turn.Position != position {
		t.Fatalf("%s's ticket for %d bytes = %+v, %v; want position %d", user, size, turn, err, position)
	}
	return turn
}

func takeOrFail(t *testing.T, q *uploadQueue, user string, position int) uploadTurn {
	t.Helper()
	return takeSized(t, q, user, 1, position)
}

// fillBudget takes the whole budget with r0's 4 turns; it returns the first.
func fillBudget(t *testing.T, q *uploadQueue) uploadTurn {
	t.Helper()
	first := takeSized(t, q, "r0", uploadBudget/4, 0)
	for range uploadUserSlots - 1 {
		takeSized(t, q, "r0", uploadBudget/4, 0)
	}
	return first
}

func placeOf(t *testing.T, q *uploadQueue, turn uploadTurn, user string) int {
	t.Helper()
	got, err := q.wait(context.Background(), turn.TicketID, user, -1)
	if err != nil {
		t.Fatal(err)
	}
	return got.Position
}

func budgetUsed(q *uploadQueue) (int64, int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used, q.running
}

// The line holds at most 128 waiting tickets and 20 of one user's (Epo
// 2026-10-22); a ticket past either is refused as busy.
func TestUploadQueueHoldsAtMost128And20PerUser(t *testing.T) {
	q := newUploadQueue(nil)
	fillBudget(t, q)
	for i := 1; i <= 20; i++ {
		takeOrFail(t, q, "u0", i)
	}
	if _, err := q.take("u0", "sources:ws", uploadClaim{size: 1}); errorStatus(err) != 503 {
		t.Fatalf("u0's 21st waiting ticket: %v", err)
	}
	for i := 21; i <= 128; i++ {
		takeOrFail(t, q, fmt.Sprintf("u%d", (i-1)/20), i)
	}
	if _, err := q.take("newcomer", "sources:ws", uploadClaim{size: 1}); errorStatus(err) != 503 {
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
	first := fillBudget(t, q)
	takeSized(t, q, "u1", uploadBudget/4, 1)
	second := takeSized(t, q, "u1", uploadBudget/4, 2)
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
	fillBudget(t, q)
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

// Running uploads share a budget of declared bytes, not a count (Epo
// 2026-10-22): small files run far beyond 32 at once while the budget allows
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueRunsSmallFilesPastThirtyTwo(t *testing.T) {
	q := newUploadQueue(nil)
	for i := range 64 {
		takeSized(t, q, fmt.Sprintf("u%d", i/uploadUserSlots), 1_000_000, 0)
	}
}

// A big file waits until enough of the budget frees, while smaller files
// that fit pass it until it has waited uploadBlockAfter (Epo 2026-10-22)
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueHoldsABigFileUntilItFits(t *testing.T) {
	q := newUploadQueue(nil)
	var held []uploadTurn
	for range 3 {
		held = append(held, takeSized(t, q, "r0", 300_000_000, 0))
	}
	big := takeSized(t, q, "u1", 200_000_000, 1)
	takeSized(t, q, "u2", 50_000_000, 0)
	_, release, err := q.start(held[0].TicketID, "r0", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	if place := placeOf(t, q, big, "u1"); place != 1 {
		t.Fatalf("the big file is at %d before its bytes free", place)
	}
	release()
	if place := placeOf(t, q, big, "u1"); place != 0 {
		t.Fatalf("the big file is at %d once its bytes freed", place)
	}
}

// A file that has waited uploadBlockAfter blocks every file behind it until
// it fits, so small files cannot starve a big one (Epo 2026-10-22): a small
// file neither starts beside it nor takes bytes freed too few for it
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueOldFileBlocksTheLineUntilItFits(t *testing.T) {
	previous := uploadBlockAfter
	uploadBlockAfter = 0
	t.Cleanup(func() { uploadBlockAfter = previous })
	q := newUploadQueue(nil)
	var held []uploadTurn
	for range 3 {
		held = append(held, takeSized(t, q, "r0", 300_000_000, 0))
	}
	little := takeSized(t, q, "r1", 90_000_000, 0)
	big := takeSized(t, q, "u1", 200_000_000, 1)
	small := takeSized(t, q, "u2", 5_000_000, 2)
	// 90 MB free: enough for the small file, not the big one ahead of it.
	if err := q.cancel(little.TicketID, "r1", ""); err != nil {
		t.Fatal(err)
	}
	if place := placeOf(t, q, small, "u2"); place != 2 {
		t.Fatalf("the small file is at %d behind a blocking big one", place)
	}
	if err := q.cancel(held[0].TicketID, "r0", ""); err != nil {
		t.Fatal(err)
	}
	if bigAt, smallAt := placeOf(t, q, big, "u1"), placeOf(t, q, small, "u2"); bigAt != 0 || smallAt != 0 {
		t.Fatalf("once the big file fits: big at %d, small at %d", bigAt, smallAt)
	}
}

// At most 256 uploads run at once, however small (Epo 2026-10-22)
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueRunsAtMost256(t *testing.T) {
	q := newUploadQueue(nil)
	var first uploadTurn
	for i := range uploadRunMax {
		turn := takeOrFail(t, q, fmt.Sprintf("u%d", i/uploadUserSlots), 0)
		if i == 0 {
			first = turn
		}
	}
	next := takeOrFail(t, q, "newcomer", 1)
	if err := q.cancel(first.TicketID, "u0", ""); err != nil {
		t.Fatal(err)
	}
	if place := placeOf(t, q, next, "newcomer"); place != 0 {
		t.Fatalf("the 257th upload is at %d after one ended", place)
	}
}

// Every way a turn or an upload ends gives its bytes back: the upload's
// release (finished, cut off or failed: the handlers defer it), a cancel of a
// turn or a waiting ticket, and a turn that passes unused (Epo 2026-10-22)
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueReleasesTheBudgetOnEveryExit(t *testing.T) {
	previous := uploadTurnTTL
	uploadTurnTTL = time.Second
	t.Cleanup(func() { uploadTurnTTL = previous })
	q := newUploadQueue(nil)
	ran := takeSized(t, q, "a", 300_000_000, 0)
	cancelled := takeSized(t, q, "a", 300_000_000, 0)
	passed := takeSized(t, q, "a", 300_000_000, 0)
	waiting := takeSized(t, q, "b", 300_000_000, 1)
	if err := q.cancel(waiting.TicketID, "b", ""); err != nil {
		t.Fatal(err)
	}
	_, release, err := q.start(ran.TicketID, "a", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	release()
	release() // once only
	if err := q.cancel(cancelled.TicketID, "a", ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		used, running := budgetUsed(q)
		if used == 0 && running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after every exit %d bytes and %d uploads are still held (passed turn %s)", used, running, passed.TicketID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// One user runs at most 4 uploads at once, counting held turns and running
// uploads (Epo 2026-10-22): their 5th waits while another user's ticket gets
// its turn at once, and gets its turn when one of theirs ends
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueueCapsAUsersUploads(t *testing.T) {
	q := newUploadQueue(nil)
	var mine []uploadTurn
	for range uploadUserSlots {
		mine = append(mine, takeOrFail(t, q, "a", 0))
	}
	fifth := takeOrFail(t, q, "a", 1)
	other := takeOrFail(t, q, "b", 0)
	// A running upload counts as its turn did: another user's freed share
	// passes a's 5th by.
	_, release, err := q.start(mine[0].TicketID, "a", "sources:ws")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.cancel(other.TicketID, "b", ""); err != nil {
		t.Fatal(err)
	}
	if place := placeOf(t, q, fifth, "a"); place != 1 {
		t.Fatalf("a's 5th is at %d while a runs 4", place)
	}
	release()
	if place := placeOf(t, q, fifth, "a"); place != 0 {
		t.Fatalf("a's 5th is at %d after one of a's uploads ended", place)
	}
}

// Freed bytes pass over the oldest waiting ticket when its user is at their
// share, to the next user's (Epo 2026-10-22)
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
func TestUploadQueuePassesOverAUserAtTheirShare(t *testing.T) {
	q := newUploadQueue(nil)
	for range uploadUserSlots {
		takeOrFail(t, q, "a", 0)
	}
	fifth := takeOrFail(t, q, "a", 1)
	// r0 takes the rest of the budget, so b's file waits.
	var last uploadTurn
	for range uploadUserSlots {
		last = takeSized(t, q, "r0", (uploadBudget-uploadUserSlots)/uploadUserSlots, 0)
	}
	next := takeOrFail(t, q, "b", 2)
	if err := q.cancel(last.TicketID, "r0", ""); err != nil {
		t.Fatal(err)
	}
	if place := placeOf(t, q, next, "b"); place != 0 {
		t.Fatalf("b's ticket is at %d after bytes freed", place)
	}
	if place := placeOf(t, q, fifth, "a"); place != 1 {
		t.Fatalf("a's 5th is at %d while a runs 4", place)
	}
}

// An upload's body has 30 s plus its size at 100 KB/s, at most 5 minutes:
// a 30 MiB file still gets the full 5 minutes (Epo 2026-10-22)
// (security regression: human backend-storage-quota 2026-10-22 upload limits).
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
