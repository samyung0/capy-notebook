package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/cover"
)

// Study plans: a user's private ordered steps from any workspace they can
// read, kept in a parent workspace. Progress is the one study_progress the
// workspace uses, so the browser counts each step from the workspaces' tracked
// items (the Learning map's shape) and puts them in reading order itself.

const (
	// studyPlanCap bounds one user's plans in one parent workspace.
	studyPlanCap = 10
	// studyPlanFileCap bounds one plan's steps, each one file or material.
	studyPlanFileCap = 200
	// studyPlanGroupCap bounds one plan's groups as the Study page shows
	// them (planGroups).
	studyPlanGroupCap = 20
)

var (
	ErrStudyPlanCap  = errors.New("this workspace already has 10 plans")
	ErrStudyPlanStep = errors.New("a step is not in a workspace you can read, or is in the plan twice")
	ErrStudyPlanSize = errors.New("a plan holds at most 20 chapter groups and 200 files")
)

type StudyPlans struct {
	Plans []StudyPlan `json:"plans" nullable:"false"`
	// Workspaces holds every readable workspace a step or parent names, with
	// its tracked items, once.
	Workspaces []PlanWorkspace `json:"workspaces" nullable:"false"`
}

type StudyPlan struct {
	ID string `json:"id"`
	// WorkspaceID is the parent workspace.
	WorkspaceID string     `json:"workspaceId"`
	Name        string     `json:"name"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	Steps       []PlanStep `json:"steps" nullable:"false"`
}

type PlanStep struct {
	Kind        string `json:"kind" enum:"file,material"`
	WorkspaceID string `json:"workspaceId"`
	TargetID    string `json:"targetId" doc:"The file or material"`
	// Title is the file's or material's name; empty while Locked (the user
	// can no longer read the step's workspace).
	Title  string `json:"title"`
	Locked bool   `json:"locked"`
}

type PlanWorkspace struct {
	WorkspaceID string       `json:"workspaceId"`
	Name        string       `json:"name"`
	IconID      string       `json:"iconId"`
	Cover       *cover.Cover `json:"cover,omitempty"`
	// Hidden is the user's Hide study progress in this workspace.
	Hidden   bool              `json:"hidden"`
	Chapters []ProgressChapter `json:"chapters" nullable:"false"`
	Items    []ProgressItem    `json:"items" nullable:"false"`
}

type PlanStepInput struct {
	Kind        string `json:"kind" enum:"file,material"`
	WorkspaceID string `json:"workspaceId"`
	TargetID    string `json:"targetId" minLength:"1" doc:"The file or material"`
}

// WorkspacePlans lists the plans parented in the workspace, then the user's
// plans elsewhere with a step in it.
func (s *Store) WorkspacePlans(ctx context.Context, userID, wsID string) (StudyPlans, error) {
	return s.studyPlans(ctx, userID, `SELECT id, workspace_id, name, created_at, updated_at FROM study_plans p
		WHERE user_id=$1 AND (workspace_id=$2 OR EXISTS (SELECT 1 FROM study_plan_steps s WHERE s.plan_id=p.id AND s.workspace_id=$2))
		ORDER BY workspace_id=$2 DESC, created_at, id`, userID, wsID)
}

// LearningPlans lists every plan of the user, newest first.
func (s *Store) LearningPlans(ctx context.Context, userID string) (StudyPlans, error) {
	return s.studyPlans(ctx, userID, `SELECT id, workspace_id, name, created_at, updated_at FROM study_plans
		WHERE user_id=$1 ORDER BY created_at DESC, id`, userID)
}

func (s *Store) studyPlans(ctx context.Context, userID, query string, args ...any) (StudyPlans, error) {
	out := StudyPlans{Plans: []StudyPlan{}, Workspaces: []PlanWorkspace{}}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return out, err
	}
	plans, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (StudyPlan, error) {
		p := StudyPlan{Steps: []PlanStep{}}
		return p, row.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.CreatedAt, &p.UpdatedAt)
	})
	if err != nil || len(plans) == 0 {
		return out, err
	}
	ids := make([]string, len(plans))
	for i, p := range plans {
		ids[i] = p.ID
	}
	rows, err = s.pool.Query(ctx, `SELECT s.plan_id, s.kind, s.workspace_id, coalesce(s.file_id, s.material_id),
			coalesce(f.name, m.title, '')
		FROM study_plan_steps s LEFT JOIN files f ON f.id=s.file_id
			LEFT JOIN materials m ON m.id=s.material_id
		WHERE s.plan_id = ANY($1) ORDER BY s.plan_id, s.position`, ids)
	if err != nil {
		return out, err
	}
	steps := map[string][]PlanStep{}
	for rows.Next() {
		var planID string
		var st PlanStep
		if err := rows.Scan(&planID, &st.Kind, &st.WorkspaceID, &st.TargetID, &st.Title); err != nil {
			rows.Close()
			return out, err
		}
		steps[planID] = append(steps[planID], st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	// Every workspace named once, readable or not.
	readable := map[string]bool{}
	var order []string
	check := func(wsID string) error {
		if _, seen := readable[wsID]; seen {
			return nil
		}
		ok, err := s.canReadWorkspace(ctx, userID, wsID)
		readable[wsID] = ok
		if ok {
			order = append(order, wsID)
		}
		return err
	}
	for _, p := range plans {
		if err := check(p.WorkspaceID); err != nil {
			return out, err
		}
		if !readable[p.WorkspaceID] {
			continue
		}
		for _, st := range steps[p.ID] {
			if err := check(st.WorkspaceID); err != nil {
				return out, err
			}
			if !readable[st.WorkspaceID] {
				st.Title, st.Locked = "", true
			}
			p.Steps = append(p.Steps, st)
		}
		out.Plans = append(out.Plans, p)
	}
	for _, wsID := range order {
		pw := PlanWorkspace{WorkspaceID: wsID}
		if err := s.pool.QueryRow(ctx, `SELECT name, icon_id, cover FROM workspaces WHERE id=$1`, wsID).
			Scan(&pw.Name, &pw.IconID, &pw.Cover); err != nil {
			return out, err
		}
		on, err := s.StudyEnabled(ctx, userID, wsID)
		if err != nil {
			return out, err
		}
		pw.Hidden = !on
		m, err := s.progressMap(ctx, userID, wsID)
		if err != nil {
			return out, err
		}
		pw.Chapters, pw.Items = m.Chapters, m.Items
		out.Workspaces = append(out.Workspaces, pw)
	}
	return out, nil
}

func (s *Store) canReadWorkspace(ctx context.Context, userID, wsID string) (bool, error) {
	_, err := s.WorkspaceEffectiveRole(ctx, userID, wsID)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
		return false, nil
	}
	return err == nil, err
}

// CreateStudyPlan adds an empty plan to the workspace.
func (s *Store) CreateStudyPlan(ctx context.Context, userID, wsID, name string) (StudyPlan, error) {
	p := StudyPlan{ID: uuid.NewString(), WorkspaceID: wsID, Name: name, Steps: []PlanStep{}}
	err := s.pool.QueryRow(ctx, `INSERT INTO study_plans (id, user_id, workspace_id, name)
		SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM study_plans WHERE user_id=$2 AND workspace_id=$3) < $5
		RETURNING created_at, updated_at`, p.ID, userID, wsID, name, studyPlanCap).Scan(&p.CreatedAt, &p.UpdatedAt)
	if isNoRows(err) {
		return p, ErrStudyPlanCap
	}
	return p, err
}

// UpdateStudyPlan renames the plan and/or replaces its steps in order. A new
// step must be in a workspace the user can read and point at something there;
// a step the plan already holds passes as it is, so a locked step survives
// a reorder.
func (s *Store) UpdateStudyPlan(ctx context.Context, userID, planID string, name *string, steps *[]PlanStepInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var parent string
	err = tx.QueryRow(ctx, `SELECT workspace_id FROM study_plans WHERE id=$1 AND user_id=$2 FOR UPDATE`, planID, userID).Scan(&parent)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if name != nil {
		if _, err := tx.Exec(ctx, `UPDATE study_plans SET name=$2 WHERE id=$1`, planID, *name); err != nil {
			return err
		}
	}
	if steps != nil {
		if len(*steps) > studyPlanFileCap {
			return ErrStudyPlanSize
		}
		held := map[stepKey]bool{}
		rows, err := tx.Query(ctx, `SELECT kind, workspace_id, coalesce(file_id, material_id)
			FROM study_plan_steps WHERE plan_id=$1`, planID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k stepKey
			if err := rows.Scan(&k.kind, &k.ws, &k.target); err != nil {
				rows.Close()
				return err
			}
			held[k] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		seen := map[stepKey]bool{}
		for _, st := range *steps {
			k := stepKey{kind: st.Kind, ws: st.WorkspaceID, target: st.TargetID}
			if seen[k] {
				return ErrStudyPlanStep
			}
			seen[k] = true
			if held[k] {
				continue
			}
			if ok, err := s.validPlanStep(ctx, tx, userID, st); err != nil || !ok {
				if err == nil {
					err = ErrStudyPlanStep
				}
				return err
			}
		}
		if groups, err := s.planGroups(ctx, tx, userID, *steps); err != nil {
			return err
		} else if groups > studyPlanGroupCap {
			return ErrStudyPlanSize
		}
		if _, err := tx.Exec(ctx, `DELETE FROM study_plan_steps WHERE plan_id=$1`, planID); err != nil {
			return err
		}
		for i, st := range *steps {
			var file, material *string
			if st.Kind == "file" {
				file = &st.TargetID
			} else {
				material = &st.TargetID
			}
			if _, err := tx.Exec(ctx, `INSERT INTO study_plan_steps (plan_id, position, kind, workspace_id, file_id, material_id)
				VALUES ($1,$2,$3,$4,$5,$6)`, planID, i, st.Kind, st.WorkspaceID, file, material); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE study_plans SET updated_at=now() WHERE id=$1`, planID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type stepKey struct{ kind, ws, target string }

