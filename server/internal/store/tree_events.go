package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ListenWorkspaceTree receives the "<workspaceId>:<files|materials>" payloads
// raised by the files/materials triggers (migration 0004) until the context
// ends or the connection fails, calling listening once attached and fn for
// each payload. It holds a connection of its own: a LISTEN issued on a pooled
// connection would follow it to the next borrower.
func (s *Store) ListenWorkspaceTree(ctx context.Context, listening func(), fn func(workspaceID, kind string)) error {
	conn, err := pgx.ConnectConfig(ctx, s.pool.Config().ConnConfig)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, "LISTEN workspace_tree"); err != nil {
		return err
	}
	listening()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if wsID, kind, ok := strings.Cut(n.Payload, ":"); ok {
			fn(wsID, kind)
		}
	}
}
