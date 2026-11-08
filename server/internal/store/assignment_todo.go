package store

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// TodoWorkspace is one class's section of the To do page. Manages: the caller
// owns it or is an editor member, as Assignment.Manage's readers are.
type TodoWorkspace struct {
	WorkspaceID string       `json:"workspaceId"`
	Name        string       `json:"name"`
	IconID      string       `json:"iconId"`
	Manages     bool         `json:"manages"`
	Items       []Assignment `json:"items" nullable:"false"`
}

// TodoList is the To do page: every class holding something for the caller.
type TodoList struct {
	Workspaces []TodoWorkspace `json:"workspaces" nullable:"false"`
}

// The rows worth reading for To do, so a class's old work costs nothing; isTodo
// still decides, as closing under No late is worked out on read. Only a viewer
// goes to everyone, so staff's own work is what names them.
const (
	todoOpenRows = `NOT a.draft AND a.closed_at IS NULL`
	todoNamed    = `EXISTS (SELECT 1 FROM assignment_assignees aa WHERE aa.assignment_id=a.id AND aa.user_id=$2)`
	todoWaiting  = `EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=a.id AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0)`

	todoStaffRows  = `a.workspace_id = ANY($1) AND (` + todoWaiting + ` OR (` + todoOpenRows + ` AND ` + todoNamed + `))`
	todoMemberRows = `a.workspace_id = ANY($1) AND ` + todoOpenRows + ` AND (a.assign_all OR ` + todoNamed + `)`
)

// ListTodo is what each class's Dashboard lists under To do, across the classes
// the caller belongs to: answers waiting for them and what was given to them
// and is still open, done or not. A class with nothing for them is left out.
func (s *Store) ListTodo(ctx context.Context, userID string, now time.Time) (TodoList, error) {
	out := TodoList{Workspaces: []TodoWorkspace{}}
	cs, err := s.todoClasses(ctx, userID)
	if err != nil {
		return out, err
	}
	for _, group := range []struct {
		ids   []string
		staff bool
		where string
	}{{cs.staff, true, todoStaffRows}, {cs.members, false, todoMemberRows}} {
		if len(group.ids) == 0 {
			continue
		}
		list, err := s.readAssignments(ctx, userID, group.staff, now, group.where, group.ids, userID)
		if err != nil {
			return out, err
		}
		for _, a := range list {
			if isTodo(a) {
				c := cs.byID[a.WorkspaceID]
				c.Items = append(c.Items, a)
			}
		}
	}
	for _, id := range cs.order {
		c := cs.byID[id]
		if len(c.Items) == 0 {
			continue
		}
		sort.SliceStable(c.Items, func(i, j int) bool { return todoBefore(c.Items[i], c.Items[j]) })
		out.Workspaces = append(out.Workspaces, *c)
	}
	return out, nil
}

// todoClasses are the classes the caller owns or belongs to whose owner's
// account is open, split by whether the caller is staff there.
type todoClasses struct {
	byID           map[string]*TodoWorkspace
	order          []string
	staff, members []string
}

func (s *Store) todoClasses(ctx context.Context, userID string) (todoClasses, error) {
	out := todoClasses{byID: map[string]*TodoWorkspace{}}
	rows, err := s.pool.Query(ctx, `SELECT w.id, w.name, w.icon_id, w.user_id=$1 OR COALESCE(wm.role='editor', false)
		FROM workspaces w
		JOIN users owner ON owner.id=w.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$1
		WHERE w.kind='class'
			AND w.id IN (SELECT id FROM workspaces WHERE user_id=$1
				UNION ALL SELECT workspace_id FROM workspace_members WHERE user_id=$1)
			AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
			AND (owner.suspended_at IS NULL OR owner.id=$1)
		ORDER BY w.name, w.id`, userID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		c := TodoWorkspace{Items: []Assignment{}}
		if err := rows.Scan(&c.WorkspaceID, &c.Name, &c.IconID, &c.Manages); err != nil {
			return out, err
		}
		out.byID[c.WorkspaceID] = &c
		out.order = append(out.order, c.WorkspaceID)
		if c.Manages {
			out.staff = append(out.staff, c.WorkspaceID)
		} else {
			out.members = append(out.members, c.WorkspaceID)
		}
	}
	return out, rows.Err()
}

// TodoDoneParams page the To do page's Done tab: Sort is done (the day it was
// done, or closed if never done) or class (by name, then done); Classes and
// Kinds filter, empty keeping all.
type TodoDoneParams struct {
	Sort      string
	Ascending bool
	Classes   []string
	Kinds     []string
	Offset    int
	Limit     int
}

// TodoDonePage is one page of the Done tab: its rows grouped by class in the
// page's order, a class split across pages appearing in each.
type TodoDonePage struct {
	Workspaces []TodoWorkspace `json:"workspaces" nullable:"false"`
	// NextCursor reads the next page; empty when this is the last.
	NextCursor string `json:"nextCursor,omitempty"`
}