// planGroups counts the groups the Study page shows: runs of consecutive steps
// in one chapter (or outside chapters) of one workspace. A step in a workspace
// the user can no longer read groups by workspace alone; a trashed or
// untracked step shows nowhere and joins the run around it.
func (s *Store) planGroups(ctx context.Context, tx pgx.Tx, userID string, steps []PlanStepInput) (int, error) {
	ids := make([]string, len(steps))
	for i, st := range steps {
		ids[i] = st.TargetID
	}
	rows, err := tx.Query(ctx, `SELECT f.id, coalesce(f.chapter_id, ''), f.trashed_at IS NULL AND NOT EXISTS (
			SELECT 1 FROM study_progress sp WHERE sp.user_id=$2 AND sp.file_id=f.id AND sp.state='removed')
		FROM files f WHERE f.id = ANY($1)
		UNION ALL SELECT m.id, coalesce(m.chapter_id, ''), m.trashed_at IS NULL AND NOT EXISTS (
			SELECT 1 FROM study_progress sp WHERE sp.user_id=$2 AND sp.material_id=m.id AND sp.state='removed')
		FROM materials m WHERE m.id = ANY($1)`, ids, userID)
	if err != nil {
		return 0, err
	}
	chapter := map[string]string{}
	for rows.Next() {
		var id, ch string
		var shown bool
		if err := rows.Scan(&id, &ch, &shown); err != nil {
			rows.Close()
			return 0, err
		}
		if shown {
			chapter[id] = ch
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	readable := map[string]bool{}
	groups := 0
	var last *[2]string
	for _, st := range steps {
		ok, seen := readable[st.WorkspaceID]
		if !seen {
			if ok, err = s.canReadWorkspace(ctx, userID, st.WorkspaceID); err != nil {
				return 0, err
			}
			readable[st.WorkspaceID] = ok
		}
		at := [2]string{st.WorkspaceID, "\x00locked"}
		if ok {
			ch, shown := chapter[st.TargetID]
			if !shown {
				continue
			}
			at[1] = ch
		}
		if last == nil || at != *last {
			groups++
		}
		last = &at
	}
	return groups, nil
}

func (s *Store) validPlanStep(ctx context.Context, tx pgx.Tx, userID string, st PlanStepInput) (bool, error) {
	if ok, err := s.canReadWorkspace(ctx, userID, st.WorkspaceID); err != nil || !ok {
		return false, err
	}
	var query string
	switch st.Kind {
	case "file":
		query = `SELECT EXISTS (SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`
	case "material":
		query = `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2
			AND trashed_at IS NULL AND parent_material_id IS NULL)`
	default:
		return false, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, query, st.TargetID, st.WorkspaceID).Scan(&ok)
	return ok, err
}

// DeleteStudyPlan removes one of the user's plans.
func (s *Store) DeleteStudyPlan(ctx context.Context, userID, planID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM study_plans WHERE id=$1 AND user_id=$2`, planID, userID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// PlanScope is what a plan's review draws from: its steps in the workspaces
// the user can still read. Parent is the plan's own workspace.
type PlanScope struct {
	ID     string
	Name   string
	Parent string
	// Steps are the readable workspaces' steps.
	Steps []PlanStepInput
}

// Workspaces are the readable workspaces the plan has steps in, in step order.
func (p PlanScope) Workspaces() []string {
	seen := map[string]bool{}
	var out []string
	for _, st := range p.Steps {
		if !seen[st.WorkspaceID] {
			seen[st.WorkspaceID] = true
			out = append(out, st.WorkspaceID)
		}
	}
	return out
}

// Has reports whether the plan holds a material in wsID as a step; file
// steps hold no review items.
func (p PlanScope) Has(wsID, materialID string) bool {
	for _, st := range p.Steps {
		if st.WorkspaceID == wsID && st.Kind == "material" && st.TargetID == materialID {
			return true
		}
	}
	return false
}

// materials are the plan's material steps in wsID, in its order.
func (p PlanScope) materials(wsID string) []string {
	var out []string
	for _, st := range p.Steps {
		if st.WorkspaceID == wsID && st.Kind == "material" {
			out = append(out, st.TargetID)
		}
	}
	return out
}

// PlanScopeOf reads one of the user's plans for its review; ErrNotFound when
// it is not theirs.
func (s *Store) PlanScopeOf(ctx context.Context, userID, planID string) (PlanScope, error) {
	out := PlanScope{ID: planID}
	err := s.pool.QueryRow(ctx, `SELECT name, workspace_id FROM study_plans WHERE id=$1 AND user_id=$2`, planID, userID).
		Scan(&out.Name, &out.Parent)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT kind, workspace_id, coalesce(file_id, material_id)
		FROM study_plan_steps WHERE plan_id=$1 ORDER BY position`, planID)
	if err != nil {
		return out, err
	}
	steps, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (PlanStepInput, error) {
		var st PlanStepInput
		return st, row.Scan(&st.Kind, &st.WorkspaceID, &st.TargetID)
	})
	if err != nil {
		return out, err
	}
	readable := map[string]bool{}
	for _, st := range steps {
		ok, seen := readable[st.WorkspaceID]
		if !seen {
			if ok, err = s.canReadWorkspace(ctx, userID, st.WorkspaceID); err != nil {
				return out, err
			}
			readable[st.WorkspaceID] = ok
		}
		if ok {
			out.Steps = append(out.Steps, st)
		}
	}
	return out, nil
}
