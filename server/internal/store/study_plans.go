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
	// studyPlanStepCap bounds one plan's steps.
	studyPlanStepCap = 50
)

var (
	ErrStudyPlanCap  = errors.New("this workspace already has 10 plans")
	ErrStudyPlanStep = errors.New("a step is not in a workspace you can read, or is in the plan twice")
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
	Kind        string  `json:"kind" enum:"workspace,unfiled,chapter,file,material"`
	WorkspaceID string  `json:"workspaceId"`
	TargetID    *string `json:"targetId,omitempty" doc:"The chapter, file or material"`
	// Title is the chapter, file, material or workspace name; empty while
	// Locked (the user can no longer read the step's workspace).
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
	Kind        string  `json:"kind" enum:"workspace,unfiled,chapter,file,material"`
	WorkspaceID string  `json:"workspaceId"`
	TargetID    *string `json:"targetId,omitempty" doc:"The chapter, file or material; omitted for workspace and unfiled steps"`
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
	rows, err = s.pool.Query(ctx, `SELECT s.plan_id, s.kind, s.workspace_id, coalesce(s.chapter_id, s.file_id, s.material_id),
			coalesce(c.name, f.name, m.title, w.name)
		FROM study_plan_steps s JOIN workspaces w ON w.id=s.workspace_id
			LEFT JOIN chapters c ON c.id=s.chapter_id LEFT JOIN files f ON f.id=s.file_id
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
		if len(*steps) > studyPlanStepCap {
			return ErrStudyPlanStep
		}
		held := map[stepKey]bool{}
		rows, err := tx.Query(ctx, `SELECT kind, workspace_id, coalesce(chapter_id, file_id, material_id, '')
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
			k := stepKey{kind: st.Kind, ws: st.WorkspaceID}
			if st.TargetID != nil {
				k.target = *st.TargetID
			}
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
		if _, err := tx.Exec(ctx, `DELETE FROM study_plan_steps WHERE plan_id=$1`, planID); err != nil {
			return err
		}
		for i, st := range *steps {
			var chapter, file, material *string
			switch st.Kind {
			case "chapter":
				chapter = st.TargetID
			case "file":
				file = st.TargetID
			case "material":
				material = st.TargetID
			}
			if _, err := tx.Exec(ctx, `INSERT INTO study_plan_steps (plan_id, position, kind, workspace_id, chapter_id, file_id, material_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`, planID, i, st.Kind, st.WorkspaceID, chapter, file, material); err != nil {
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

func (s *Store) validPlanStep(ctx context.Context, tx pgx.Tx, userID string, st PlanStepInput) (bool, error) {
	if ok, err := s.canReadWorkspace(ctx, userID, st.WorkspaceID); err != nil || !ok {
		return false, err
	}
	var query string
	switch st.Kind {
	case "workspace", "unfiled":
		return st.TargetID == nil, nil
	case "chapter":
		query = `SELECT EXISTS (SELECT 1 FROM chapters WHERE id=$1 AND workspace_id=$2)`
	case "file":
		query = `SELECT EXISTS (SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`
	case "material":
		query = `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2
			AND trashed_at IS NULL AND parent_material_id IS NULL)`
	default:
		return false, nil
	}
	if st.TargetID == nil {
		return false, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, query, *st.TargetID, st.WorkspaceID).Scan(&ok)
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
