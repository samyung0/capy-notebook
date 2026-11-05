package store

import (
	"context"
	"sort"
	"time"
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
	var staff, members []string
	classes := map[string]*TodoWorkspace{}
	var order []string
	for rows.Next() {
		c := TodoWorkspace{Items: []Assignment{}}
		if err := rows.Scan(&c.WorkspaceID, &c.Name, &c.IconID, &c.Manages); err != nil {
			return out, err
		}
		classes[c.WorkspaceID] = &c
		order = append(order, c.WorkspaceID)
		if c.Manages {
			staff = append(staff, c.WorkspaceID)
		} else {
			members = append(members, c.WorkspaceID)
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows.Close()

	for _, group := range []struct {
		ids   []string
		staff bool
		where string
	}{{staff, true, todoStaffRows}, {members, false, todoMemberRows}} {
		if len(group.ids) == 0 {
			continue
		}
		list, err := s.readAssignments(ctx, userID, group.staff, now, group.where, group.ids, userID)
		if err != nil {
			return out, err
		}
		for _, a := range list {
			if isTodo(a) {
				c := classes[a.WorkspaceID]
				c.Items = append(c.Items, a)
			}
		}
	}
	for _, id := range order {
		c := classes[id]
		if len(c.Items) == 0 {
			continue
		}
		sort.SliceStable(c.Items, func(i, j int) bool { return todoBefore(c.Items[i], c.Items[j]) })
		out.Workspaces = append(out.Workspaces, *c)
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
