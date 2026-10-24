package store

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"
)

// digestRecorder records the notices each recipient was sent. The database is
// shared with other packages' tests, so checks read only this test's
// recipients.
type digestRecorder struct {
	mu   sync.Mutex
	sent map[string][][]string
	more map[string][]int
}

func (r *digestRecorder) send(_ context.Context, recipient string, bodies []string, more int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sent == nil {
		r.sent, r.more = map[string][][]string{}, map[string][]int{}
	}
	r.sent[recipient] = append(r.sent[recipient], bodies)
	r.more[recipient] = append(r.more[recipient], more)
	return nil
}

func (r *digestRecorder) emails(recipient string) [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sent[recipient]
}

func addNotice(t *testing.T, s *Store, user, recipient, body string) {
	t.Helper()
	if err := s.AddBankCommentNotice(context.Background(), user, recipient, body); err != nil {
		t.Fatal(err)
	}
}

// TestBankCommentDigestSendsOneEmailPerRecipient (security regression:
// rate-limit audit L7). Comments stored within one window reach each
// recipient as one email holding all of them.
func TestBankCommentDigestSendsOneEmailPerRecipient(t *testing.T) {
	s := openAccessTestStore(t)
	first := newBlobTestUser(t, s, "u_bank_notice_a")
	second := newBlobTestUser(t, s, "u_bank_notice_b")
	reviewers, editors := uid("reviewers")+"@example.test", uid("editors")+"@example.test"
	addNotice(t, s, first, reviewers, "one")
	addNotice(t, s, second, reviewers, "two")
	addNotice(t, s, first, editors, "three")

	var r digestRecorder
	if _, err := s.SendBankCommentDigests(context.Background(), r.send); err != nil {
		t.Fatal(err)
	}
	got := r.emails(reviewers)
	if len(got) != 1 {
		t.Fatalf("reviewers got %d emails, want 1", len(got))
	}
	bodies := slices.Clone(got[0])
	slices.Sort(bodies)
	if !slices.Equal(bodies, []string{"one", "two"}) {
		t.Fatalf("reviewers' email holds %v", got[0])
	}
	if got := r.emails(editors); len(got) != 1 || !slices.Equal(got[0], []string{"three"}) {
		t.Fatalf("editors got %v", got)
	}
}

