package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestStudyPlansAcrossWorkspaces(t *testing.T) {
	f := newStudyFixture(t, "u_study_plans")
	ctx := context.Background()
	done := "done"
	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Chemistry", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := f.s.AddChapter(ctx, other.ID, f.user, "Alkanes")
	if err != nil {
		t.Fatal(err)
	}
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Cells", Content: materialTestContent(t, "# Cells")})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &note.ID, &done); err != nil {
		t.Fatal(err)
	}

	// Two notes in the other workspace's chapter, one outside it.
	var inChapter []Material
	for _, title := range []string{"Methane", "Ethane"} {
		mt, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: other.ID, WorkspaceName: other.Name, Kind: "note", Title: title, ChapterID: &ch.ID, Content: materialTestContent(t, "# "+title)})
		if err != nil {
			t.Fatal(err)
		}
		inChapter = append(inChapter, mt)
	}

	plan, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "Winter exams")
	if err != nil {
		t.Fatal(err)
	}
	steps := []PlanStepInput{
		{Kind: "material", WorkspaceID: f.ws.ID, TargetID: note.ID},
		{Kind: "material", WorkspaceID: other.ID, TargetID: inChapter[0].ID},
		{Kind: "material", WorkspaceID: other.ID, TargetID: inChapter[1].ID},
	}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &steps); err != nil {
		t.Fatal(err)
	}

	// Parented here, and listed as "also in" from the steps' workspace.
	for _, ws := range []string{f.ws.ID, other.ID} {
		got, err := f.s.WorkspacePlans(ctx, f.user, ws)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Plans) != 1 || len(got.Plans[0].Steps) != 3 || len(got.Workspaces) != 2 {
			t.Fatalf("plans in %s = %+v", ws, got)
		}
		st := got.Plans[0].Steps
		if st[0].Title != "Cells" || st[1].Title != "Methane" || st[2].Title != "Ethane" {
			t.Fatalf("step titles = %+v", st)
		}
	}
	got, err := f.s.WorkspacePlans(ctx, f.user, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if items := got.Workspaces[0].Items; len(items) != 1 || items[0].State != "done" || items[0].Kind != "note" {
		t.Fatalf("parent's tracked items = %+v", items)
	}

	// A step twice, or in a workspace the user cannot read, is refused.
	stranger := newBlobTestUser(t, f.s, "u_study_plans_stranger")
	theirs, err := f.s.CreateWorkspace(ctx, stranger, WorkspaceCreate{Name: "Theirs", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	theirNote, err := f.s.CreateMaterial(ctx, Material{CreatedBy: stranger, WorkspaceID: theirs.ID, WorkspaceName: theirs.Name, Kind: "note", Title: "Secret", Content: materialTestContent(t, "# Secret")})
	if err != nil {
		t.Fatal(err)
	}
	theirStep := PlanStepInput{Kind: "material", WorkspaceID: theirs.ID, TargetID: theirNote.ID}
	for _, bad := range [][]PlanStepInput{{steps[0], steps[0]}, {theirStep}} {
		if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &bad); !errors.Is(err, ErrStudyPlanStep) {
			t.Fatalf("bad steps %+v: %v", bad, err)
		}
	}

	// Notes alternating between a chapter and Others make one group each:
	// 21 groups is refused.
	cells, err := f.s.AddChapter(ctx, f.ws.ID, f.user, "Cells")
	if err != nil {
		t.Fatal(err)
	}
	var alternating []PlanStepInput
	for i := 0; i < studyPlanGroupCap+1; i++ {
		mt := Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: fmt.Sprintf("Part %d", i), Content: materialTestContent(t, "# Part")}
		if i%2 == 0 {
			mt.ChapterID = &cells.ID
		}
		created, err := f.s.CreateMaterial(ctx, mt)
		if err != nil {
			t.Fatal(err)
		}
		alternating = append(alternating, PlanStepInput{Kind: "material", WorkspaceID: f.ws.ID, TargetID: created.ID})
	}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &alternating); !errors.Is(err, ErrStudyPlanSize) {
		t.Fatalf("21 groups: %v", err)
	}
	// An untracked note shows nowhere, so the notes around it make one group.
	removed := "removed"
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &alternating[1].TargetID, &removed); err != nil {
		t.Fatal(err)
	}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &alternating); err != nil {
		t.Fatalf("19 groups shown: %v", err)
	}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &steps); err != nil {
		t.Fatal(err)
	}

	// A step whose workspace became unreadable shows locked and survives a reorder.
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO study_plan_steps (plan_id, position, kind, workspace_id, material_id) VALUES ($1, 9, 'material', $2, $3)`, plan.ID, theirs.ID, theirNote.ID); err != nil {
		t.Fatal(err)
	}
	got, err = f.s.WorkspacePlans(ctx, f.user, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	locked := got.Plans[0].Steps[3]
	if !locked.Locked || locked.Title != "" {
		t.Fatalf("locked step = %+v", locked)
	}
	reordered := []PlanStepInput{theirStep, steps[0]}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &reordered); err != nil {
		t.Fatal(err)
	}

	// Ten plans per workspace; another user's plan is not found; delete.
	for i := 1; i < studyPlanCap; i++ {
		if _, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "More"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "One too many"); !errors.Is(err, ErrStudyPlanCap) {
		t.Fatalf("eleventh plan: %v", err)
	}
	if err := f.s.DeleteStudyPlan(ctx, stranger, plan.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger delete: %v", err)
	}
	if err := f.s.DeleteStudyPlan(ctx, f.user, plan.ID); err != nil {
		t.Fatal(err)
	}
	all, err := f.s.LearningPlans(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Plans) != studyPlanCap-1 {
		t.Fatalf("plans left = %d", len(all.Plans))
	}
}
