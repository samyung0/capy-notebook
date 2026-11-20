package store

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"time"
)

// HistoryKind is what a Study → History row records.
type HistoryKind string

const (
	HistoryRevision   HistoryKind = "revision"
	HistoryQuiz       HistoryKind = "quiz"
	HistoryFlashcards HistoryKind = "flashcards"
)

// HistoryStatus is where a row stands: done (everything answered), partial
// (it ended with some left: skipped, ended early, or a newer try began) or
// open (it can be continued).
type HistoryStatus string

const (
	HistoryDone    HistoryStatus = "done"
	HistoryPartial HistoryStatus = "partial"
	HistoryOpen    HistoryStatus = "open"
)

// HistoryRow is one row of Study → History (Epo 2026-11-13): a revision (a
// review session) or a quiz or flashcard attempt.
type HistoryRow struct {
	ID   string      `json:"id"`
	Kind HistoryKind `json:"kind" enum:"revision,quiz,flashcards"`
	// At is a revision's latest answer, or an attempt's latest check or rating.
	At            time.Time `json:"at"`
	WorkspaceID   *string   `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	IconID        string    `json:"iconId"`
	// Name and MaterialID are an attempt's quiz or set; empty for a revision.
	Name       string  `json:"name"`
	MaterialID *string `json:"materialId"`
	// Group is a revision's: a topic (Topics holds it), Other files or the
	// whole workspace. Topics are an attempt's quiz or set topics.
	Group   *string  `json:"group,omitempty" enum:"topic,others,workspace"`
	TopicID *string  `json:"topicId,omitempty"`
	Topics  []string `json:"topics" nullable:"false"`
	// Correct of Total: marks, plus cards rated Good or Easy of cards rated.
	Correct float64 `json:"correct"`
	Total   float64 `json:"total"`
	// Answered of Items: what was answered of what the revision served, or of
	// what the quiz or set holds now (0 once it is gone).
	Answered int           `json:"answered"`
	Items    int           `json:"items"`
	Status   HistoryStatus `json:"status" enum:"done,partial,open"`
}

type HistoryParams struct {
	Sort       string // date, workspace, name, topic, score
	Ascending  bool
	Kinds      []string
	Workspaces []string
	// Statuses keeps rows in these statuses; empty is all.
	Statuses []HistoryStatus
	Offset   int
	Limit    int
	// Continuing keeps Continue's rows: at or after Since, not removed from
	// it, outside classes the user teaches.
	Continuing bool
	Since      time.Time
}

// historyScan is how many rows a status filter reads at a time: a row's
// status needs its quiz or set's current size, read outside SQL.
const historyScan = 100

// StudyHistory pages the user's revisions and quiz and flashcard attempts
// together, newest first by default. The second value is whether more follow.
func (s *Store) StudyHistory(ctx context.Context, userID string, p HistoryParams) ([]HistoryRow, bool, error) {
	if len(p.Statuses) == 0 {
		out, err := s.historyRows(ctx, userID, p, p.Offset, p.Limit+1)
		if err != nil || len(out) <= p.Limit {
			return out, false, err
		}
		return out[:p.Limit], true, nil
	}
	// Filtered by status: read in order until the page and one more match.
	out := []HistoryRow{}
	skip := p.Offset
	for from := 0; ; from += historyScan {
		rows, err := s.historyRows(ctx, userID, p, from, historyScan)
		if err != nil {
			return nil, false, err
		}
		for _, r := range rows {
			if !slices.Contains(p.Statuses, r.Status) {
				continue
			}
			if skip > 0 {
				skip--
				continue
			}
			if len(out) == p.Limit {
				return out, true, nil
			}
			out = append(out, r)
		}
		if len(rows) < historyScan {
			return out, false, nil
		}
	}
}

// historyRows reads limit rows from offset in the page's order, with their
// status.
func (s *Store) historyRows(ctx context.Context, userID string, p HistoryParams, offset, limit int) ([]HistoryRow, error) {
	order := map[string]string{
		"workspace": "lower(h.workspace_name)",
		"name":      "lower(NULLIF(h.name, ''))",
		"topic":     "lower(h.topics[1])",
		"score":     "h.correct / NULLIF(h.total, 0)",
	}[p.Sort]
	if order == "" {
		order = "h.at"
	}
	dir := " DESC NULLS LAST"
	if p.Ascending {
		dir = " ASC NULLS LAST"
	}
	// The caller's revisions stay, but names it can no longer reach are blank
	// (Sam 2026-10-19), as on the Files page.
	lost := lostAccessSQL("rs.workspace_id", "$1")
	attemptWS := "COALESCE(m.workspace_id, m.practice_workspace_id)"
	args := []any{userID}
	var where []string
	if len(p.Kinds) > 0 {
		args = append(args, p.Kinds)
		where = append(where, "h.kind = ANY($"+strconv.Itoa(len(args))+")")
	}
	if len(p.Workspaces) > 0 {
		args = append(args, p.Workspaces)
		where = append(where, "h.workspace_id = ANY($"+strconv.Itoa(len(args))+")")
	}
	// Only an unfinished revision or a newest try can be in progress.
	if len(p.Statuses) == 1 && p.Statuses[0] == HistoryOpen {
		where = append(where, "(h.unfinished OR h.latest)")
	}
	if p.Continuing {
		args = append(args, p.Since)
		where = append(where, "NOT h.hidden AND h.at >= $"+strconv.Itoa(len(args)),
			`NOT EXISTS (SELECT 1 FROM workspaces cw WHERE cw.id = h.workspace_id AND cw.kind = 'class'
				AND (cw.user_id = $1 OR EXISTS (SELECT 1 FROM workspace_members cm
					WHERE cm.workspace_id = cw.id AND cm.user_id = $1 AND cm.role = 'editor')))`)
	}
	q := `WITH h AS (
		SELECT 'revision' AS kind, rs.id::text AS id, rs.last_answer_at AS at, rs.workspace_id,
			CASE WHEN ` + lost + ` THEN '' ELSE w.name END AS workspace_name,
			CASE WHEN ` + lost + ` THEN '' ELSE w.icon_id END AS icon_id,
			'' AS name, NULL::text AS material_id, rs.group_kind, rs.topic_id::text AS topic_id,
			CASE WHEN rs.group_kind = 'topic' AND t.name IS NOT NULL AND NOT ` + lost + ` THEN ARRAY[t.name] ELSE '{}'::text[] END AS topics,
			COALESCE((SELECT sum(CASE WHEN ra.kind = 'card' THEN (ra.rating >= 3)::int ELSE ra.correct END) FROM review_answers ra WHERE ra.session_id = rs.id), 0)::float8 AS correct,
			COALESCE((SELECT sum(CASE WHEN ra.kind = 'card' THEN 1 ELSE ra.total END) FROM review_answers ra WHERE ra.session_id = rs.id), 0)::float8 AS total,
			(SELECT count(*) FROM review_answers ra WHERE ra.session_id = rs.id)::int AS answered,
			jsonb_array_length(rs.items) AS served, rs.finished_at IS NULL AND NOT ` + lost + ` AS unfinished, false AS latest,
			rs.continue_hidden_at IS NOT NULL AS hidden
		FROM review_sessions rs JOIN workspaces w ON w.id = rs.workspace_id LEFT JOIN topics t ON t.id = rs.topic_id
		WHERE rs.user_id = $1
		UNION ALL
		SELECT a.kind, a.id, a.taken_at, ` + attemptWS + `, a.workspace_name, COALESCE(w.icon_id, ''),
			a.quiz_name, a.material_id, NULL, NULL, a.topics, a.correct, a.total,
			jsonb_array_length(a.questions), 0, false,
			a.material_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attempts b WHERE b.user_id = a.user_id
				AND b.material_id = a.material_id AND b.kind = a.kind AND (b.taken_at, b.id) > (a.taken_at, a.id)),
			a.continue_hidden_at IS NOT NULL
		FROM attempts a LEFT JOIN materials m ON m.id = a.material_id LEFT JOIN workspaces w ON w.id = ` + attemptWS + `
		WHERE a.user_id = $1 AND a.kind IN ('quiz', 'flashcards'))
	SELECT h.kind, h.id, h.at, h.workspace_id, h.workspace_name, h.icon_id, h.name, h.material_id, h.group_kind,
		h.topic_id, h.topics, h.correct, h.total, h.answered, h.served, h.unfinished, h.latest
	FROM h`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, limit, offset)
	q += " ORDER BY " + order + dir + ", h.at DESC, h.id LIMIT $" + strconv.Itoa(len(args)-1) + " OFFSET $" + strconv.Itoa(len(args))
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryRow{}
	type extra struct {
		served     int
		unfinished bool
		latest     bool
	}
	var extras []extra
	for rows.Next() {
		var r HistoryRow
		var e extra
		if err := rows.Scan(&r.Kind, &r.ID, &r.At, &r.WorkspaceID, &r.WorkspaceName, &r.IconID, &r.Name, &r.MaterialID, &r.Group,
			&r.TopicID, &r.Topics, &r.Correct, &r.Total, &r.Answered, &e.served, &e.unfinished, &e.latest); err != nil {
			return nil, err
		}
		if r.Topics == nil {
			r.Topics = []string{}
		}
		out = append(out, r)
		extras = append(extras, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	sizes, err := s.materialSizes(ctx, userID, out)
	if err != nil {
		return nil, err
	}
	for i := range out {
		r, e := &out[i], extras[i]
		if r.Kind == HistoryRevision {
			r.Items = e.served
			r.Status = historyStatus(r.Answered, r.Items, e.unfinished)
			continue
		}
		// Only the newest try of a quiz or set the user can still open goes on.
		size, open := sizes[*r.MaterialID]
		r.Items = size
		r.Status = historyStatus(r.Answered, r.Items, open && e.latest)
	}
	return out, nil
}

func historyStatus(answered, items int, continues bool) HistoryStatus {
	switch {
	case answered >= items:
		return HistoryDone
	case continues:
		return HistoryOpen
	default:
		return HistoryPartial
	}
}

// materialSizes counts the items of the rows' quizzes and sets that the user
// may still open, from the parsed-items cache; a material it may not open, or
// whose content is refused, is left out.
func (s *Store) materialSizes(ctx context.Context, userID string, rows []HistoryRow) (map[string]int, error) {
	var ids []string
	for _, r := range rows {
		if r.MaterialID != nil {
			ids = append(ids, *r.MaterialID)
		}
	}
	out := map[string]int{}
	if len(ids) == 0 {
		return out, nil
	}
	list, err := s.pool.Query(ctx, `SELECT `+materialColsM+` FROM materials m
		WHERE m.id = ANY($1) AND m.trashed_at IS NULL AND m.parent_material_id IS NULL AND m.assignment_id IS NULL
			AND (m.owner_user_id = $2 OR (m.workspace_id IS NOT NULL AND NOT `+lostAccessSQL("m.workspace_id", "$2")+`))
			AND workspace_item_visible(`+materialHiddenSQL+`, m.workspace_id, $2)`, ids, userID)
	if err != nil {
		return nil, err
	}
	defer list.Close()
	for list.Next() {
		mt, err := scanMaterial(list)
		if err != nil {
			return nil, err
		}
		items, err := itemsOf(mt)
		if refused(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[mt.ID] = len(items)
	}
	return out, list.Err()
}

// continueWindow is how long something left partway stays in Continue
// (Epo 2026-11-13: a week). Continue shows three; continueRows keeps spares,
// so a removed card's place fills at once (Epo 2026-11-13).
const (
	continueWindow = 7 * 24 * time.Hour
	continueRows   = 6
)

// ContinueRows is Study's Continue, or one workspace's when wsID is set: the
// newest revisions and quiz and flashcard tries that can go on, left within
// the week and not removed from Continue.
func (s *Store) ContinueRows(ctx context.Context, userID, wsID string, now time.Time) ([]HistoryRow, error) {
	p := HistoryParams{Continuing: true, Since: now.Add(-continueWindow),
		Statuses: []HistoryStatus{HistoryOpen}, Limit: continueRows}
	if wsID != "" {
		p.Workspaces = []string{wsID}
	}
	rows, _, err := s.StudyHistory(ctx, userID, p)
	return rows, err
}

// HideContinue removes the caller's revision or try from Continue; History
// still lists it and continues it.
func (s *Store) HideContinue(ctx context.Context, userID string, kind HistoryKind, id string) error {
	q := `UPDATE attempts SET continue_hidden_at = now() WHERE id = $1 AND user_id = $2 AND kind = $3`
	args := []any{id, userID, string(kind)}
	if kind == HistoryRevision {
		q = `UPDATE review_sessions SET continue_hidden_at = now() WHERE id::text = $1 AND user_id = $2`
		args = args[:2]
	}
	tag, err := s.pool.Exec(ctx, q, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
