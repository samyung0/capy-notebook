package store

import (
	"context"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/cover"
)

// Learning's Progress tab: the workspaces the user tracks progress in, most
// recently studied first, and the leading one's items for its map.

// progressListCap bounds each of Progress's two lists: in progress (the
// leading workspace included) and finished.
const progressListCap = 10

type LearningProgress struct {
	// Lead is the map's workspace with its items: the requested one when it is
	// listed, else the most recently studied in progress, else the most
	// recently finished; nil when both lists are empty.
	Lead *ProgressMap `json:"lead,omitempty"`
	// Active starts with the leading workspace.
	Active   []ProgressWorkspace `json:"active" nullable:"false"`
	Finished []ProgressWorkspace `json:"finished" nullable:"false"`
	// HiddenCount is how many workspaces with progress hide it, listed or
	// not: Show hidden's count.
	HiddenCount int `json:"hiddenCount"`
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
	// Hidden is the user's Hide study progress, listed only for Show all.
	Hidden bool `json:"hidden,omitempty"`
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
	ID   string `json:"id"`
	Type string `json:"type" enum:"file,material"`
	// Kind is the file's kind or the material's type, for its icon.
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	ChapterID *string   `json:"chapterId"`
	Position  int64     `json:"position"`
	CreatedAt time.Time `json:"createdAt"`
	// State is empty for an untouched item.
	State string `json:"state,omitempty" enum:"started,done"`
	// DoneAt is a done item's latest progress change, as a workspace's
	// LastStudiedAt is: when a plan finished is its items' latest.
	DoneAt *time.Time `json:"doneAt,omitempty"`
}

// LearningProgress lists the workspaces the user tracks progress in and can
// still read, most recently studied first: up to progressListCap in progress
// and as many finished. Workspaces hiding study progress are left out unless
// showHidden is set (HiddenCount counts them either way), and never lead.
// leadID asks for that workspace's map (a finished one, after its finish
// toast).
func (s *Store) LearningProgress(ctx context.Context, userID, leadID string, showHidden bool) (LearningProgress, error) {
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
	hidden := map[string]bool{}
	rows, err = s.pool.Query(ctx, `SELECT workspace_id FROM workspace_study WHERE user_id=$1 AND NOT enabled`, userID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return out, err
		}
		hidden[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, ws := range all {
		if ws.Total == 0 {
			continue
		}
		finished := ws.Done >= ws.Total
		full := (finished && len(out.Finished) == progressListCap) || (!finished && len(out.Active) == progressListCap)
		// A hidden workspace is counted even past the caps.
		if full && !hidden[ws.WorkspaceID] {
			continue
		}
		// Access can end after progress was recorded.
		if ok, err := s.canReadWorkspace(ctx, userID, ws.WorkspaceID); err != nil || !ok {
			if err != nil {
				return out, err
			}
			continue
		}
		ws.Hidden = hidden[ws.WorkspaceID]
		if ws.Hidden {
			out.HiddenCount++
		}
		if full || (ws.Hidden && !showHidden) {
			continue
		}
		if finished {
			out.Finished = append(out.Finished, ws)
		} else {
			out.Active = append(out.Active, ws)
		}
	}
	leadWS := ""
	for _, ws := range append(append([]ProgressWorkspace{}, out.Active...), out.Finished...) {
		if ws.Hidden {
			continue
		}
		if leadWS == "" || ws.WorkspaceID == leadID {
			leadWS = ws.WorkspaceID
		}
	}
	if leadWS != "" {
		lead, err := s.progressMap(ctx, userID, leadWS)
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
	rows, err = s.pool.Query(ctx, `SELECT f.id, 'file', f.kind, f.name, f.chapter_id, f.position, f.added_at, coalesce(sp.state, ''),
				CASE WHEN sp.state='done' THEN sp.updated_at END
			FROM files f LEFT JOIN study_progress sp ON sp.user_id=$1 AND sp.file_id=f.id
			WHERE f.workspace_id=$2 AND f.trashed_at IS NULL AND coalesce(sp.state, '') <> 'removed'
		UNION ALL
		SELECT m.id, 'material', m.kind, m.title, m.chapter_id, m.position, m.created_at, coalesce(sp.state, ''),
				CASE WHEN sp.state='done' THEN sp.updated_at END
			FROM materials m LEFT JOIN study_progress sp ON sp.user_id=$1 AND sp.material_id=m.id
			WHERE m.workspace_id=$2 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
				AND coalesce(sp.state, '') <> 'removed'`, userID, wsID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var it ProgressItem
		if err := rows.Scan(&it.ID, &it.Type, &it.Kind, &it.Title, &it.ChapterID, &it.Position, &it.CreatedAt, &it.State, &it.DoneAt); err != nil {
			return out, err
		}
		out.Items = append(out.Items, it)
	}
	return out, rows.Err()
}
