package store

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// openWindow is how stale an open may be before another open writes it again:
// recent lists sort to within it, and opening something repeatedly costs one
// write per window. The client sends at most one open per window too
// (src/lib/sentOpens.ts).
const openWindow = 5 * time.Minute

// recentWrites remembers this process's last written open per user and
// target, so an open within openWindow is acknowledged without touching the
// database. ponytail: one process-wide map dropped when full, as
// parsedItems; the SQL repeats the window for other processes and restarts.
// A visitor's visit is never noted here: Forget on another process, or the
// workspace turning private and back, deletes the row without touching this
// map, and the reopen must write it again.
var recentWrites = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

const recentWritesMax = 100_000

func openKey(kind, userID, id string) string { return kind + "\x00" + userID + "\x00" + id }

func writtenWithinWindow(key string, now time.Time) bool {
	recentWrites.Lock()
	defer recentWrites.Unlock()
	last, ok := recentWrites.m[key]
	return ok && now.Sub(last) < openWindow
}

func noteWritten(key string, now time.Time) {
	recentWrites.Lock()
	defer recentWrites.Unlock()
	if len(recentWrites.m) >= recentWritesMax {
		recentWrites.m = map[string]time.Time{}
	}
	recentWrites.m[key] = now
}

func forgetWritten(key string) {
	recentWrites.Lock()
	defer recentWrites.Unlock()
	delete(recentWrites.m, key)
}

// RecordWorkspaceVisit notes that the caller opened a workspace they can
// read. Within openWindow of the last one it does nothing.
func (s *Store) RecordWorkspaceVisit(ctx context.Context, userID, wsID string) error {
	key := openKey("workspace", userID, wsID)
	now := time.Now()
	if writtenWithinWindow(key, now) {
		return nil
	}
	member, effective, err := workspaceRoles(ctx, s.pool, userID, wsID)
	if err != nil {
		return err
	}
	if effective == "" {
		return ErrNotFound
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_visits (user_id, workspace_id) VALUES ($1, $2)
		ON CONFLICT (user_id, workspace_id) DO UPDATE SET opened_at = now()
		WHERE workspace_visits.opened_at < now() - make_interval(secs => $3)`,
		userID, wsID, openWindow.Seconds()); err != nil {
		return err
	}
	if member != "" {
		noteWritten(key, now)
	}
	return nil
}

// ForgetWorkspaceVisit deletes the caller's visit: a workspace they reach
// only as a visitor leaves their lists until they open it again.
func (s *Store) ForgetWorkspaceVisit(ctx context.Context, userID, wsID string) error {
	forgetWritten(openKey("workspace", userID, wsID))
	_, err := s.pool.Exec(ctx, `DELETE FROM workspace_visits WHERE user_id=$1 AND workspace_id=$2`, userID, wsID)
	return err
}

// OpenKind names what an item open points at.
type OpenKind string

const (
	OpenFile     OpenKind = "file"
	OpenMaterial OpenKind = "material"
)

// upsertOpenSQL writes an item open; with window > 0 a row younger than it is
// left alone. $1 user, $2 item, $3 window in seconds.
func upsertOpenSQL(kind OpenKind) string {
	column := "file_id"
	if kind == OpenMaterial {
		column = "material_id"
	}
	return `INSERT INTO item_opens (user_id, ` + column + `) VALUES ($1, $2)
		ON CONFLICT (user_id, ` + column + `) WHERE ` + column + ` IS NOT NULL
		DO UPDATE SET opened_at = now()
		WHERE item_opens.opened_at < now() - make_interval(secs => $3)`
}

// RecordItemOpen notes that the caller opened a file or material they can
// read. Within openWindow of the last one it does nothing.
func (s *Store) RecordItemOpen(ctx context.Context, userID string, kind OpenKind, id string) error {
	key := openKey(string(kind), userID, id)
	now := time.Now()
	if writtenWithinWindow(key, now) {
		return nil
	}
	if kind == OpenFile {
		if _, err := s.FileEffectiveRole(ctx, userID, id); err != nil {
			return err
		}
	} else {
		if _, err := s.MaterialAccess(ctx, userID, id); err != nil {
			return err
		}
		// Recent never lists an embedded material or someone else's
		// standalone one (a shared link): writing it would only lengthen the
		// scan.
		var listable bool
		if err := s.pool.QueryRow(ctx, `SELECT parent_material_id IS NULL
				AND (workspace_id IS NOT NULL OR owner_user_id = $2)
			FROM materials WHERE id = $1`, id, userID).Scan(&listable); err != nil {
			return err
		}
		if !listable {
			return nil
		}
	}
	if _, err := s.pool.Exec(ctx, upsertOpenSQL(kind), userID, id, openWindow.Seconds()); err != nil {
		return err
	}
	noteWritten(key, now)
	return nil
}

// markCreatedTx counts creating an item as its creator opening it, inside
// the creating transaction. Copies of a whole workspace are not marked: they
// would fill Recent at once.
func markCreatedTx(ctx context.Context, tx pgx.Tx, userID string, kind OpenKind, id string) error {
	if userID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, upsertOpenSQL(kind), userID, id, 0)
	return err
}

// ItemOpen is one row of the caller's Recent: what they opened and when.
type ItemOpen struct {
	Kind     OpenKind
	ID       string
	OpenedAt time.Time
}

// RecentOpens lists the caller's newest opens that a Member listing still
// shows them: untrashed files and top-level materials of materialKinds in the
// workspace list's set, and their own standalone files and materials.
func (s *Store) RecentOpens(ctx context.Context, userID string, materialKinds []string, limit int) ([]ItemOpen, error) {
	rows, err := s.pool.Query(ctx, `SELECT o.file_id, o.material_id, o.opened_at FROM item_opens o
		LEFT JOIN files f ON f.id = o.file_id
		LEFT JOIN materials m ON m.id = o.material_id
		WHERE o.user_id = $1 AND (
			(f.id IS NOT NULL AND f.trashed_at IS NULL AND (
				(f.workspace_id IS NULL AND f.user_id = $1)
				OR f.workspace_id IN (`+visibleWorkspacesSQL("$1")+`)))
			OR (m.id IS NOT NULL AND m.trashed_at IS NULL AND m.parent_material_id IS NULL AND m.kind = ANY($3) AND (
				(m.workspace_id IS NULL AND m.owner_user_id = $1)
				OR m.workspace_id IN (`+visibleWorkspacesSQL("$1")+`))))
		ORDER BY o.opened_at DESC, o.file_id, o.material_id LIMIT $2`, userID, limit, materialKinds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ItemOpen{}
	for rows.Next() {
		var fileID, materialID *string
		var open ItemOpen
		if err := rows.Scan(&fileID, &materialID, &open.OpenedAt); err != nil {
			return nil, err
		}
		if fileID != nil {
			open.Kind, open.ID = OpenFile, *fileID
		} else {
			open.Kind, open.ID = OpenMaterial, *materialID
		}
		out = append(out, open)
	}
	return out, rows.Err()
}