// ListTodoDone pages what was given to the caller that they finished or that
// closed, open or not (Epo 2026-11-08), sorted and filtered in SQL.
func (s *Store) ListTodoDone(ctx context.Context, userID string, now time.Time, p TodoDoneParams) (TodoDonePage, error) {
	out := TodoDonePage{Workspaces: []TodoWorkspace{}}
	cs, err := s.todoClasses(ctx, userID)
	if err != nil {
		return out, err
	}
	classes := cs.order
	if len(p.Classes) > 0 {
		classes = slices.DeleteFunc(slices.Clone(cs.order), func(id string) bool { return !slices.Contains(p.Classes, id) })
	}
	if len(classes) == 0 {
		return out, nil
	}
	var kinds []string
	if len(p.Kinds) > 0 {
		kinds = p.Kinds
	}
	dir, classDir := "DESC", "ASC"
	if p.Ascending {
		dir, classDir = "ASC", "DESC"
	}
	order := "f.at " + dir + ", a.id"
	if p.Sort == "class" {
		order = "lower(w.name) " + classDir + ", w.id " + classDir + ", f.at DESC, a.id"
	}
	// f.at is when it was finished: the counted submission or the tick, else
	// when it closed (assignmentClosedAt).
	rows, err := s.pool.Query(ctx, `SELECT a.id FROM assignments a
		JOIN workspaces w ON w.id=a.workspace_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=$1
		LEFT JOIN assignment_done d ON d.assignment_id=a.id AND d.user_id=$1
		LEFT JOIN LATERAL (SELECT t.submitted_at FROM attempts t
			WHERE t.assignment_id=a.id AND t.user_id=$1 AND t.submitted_at IS NOT NULL
			ORDER BY `+countedAttemptOrder+` LIMIT 1) l ON true
		CROSS JOIN LATERAL (SELECT COALESCE(l.submitted_at, d.done_at,
			LEAST(a.closed_at, CASE WHEN a.no_late AND a.due_at <= $3 THEN a.due_at END)) AS at) f
		WHERE a.workspace_id = ANY($2) AND NOT a.draft AND f.at IS NOT NULL
			AND ((a.assign_all AND wm.role='viewer') OR EXISTS (SELECT 1 FROM assignment_assignees aa WHERE aa.assignment_id=a.id AND aa.user_id=$1))
			AND ($4::text[] IS NULL OR a.kind = ANY($4))
		ORDER BY `+order+` LIMIT $5 OFFSET $6`, userID, classes, now, kinds, p.Limit+1, p.Offset)
	if err != nil {
		return out, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return out, err
	}
	if len(ids) > p.Limit {
		ids = ids[:p.Limit]
		out.NextCursor = strconv.Itoa(p.Offset + p.Limit)
	}
	if len(ids) == 0 {
		return out, nil
	}
	read := map[string]Assignment{}
	for _, staff := range []bool{true, false} {
		list, err := s.readAssignments(ctx, userID, staff, now, `a.id = ANY($1) AND a.workspace_id = ANY($2)`, ids, map[bool][]string{true: cs.staff, false: cs.members}[staff])
		if err != nil {
			return out, err
		}
		for _, a := range list {
			read[a.ID] = a
		}
	}
	at := map[string]int{}
	for _, id := range ids {
		a, ok := read[id]
		if !ok {
			continue
		}
		i, seen := at[a.WorkspaceID]
		if !seen {
			c := *cs.byID[a.WorkspaceID]
			c.Items = []Assignment{}
			out.Workspaces = append(out.Workspaces, c)
			i = len(out.Workspaces) - 1
			at[a.WorkspaceID] = i
		}
		out.Workspaces[i].Items = append(out.Workspaces[i].Items, a)
	}
	return out, nil
}

// isTodo: answers waiting for this staff member, or work given to the caller
// that is published and not closed.
func isTodo(a Assignment) bool {
	if a.Manage != nil && a.Manage.ToApprove > 0 {
		return true
	}
	return a.Mine != nil && !a.Draft && a.ClosedAt == nil
}

// todoBefore: the soonest due first, then those with no due date, newest first.
func todoBefore(a, b Assignment) bool {
	switch {
	case a.DueAt == nil && b.DueAt == nil:
		return a.PostedAt.After(b.PostedAt)
	case a.DueAt == nil:
		return false
	case b.DueAt == nil:
		return true
	}
	return a.DueAt.Before(*b.DueAt)
}

// TodoAudience is whose To do an assignment's change touches: everyone it is
// given to, and the class's staff (its owner and editor members).
func (s *Store) TodoAudience(ctx context.Context, id string) (members, staff []string, err error) {
	rows, err := s.pool.Query(ctx, `SELECT user_id, false FROM (`+assigneesSQL+`) e
		UNION SELECT w.user_id, true FROM assignments a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id = ANY($1)
		UNION SELECT wm.user_id, true FROM assignments a JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.role='editor' WHERE a.id = ANY($1)`, []string{id})
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var user string
		var isStaff bool
		if err := rows.Scan(&user, &isStaff); err != nil {
			return nil, nil, err
		}
		if isStaff {
			staff = append(staff, user)
		} else {
			members = append(members, user)
		}
	}
	return members, staff, rows.Err()
}