// TestBankCommentDigestSkipsDeletedComments (security regression: rate-limit
// audit L7). A comment whose author requested account deletion before the
// batch is not sent, and the purge deletes it.
func TestBankCommentDigestSkipsDeletedComments(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	kept := newBlobTestUser(t, s, "u_bank_notice_kept")
	leaving := newBlobTestUser(t, s, "u_bank_notice_leaving")
	reviewers := uid("reviewers") + "@example.test"
	addNotice(t, s, kept, reviewers, "kept")
	addNotice(t, s, leaving, reviewers, "deleted")
	if _, err := s.RequestAccountDeletion(ctx, leaving, true); err != nil {
		t.Fatal(err)
	}

	var r digestRecorder
	if _, err := s.SendBankCommentDigests(ctx, r.send); err != nil {
		t.Fatal(err)
	}
	if got := r.emails(reviewers); len(got) != 1 || !slices.Equal(got[0], []string{"kept"}) {
		t.Fatalf("reviewers got %v, want only the kept comment", got)
	}
	if err := s.PurgeUser(ctx, leaving); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bank_comment_notices WHERE user_id=$1`, leaving).Scan(&n); err != nil || n != 0 {
		t.Fatalf("notices after purge = %d %v", n, err)
	}
}

// TestBankCommentDigestSendsANoticeOnce (security regression: rate-limit audit
// L7). A notice that was sent is not sent by the next batch.
func TestBankCommentDigestSendsANoticeOnce(t *testing.T) {
	s := openAccessTestStore(t)
	user := newBlobTestUser(t, s, "u_bank_notice_once")
	reviewers := uid("reviewers") + "@example.test"
	addNotice(t, s, user, reviewers, "once")

	var r digestRecorder
	for range 2 {
		if _, err := s.SendBankCommentDigests(context.Background(), r.send); err != nil {
			t.Fatal(err)
		}
	}
	if got := r.emails(reviewers); len(got) != 1 {
		t.Fatalf("reviewers got %d emails over two batches, want 1", len(got))
	}
}

// TestBankCommentDigestRunsOnceAcrossReplicas (security regression: rate-limit
// audit L7). A batch started while another is still sending skips the
// notices that one holds instead of sending them again.
func TestBankCommentDigestRunsOnceAcrossReplicas(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "u_bank_notice_replicas")
	reviewers := uid("reviewers") + "@example.test"
	addNotice(t, s, user, reviewers, "held")

	var r digestRecorder
	sending, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := s.SendBankCommentDigests(ctx, func(ctx context.Context, recipient string, bodies []string, more int) error {
			if recipient == reviewers {
				close(sending)
				<-release
			}
			return r.send(ctx, recipient, bodies, more)
		})
		done <- err
	}()
	select {
	case <-sending:
	case err := <-done:
		t.Fatalf("first batch ended before sending: %v", err)
	}
	second, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, err := s.SendBankCommentDigests(second, r.send)
	cancel()
	close(release)
	if err != nil {
		t.Fatalf("second batch: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("first batch: %v", err)
	}
	if got := r.emails(reviewers); len(got) != 1 {
		t.Fatalf("reviewers got %d emails from two concurrent batches, want 1", len(got))
	}
}

// TestSentBankCommentNoticesArePrunedAfter30Days (Epo 2026-10-24, Q302). A
// notice whose digest was sent more than 30 days ago is deleted; one sent
// more recently stays.
func TestSentBankCommentNoticesArePrunedAfter30Days(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "u_bank_notice_prune")
	recipient := uid("prune") + "@example.test"
	addNotice(t, s, user, recipient, "old")
	addNotice(t, s, user, recipient, "recent")
	if _, err := s.pool.Exec(ctx, `UPDATE bank_comment_notices
		SET sent_at = now() - CASE body WHEN 'old' THEN interval '31 days' ELSE interval '29 days' END
		WHERE recipient = $1`, recipient); err != nil {
		t.Fatal(err)
	}
	if err := s.PruneBankCommentNotices(ctx); err != nil {
		t.Fatal(err)
	}
	var left []string
	rows, err := s.pool.Query(ctx, `SELECT body FROM bank_comment_notices WHERE recipient = $1 ORDER BY body`, recipient)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		left = append(left, body)
	}
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	if !slices.Equal(left, []string{"recent"}) {
		t.Fatalf("notices left = %v, want [recent]", left)
	}
}

// TestBankCommentDigestListsAtMost200 (security regression: rate-limit audit
// r2 N-8, Q314). One digest email lists at most 200 comments and counts the
// rest, and every notice of the batch is marked sent.
func TestBankCommentDigestListsAtMost200(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "u_bank_notice_many")
	recipient := uid("many") + "@example.test"
	if _, err := s.pool.Exec(ctx, `INSERT INTO bank_comment_notices (id, user_id, recipient, body)
		SELECT 'bcn_many_' || n, $1, $2, 'comment ' || n FROM generate_series(1, $3::int) n`,
		user, recipient, BankDigestComments+5); err != nil {
		t.Fatal(err)
	}
	var r digestRecorder
	if _, err := s.SendBankCommentDigests(ctx, r.send); err != nil {
		t.Fatal(err)
	}
	if got := r.emails(recipient); len(got) != 1 || len(got[0]) != BankDigestComments || r.more[recipient][0] != 5 {
		t.Fatalf("emails %d, first listing %d with %v more; want one listing 200 and 5 more", len(got), len(got[0]), r.more[recipient])
	}
	if _, err := s.SendBankCommentDigests(ctx, r.send); err != nil {
		t.Fatal(err)
	}
	if got := r.emails(recipient); len(got) != 1 {
		t.Fatalf("a second batch sent %d more emails, want none: all were marked sent", len(got)-1)
	}
}
