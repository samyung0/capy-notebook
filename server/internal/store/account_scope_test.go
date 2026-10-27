package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

// accountScopeFixture is one caller's reach (D2): a workspace they own, one
// they edit as a member, one they view as a member, one of a suspended owner
// they are a member of, and a link workspace they redeemed and visited.
type accountScopeFixture struct {
	me, stranger                                  string
	owned, edited, viewed, deadOwner, linkReached string
	files                                         map[string]string // workspace (or "standalone") → file id
}

func newAccountScopeFixture(t *testing.T, s *Store) accountScopeFixture {
	t.Helper()
	ctx := context.Background()
	f := accountScopeFixture{
		me: newBlobTestUser(t, s, "u_acct_me"), stranger: newBlobTestUser(t, s, "u_acct_stranger"),
		files: map[string]string{},
	}
	other, suspended := newBlobTestUser(t, s, "u_acct_other"), newBlobTestUser(t, s, "u_acct_suspended")
	workspace := func(owner, name string) string {
		ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: name, Tags: []TagRef{}})
		if err != nil {
			t.Fatal(err)
		}
		return ws.ID
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	f.owned = workspace(f.me, "Owned")
	f.edited = workspace(other, "Edited")
	f.viewed = workspace(other, "Viewed")
	f.deadOwner = workspace(suspended, "Suspended owner")
	f.linkReached = workspace(other, "Link reached")
	exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$4,'editor'), ($2,$4,'viewer'), ($3,$4,'editor')`,
		f.edited, f.viewed, f.deadOwner, f.me)
	exec(`UPDATE workspaces SET privacy='link', share_role='editor' WHERE id=$1`, f.linkReached)
	exec(`INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1,$2)`, f.linkReached, f.me)
	exec(`INSERT INTO workspace_visits (workspace_id, user_id) VALUES ($1,$2)`, f.linkReached, f.me)
	exec(`UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, suspended)
	for _, ws := range []string{f.owned, f.edited, f.viewed, f.deadOwner, f.linkReached} {
		id := uid("f_acct")
		exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
			VALUES ($1,$2,(SELECT user_id FROM workspaces WHERE id=$2),(SELECT user_id FROM workspaces WHERE id=$2),'notes.md','md',10,'ready')`, id, ws)
		f.files[ws] = id
	}
	id := uid("f_acct")
	exec(`INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
		VALUES ($1,NULL,$2,$2,'mine.md','md',10,'ready')`, id, f.me)
	f.files["standalone"] = id
	return f
}

func TestAccountScopeIsOwnedAndMemberWorkspacesOfLiveOwners(t *testing.T) {
	s := openMaterialTestStore(t)
	f := newAccountScopeFixture(t, s)
	ids, err := s.AccountScopeWorkspaces(context.Background(), f.me)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{f.owned, f.edited, f.viewed}
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Fatalf("scope = %v, want %v (no suspended owner's, no link-reached)", ids, want)
	}
}

func TestAccountDocumentAccess(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: f.me, Kind: "note", Title: "Standalone note", Content: materialTestContent(t, "# Mine\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	file := func(ws string) agenttools.ResourceRef {
		return agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: f.files[ws]}
	}
	items := []agenttools.ResourceRef{
		file(f.owned), file(f.viewed), file(f.edited), file("standalone"),
		{Kind: agenttools.KindMaterial, ID: standalone.ID}, file(f.linkReached), file(f.deadOwner),
	}
	type access struct{ read, edit bool }
	check := func(user string, want []access) {
		t.Helper()
		rows, err := s.AccountDocumentAccess(ctx, user, items)
		if err != nil {
			t.Fatal(err)
		}
		for i, row := range rows {
			if row.ID != items[i].ID || row.CanRead != want[i].read || row.CanEdit != want[i].edit {
				t.Errorf("%s item %d = %+v, want %+v", user, i, row, want[i])
			}
			if !row.CanRead && row.WorkspaceID != "" {
				t.Errorf("%s item %d names the workspace of an unreadable item", user, i)
			}
		}
	}
	check(f.me, []access{
		{true, true}, {true, false}, {true, true}, {true, true}, {true, true}, {false, false}, {false, false},
	})
	check(f.stranger, make([]access, len(items)))

	rows, err := s.AccountDocumentAccess(ctx, f.me, items[:1])
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].WorkspaceID != f.owned || rows[0].WorkspaceName != "Owned" {
		t.Fatalf("owned file access = %+v, want its workspace", rows[0])
	}

	docs, err := s.AccountDocuments(ctx, f.me)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]AccountDocument{}
	for _, d := range docs {
		listed[d.ID] = d
	}
	for _, ws := range []string{f.owned, f.edited, f.viewed, "standalone"} {
		if _, ok := listed[f.files[ws]]; !ok {
			t.Errorf("account listing misses the file of %s", ws)
		}
	}
	for _, ws := range []string{f.linkReached, f.deadOwner} {
		if _, ok := listed[f.files[ws]]; ok {
			t.Errorf("account listing shows the file of %s", ws)
		}
	}
	if d := listed[f.files[f.viewed]]; d.CanEdit || d.WorkspaceName != "Viewed" {
		t.Errorf("viewed file row = %+v", d)
	}
	if d := listed[standalone.ID]; d.Kind != agenttools.KindMaterial || d.WorkspaceID != "" || !d.CanEdit {
		t.Errorf("standalone note row = %+v", d)
	}
}

// An account conversation is its owner's alone, and stays out of workspace
// lists (and they out of its list).
func TestAccountConversationsAreTheOwnersAlone(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	conv, err := s.CreateConversation(ctx, f.me, "", "Across my files")
	if err != nil {
		t.Fatal(err)
	}
	inWorkspace, err := s.CreateConversation(ctx, f.me, f.owned, "In a workspace")
	if err != nil {
		t.Fatal(err)
	}
	if conv.WorkspaceID != "" {
		t.Fatalf("account conversation workspace = %q", conv.WorkspaceID)
	}
	mine, err := s.ListConversations(ctx, f.me, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 1 || mine[0].ID != conv.ID {
		t.Fatalf("account list = %+v, want only the account conversation", mine)
	}
	workspaceList, err := s.ListConversations(ctx, f.me, f.owned, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaceList) != 1 || workspaceList[0].ID != inWorkspace.ID {
		t.Fatalf("workspace list = %+v", workspaceList)
	}
	if theirs, err := s.ListConversations(ctx, f.stranger, "", false); err != nil || len(theirs) != 0 {
		t.Fatalf("stranger's account list = %+v, %v", theirs, err)
	}
	if _, err := s.GetConversation(ctx, f.me, conv.ID); err != nil {
		t.Fatal(err)
	}
	title := "Renamed"
	if _, err := s.UpdateConversation(ctx, f.me, conv.ID, ConversationUpdate{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddUserMessage(ctx, f.me, conv.ID, "hello", false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, f.stranger, conv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger get = %v, want not found", err)
	}
	if _, err := s.UpdateConversation(ctx, f.stranger, conv.ID, ConversationUpdate{Title: &title}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger update = %v, want not found", err)
	}
	if err := s.DeleteConversation(ctx, f.stranger, conv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger delete = %v, want not found", err)
	}
	if err := s.DeleteConversation(ctx, f.me, conv.ID); err != nil {
		t.Fatal(err)
	}
}

// What an account chat makes with no workspace lands standalone, its maker's
// alone, and is ingested like an upload (Epo 2026-10-27).
func TestAgentFileWithNoWorkspaceIsStandalone(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	me := newBlobTestUser(t, s, "u_acct_file")
	f, jobID, err := s.createSourceWithJob(ctx, "", me, "notes.md", "md", nil, "", 1, "sources/"+uid("blob"), "", "none")
	if err != nil {
		t.Fatal(err)
	}
	var workspaceID *string
	var payer string
	if err := s.pool.QueryRow(ctx, `SELECT workspace_id, user_id FROM files WHERE id=$1`, f.ID).Scan(&workspaceID, &payer); err != nil {
		t.Fatal(err)
	}
	if workspaceID != nil || payer != me || jobID == "" {
		t.Fatalf("file workspace=%v payer=%s job=%q, want standalone, the maker's, ingested", workspaceID, payer, jobID)
	}
	if role, err := s.FileEffectiveRole(ctx, me, f.ID); err != nil || role != RoleOwner {
		t.Fatalf("maker role = %q, %v", role, err)
	}
}
