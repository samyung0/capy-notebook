package ratelimit

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// MaxWait is how long a limited chat send or answer check waits for its
// buckets before it is refused (Epo 2026-10-24, Q268). Every other limited
// route is refused at once, and nothing retries a 429 automatically.
const MaxWait = 10 * time.Second

// Clock is the limiter's time; tests replace it so a wait takes no real time.
type Clock interface {
	Now() time.Time
	Sleep(ctx context.Context, d time.Duration) error
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *Limiter) clock() Clock {
	if l.cfg.Clock != nil {
		return l.cfg.Clock
	}
	return realClock{}
}

// Refusal is a request its buckets did not admit in time: the refusing
// bucket's error code and how long until that bucket would admit it.
type Refusal struct {
	Code       string
	RetryAfter time.Duration
}

func (r *Refusal) Error() string { return r.Code }

// Wait finishes a chat send's admission after its stream has told the
// browser it is waiting: nil once admitted, else a *Refusal.
type Wait func(ctx context.Context) error

type waitKey struct{}

// PendingWait is the wait the chat send in ctx must finish before its turn
// runs, or nil when the limiter admitted it outright.
func PendingWait(ctx context.Context) Wait {
	wait, _ := ctx.Value(waitKey{}).(Wait)
	return wait
}

// bucket is one budget a request spends from.
type bucket struct {
	key        string
	rule       Rule
	code       string
	failClosed bool
}

// admit takes one request from each bucket in order. A refused bucket is
// waited for while its retry-after ends by deadline (the zero deadline never
// waits); past that, admit returns the refusal and the buckets from the
// refused one on, still untaken. A bucket Redis cannot decide passes unless
// it fails closed, which returns the Redis error.
func (l *Limiter) admit(ctx context.Context, buckets []bucket, deadline time.Time) ([]bucket, *Refusal, error) {
	clock := l.clock()
	for i, b := range buckets {
		for {
			ok, retry, err := l.Allow(ctx, b.key, b.rule)
			if err != nil {
				if b.failClosed {
					return buckets[i:], nil, err
				}
				break
			}
			if ok {
				break
			}
			refusal := &Refusal{Code: b.code, RetryAfter: retry}
			if clock.Now().Add(retry).After(deadline) || clock.Sleep(ctx, retry) != nil {
				return buckets[i:], refusal, nil
			}
		}
	}
	return nil, nil, nil
}

// chatSend is a chat turn: its AI buckets may be waited for inside the stream.
func chatSend(method, path string) bool {
	return method == http.MethodPost && strings.HasSuffix(path, "/chat/stream")
}

// answerCheck is a graded answer check, which waits for its buckets before
// grading: a quiz attempt, a review or bank check, a computation check, or a
// signed-out grade.
func answerCheck(method, path string) bool {
	if method != http.MethodPost {
		return false
	}
	return (strings.HasPrefix(path, "/api/quizzes/") && strings.HasSuffix(path, "/attempts")) ||
		strings.HasSuffix(path, "/check") ||
		strings.HasSuffix(path, "/computation-check") ||
		(strings.HasPrefix(path, "/api/public/") && strings.HasSuffix(path, "/grade"))
}
