package store

import (
	"context"
	"testing"
)

func TestLearningProgressListsByLastStudied(t *testing.T) {
	f := newStudyFixture(t, "u_learning_progress")
	ctx := context.Background()
	done, removed := "done", "removed"
	newWorkspace := func(name string) Workspace {
		t.Helper()
		ws, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: name, Tags: []TagRef{}})
		if err != nil {
			t.Fatal(err)
		}
		return ws
	}
	note := func(ws Workspace, title string) Material {
		t.Helper()
		mt, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: title, Content: "# " + title})
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	mark := func(ws Workspace, mt Material, state *string, ago string) {
		t.Helper()
		if err := f.s.SetStudyItem(ctx, f.user, ws.ID, nil, &mt.ID, state); err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.pool.Exec(ctx, `UPDATE study_progress SET updated_at=now()-$3::interval WHERE user_id=$1 AND material_id=$2`, f.user, mt.ID, ago); err != nil {
			t.Fatal(err)
		}
	}

	// The fixture's workspace: one of two notes read, two days ago.
	older := note(f.ws, "Older read")
	note(f.ws, "Older unread")
	mark(f.ws, older, &done, "2 days")
	// Finished: its only note read, a week ago.
	finishedWS := newWorkspace("Finished")
	mark(finishedWS, note(finishedWS, "All read"), &done, "7 days")
	// Studied last: one note read, one untracked (left out of the map), one untouched.
	latest := newWorkspace("Latest")
	read := note(latest, "Read")
	dropped := note(latest, "Dropped")
	untouched := note(latest, "Untouched")
	mark(latest, read, &done, "1 hour")
	mark(latest, dropped, &removed, "1 hour")

	got, err := f.s.LearningProgress(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Active) != 2 || got.Active[0].WorkspaceID != latest.ID || got.Active[1].WorkspaceID != f.ws.ID {
		t.Fatalf("active = %+v", got.Active)
	}
	if got.Active[0].Done != 1 || got.Active[0].Total != 2 {
		t.Fatalf("latest counts = %+v", got.Active[0])
	}
	if len(got.Finished) != 1 || got.Finished[0].WorkspaceID != finishedWS.ID {
		t.Fatalf("finished = %+v", got.Finished)
	}
	if got.Lead == nil || got.Lead.WorkspaceID != latest.ID || len(got.Lead.Items) != 2 {
		t.Fatalf("lead = %+v", got.Lead)
	}
	states := map[string]string{}
	for _, it := range got.Lead.Items {
		states[it.ID] = it.State
	}
	if states[read.ID] != "done" || states[untouched.ID] != "" {
		t.Fatalf("lead states = %v", states)
	}

	// Progress off leaves a workspace out.
	if err := f.s.SetWorkspaceStudy(ctx, f.user, latest.ID, false); err != nil {
		t.Fatal(err)
	}
	got, err = f.s.LearningProgress(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Active) != 1 || got.Lead == nil || got.Lead.WorkspaceID != f.ws.ID {
		t.Fatalf("after progress off = %+v", got)
	}
}
