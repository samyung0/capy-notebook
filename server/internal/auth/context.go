package auth

import (
	"context"

	"github.com/evonotes/server/internal/obs"
)

type ctxKey int

const userIDKey ctxKey = iota

// WithUserID attaches the authenticated user id to ctx. It also records the id
// for observability, so every log line emitted downstream of authentication
// names the actor without each call site having to pass it along.
func WithUserID(ctx context.Context, userID string) context.Context {
	ctx = obs.WithUser(ctx, userID)
	return context.WithValue(ctx, userIDKey, userID)
}

// UserID returns the authenticated user id, or "" if absent.
func UserID(ctx context.Context) string {
	v, _ := ctx.Value(userIDKey).(string)
	return v
}
