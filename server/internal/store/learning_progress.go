package store

import (
	"context"
	"errors"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/cover"
)

// Learning's Progress tab: the workspaces the user tracks progress in, most
// recently studied first, and the leading one's items for its map.

// progressListCap bounds each of Progress's two lists: in progress (the
// leading workspace included) and finished.
const progressListCap = 10

type LearningProgress struct {
	// Lead is the most recently studied workspace still in progress, with its
	// items for the map; nil when nothing is in progress.
	Lead *ProgressMap `json:"lead,omitempty"`
	// Active starts with the leading workspace.
	Active   []ProgressWorkspace `json:"active" nullable:"false"`
	Finished []ProgressWorkspace `json:"finished" nullable:"false"`
}

type ProgressWorkspace struct {
	WorkspaceID string       `json:"workspaceId"`
	Name        string       `json:"name"`
	IconID      string       `json:"iconId"`
	Cover       *cover.Cover `json:"cover,omitempty"`
	// Done of Total count tracked files and materials, as the Study tab does.
	Done  int `json:"done"`
	Total int `json:"total"`
	// LastStudiedAt is the latest change to the user's progress in the
	// workspace: marking, attempts and ratings all write it.
	LastStudiedAt time.Time `json:"lastStudiedAt"`
}

// ProgressMap is one workspace's tracked items with what the browser needs to
// put them in reading order (the Study tab's order) and draw them.
type ProgressMap struct {
	WorkspaceID string            `json:"workspaceId"`
	Chapters    []ProgressChapter `json:"chapters" nullable:"false"`
	Items       []ProgressItem    `json:"items" nullable:"false"`
}

type ProgressChapter struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
}

type ProgressItem struct {
	ID        string    `json:"id"`
	Type      string    `json:"type" enum:"file,material"`
	Title     string    `json:"title"`
	ChapterID *string   `json:"chapterId"`
	Position  int64     `json:"position"`
	CreatedAt time.Time `json:"createdAt"`
	// State is empty for an untouched item.
	State string `json:"state,omitempty" enum:"started,done"`
}

// LearningProgress lists the workspaces the user tracks progress in and can
// still read, with progress on, most recently studied first: up to
// progressListCap in progress and as many finished.
func (s *Store) LearningProgress(ctx context.Context, userID string) (LearningProgress, error) {
	out := LearningProgress{Active: []ProgressWorkspace{}, Finished: []ProgressWorkspace{}}
	rows, err := s.pool.Query(ctx, `SELECT w.id, w.name, w.icon_id, w.cover,
			(SELECT count(*) FROM study_progress sp
				LEFT JOIN files f ON f.id=sp.file_id LEFT JOIN materials m ON m.id=sp.material_id
				WHERE sp.user_id=$1 AND sp.workspace_id=w.id AND sp.state='done'
					AND f.trashed_at IS NULL AND m.trashed_at IS NULL),
			(SELECT count(*) FROM files f WHERE f.workspace_id=w.id AND f.trashed_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM study_progress sp
					WHERE sp.user_id=$1 AND sp.file_id=f.id AND sp.state='removed'))
				+ (SELECT count(*) FROM materials m WHERE m.workspace_id=w.id AND m.trashed_at IS NULL
					AND m.parent_material_id IS NULL
					AND NOT EXISTS (SELECT 1 FROM study_progress sp
						WHERE sp.user_id=$1 AND sp.material_id=m.id AND sp.state='removed')),
			last.at
		FROM workspaces w
		JOIN (SELECT workspace_id, max(updated_at) AS at FROM study_progress
			WHERE user_id=$1 AND state <> 'removed' GROUP BY workspace_id) last ON last.workspace_id=w.id
		ORDER BY last.at DESC, w.id`, userID)
	if err != nil {
		return out, err
	}
	var all []ProgressWorkspace
	for rows.Next() {
		var ws ProgressWorkspace
		if err := rows.Scan(&ws.WorkspaceID, &ws.Name, &ws.IconID, &ws.Cover, &ws.Done, &ws.Total, &ws.LastStudiedAt); err != nil {
			rows.Close()
			return out, err
		}
		all = append(all, ws)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, ws := range all {
		if len(out.Active) == progressListCap && len(out.Finished) == progressListCap {
			break
		}
		if ws.Total == 0 {
			continue
		}
		finished := ws.Done >= ws.Total
		if (finished && len(out.Finished) == progressListCap) || (!finished && len(out.Active) == progressListCap) {
			continue
		}
		// Access can end after progress was recorded; progress can be off.
		if _, err := s.WorkspaceEffectiveRole(ctx, userID, ws.WorkspaceID); err != nil {
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
				continue
			}
			return out, err
		}
		if on, err := s.StudyEnabled(ctx, userID, ws.WorkspaceID); err != nil || !on {
			if err != nil {
				return out, err
			}
			continue
		}
		if finished {
			out.Finished = append(out.Finished, ws)
		} else {
			out.Active = append(out.Active, ws)
		}
	}
	if len(out.Active) > 0 {
		lead, err := s.progressMap(ctx, userID, out.Active[0].WorkspaceID)
		if err != nil {
			return out, err
		}
		out.Lead = &lead
	}
	return out, nil
}

// progressMap reads one workspace's chapters and tracked items: untrashed
// files and untrashed, non-embedded materials the user has not stopped
// tracking.
func (s *Store) progressMap(ctx context.Context, userID, wsID string) (ProgressMap, error) {
	out := ProgressMap{WorkspaceID: wsID, Chapters: []ProgressChapter{}, Items: []ProgressItem{}}
	rows, err := s.pool.Query(ctx, `SELECT id, name, position FROM chapters WHERE workspace_id=$1 ORDER BY position, id`, wsID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var ch ProgressChapter
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.Order); err != nil {
			rows.Close()
			return out, err
		}
		out.Chapters = append(out.Chapters, ch)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `SELECT f.id, 'file', f.name, f.chapter_id, f.position, f.added_at, coalesce(sp.state, '')
			FROM files f LEFT JOIN study_progress sp ON sp.user_id=$1 AND sp.file_id=f.id
			WHERE f.workspace_id=$2 AND f.trashed_at IS NULL AND coalesce(sp.state, '') <> 'removed'
		UNION ALL
		SELECT m.id, 'material', m.title, m.chapter_id, m.position, m.created_at, coalesce(sp.state, '')
			FROM materials m LEFT JOIN study_progress sp ON sp.user_id=$1 AND sp.material_id=m.id
			WHERE m.workspace_id=$2 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
				AND coalesce(sp.state, '') <> 'removed'`, userID, wsID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var it ProgressItem
		if err := rows.Scan(&it.ID, &it.Type, &it.Title, &it.ChapterID, &it.Position, &it.CreatedAt, &it.State); err != nil {
			return out, err
		}
		out.Items = append(out.Items, it)
	}
	return out, rows.Err()
}
