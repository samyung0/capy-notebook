package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// TestHiddenFromMembers: a quiz hidden from members is listed and opened by
// the workspace's owner and editor but not its viewer (nor in the viewer's
// lists across workspaces), the viewer cannot show it, and once an editor
// shows it the viewer lists it too.
func TestHiddenFromMembers(t *testing.T) {
	f := newStudyFixture(t, "hidden")
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, "hidden-editor")
	viewer := newBlobTestUser(t, f.s, "hidden-viewer")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer')`, f.ws.ID, editor, viewer); err != nil {
		t.Fatal(err)
	}
	quiz, err := f.s.CreateMaterialDraft(ctx, MaterialDraft{
		ActorUserID: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: MaterialQuiz, Title: "Paper 2", Hidden: true,
		Questions: json.RawMessage(`[{"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p1","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[1]},"marks":1,"solution":[]}]}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	listed := func(user string) bool {
		t.Helper()
		refs, err := f.s.ListMaterialRefs(ctx, user, f.ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(refs, func(r MaterialRef) bool { return r.ID == quiz.ID && r.Hidden })
	}
	for _, user := range []string{f.user, editor} {
		if !listed(user) {
			t.Fatalf("%s does not list the hidden quiz", user)
		}
		if _, err := f.s.MaterialEffectiveRole(ctx, user, quiz.ID); err != nil {
			t.Fatalf("%s cannot open the hidden quiz: %v", user, err)
		}
	}
	if listed(viewer) {
		t.Fatal("the viewer lists the hidden quiz")
	}
	// Nor do the lists of what the viewer can open across workspaces.
	page, err := f.s.ListOwnedMaterials(ctx, viewer, MaterialListFilter{Member: true, IDs: []string{quiz.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatal("the viewer's Recent lists the hidden quiz")
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, viewer, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the viewer opened the hidden quiz: %v", err)
	}
	if err := f.s.SetItemHidden(ctx, viewer, agenttools.KindMaterial, quiz.ID, false); err == nil {
		t.Fatal("the viewer showed the quiz")
	}
	if err := f.s.SetItemHidden(ctx, editor, agenttools.KindMaterial, quiz.ID, false); err != nil {
		t.Fatal(err)
	}
	refs, err := f.s.ListMaterialRefs(ctx, viewer, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(refs, func(r MaterialRef) bool { return r.ID == quiz.ID && !r.Hidden }) {
		t.Fatal("the viewer does not list the quiz once shown")
	}
}

// TestUploadsStartHiddenWhenAsked: an upload sent with "Hidden from members"
// (Epo 2026-11-04, V1) becomes a file that is hidden from its insert on: the
// owner opens it and the viewer never can. One sent without it is visible.
func TestUploadsStartHiddenWhenAsked(t *testing.T) {
	f := newStudyFixture(t, "upload-hidden")
	ctx := context.Background()
	viewer := newBlobTestUser(t, f.s, "upload-hidden-viewer")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'viewer')`, f.ws.ID, viewer); err != nil {
		t.Fatal(err)
	}
	upload := func(hidden bool) File {
		t.Helper()
		session, err := f.s.CreateUploadSession(ctx, NewUploadSession{
			ID: uid("up"), WorkspaceID: f.ws.ID, CreatedBy: f.user, Hidden: hidden,
			ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
			Name: "answers.zip", Kind: "unknown", ContentType: "application/zip",
			DeclaredSize: 300, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		file, err := f.s.FinalizeUploadSession(ctx, f.user, session.ID, "etag", "", "")
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	hidden, shown := upload(true), upload(false)
	if stored, err := f.s.GetFile(ctx, hidden.ID); err != nil || !stored.Hidden || !hidden.Hidden {
		t.Fatalf("stored = %+v (%v), want hidden", stored, err)
	}
	if _, err := f.s.FileEffectiveRole(ctx, f.user, hidden.ID); err != nil {
		t.Fatalf("the owner cannot open the hidden upload: %v", err)
	}
	if _, err := f.s.FileEffectiveRole(ctx, viewer, hidden.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the viewer opened the hidden upload: %v", err)
	}
	if _, err := f.s.FileEffectiveRole(ctx, viewer, shown.ID); err != nil {
		t.Fatalf("the viewer cannot open the visible upload: %v", err)
	}
}

// TestClonesKeepTheHiddenFlag: an editor's clone copies each item's hidden flag
// as it is, whole workspace or one item (Epo 2026-11-04). A viewer's clone leaves
// hidden items out and keeps the visible ones visible.
func TestClonesKeepTheHiddenFlag(t *testing.T) {
	f := newStudyFixture(t, "clone-hidden")
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, "clone-hidden-editor")
	viewer := newBlobTestUser(t, f.s, "clone-hidden-viewer")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer')`, f.ws.ID, editor, viewer); err != nil {
		t.Fatal(err)
	}
	quiz := func(title string, hidden bool) Material {
		t.Helper()
		made, err := f.s.CreateMaterialDraft(ctx, MaterialDraft{
			ActorUserID: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: MaterialQuiz, Title: title, Hidden: hidden,
			Questions: json.RawMessage(`[{"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p1","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[1]},"marks":1,"solution":[]}]}]`),
		})
		if err != nil {
			t.Fatal(err)
		}
		return made
	}
	upload := func(name string, hidden bool) File {
		t.Helper()
		session, err := f.s.CreateUploadSession(ctx, NewUploadSession{
			ID: uid("up"), WorkspaceID: f.ws.ID, CreatedBy: f.user, Hidden: hidden,
			ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
			Name: name, Kind: "unknown", ContentType: "application/zip",
			DeclaredSize: 300, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		file, err := f.s.FinalizeUploadSession(ctx, f.user, session.ID, "etag", "", "")
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	hiddenQuiz, shownQuiz := quiz("Hidden quiz", true), quiz("Shown quiz", false)
	hiddenFile, shownFile := upload("hidden.zip", true), upload("shown.zip", false)

	// What a clone holds: each item's name or title with its flag.
	flags := func(workspaceID string) map[string]bool {
		t.Helper()
		out := map[string]bool{}
		rows, err := f.s.pool.Query(ctx, `SELECT name, hidden FROM files WHERE workspace_id=$1
			UNION ALL SELECT title, hidden FROM materials WHERE workspace_id=$1`, workspaceID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var hidden bool
			if err := rows.Scan(&name, &hidden); err != nil {
				t.Fatal(err)
			}
			out[name] = hidden
		}
		return out
	}

	byEditor, err := f.s.CloneWorkspace(ctx, editor, f.ws.ID, WorkspaceCreate{Name: "Editor's copy"})
	if err != nil {
		t.Fatal(err)
	}
	got := flags(byEditor.ID)
	want := map[string]bool{"Hidden quiz": true, "Shown quiz": false, "hidden.zip": true, "shown.zip": false}
	for name, hidden := range want {
		if flag, ok := got[name]; !ok || flag != hidden {
			t.Fatalf("the editor's clone holds %v, want %s hidden=%v", got, name, hidden)
		}
	}

	byViewer, err := f.s.CloneWorkspace(ctx, viewer, f.ws.ID, WorkspaceCreate{Name: "Viewer's copy"})
	if err != nil {
		t.Fatal(err)
	}
	got = flags(byViewer.ID)
	if _, ok := got["Hidden quiz"]; ok {
		t.Fatalf("the viewer's clone holds the hidden quiz: %v", got)
	}
	if _, ok := got["hidden.zip"]; ok {
		t.Fatalf("the viewer's clone holds the hidden file: %v", got)
	}
	if flag, ok := got["Shown quiz"]; !ok || flag {
		t.Fatalf("the viewer's clone holds %v, want the shown quiz visible", got)
	}
	if flag, ok := got["shown.zip"]; !ok || flag {
		t.Fatalf("the viewer's clone holds %v, want the shown file visible", got)
	}

	// One item at a time, into the editor's own workspace.
	target := CloneTarget{WorkspaceID: byEditor.ID, Name: "One quiz"}
	oneQuiz, err := f.s.CloneMaterial(ctx, editor, hiddenQuiz.ID, target)
	if err != nil {
		t.Fatal(err)
	}
	target.Name = "One shown quiz"
	oneShown, err := f.s.CloneMaterial(ctx, editor, shownQuiz.ID, target)
	if err != nil {
		t.Fatal(err)
	}
	if !oneQuiz.Hidden || oneShown.Hidden {
		t.Fatalf("one item's clone: hidden %v, shown %v", oneQuiz.Hidden, oneShown.Hidden)
	}
	target.Name = "one.zip"
	oneFile, _, err := f.s.CloneFile(ctx, editor, hiddenFile.ID, target)
	if err != nil {
		t.Fatal(err)
	}
	target.Name = "one-shown.zip"
	oneShownFile, _, err := f.s.CloneFile(ctx, editor, shownFile.ID, target)
	if err != nil {
		t.Fatal(err)
	}
	if !oneFile.Hidden || oneShownFile.Hidden {
		t.Fatalf("one file's clone: hidden %v, shown %v", oneFile.Hidden, oneShownFile.Hidden)
	}
}
