package store

import (
	"bytes"
	"context"
	"encoding/json"
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
	scope, err := s.AccountScope(context.Background(), f.me)
	if err != nil {
		t.Fatal(err)
	}
	ids, editable := []string{}, map[string]bool{}
	for _, ws := range scope {
		ids, editable[ws.ID] = append(ids, ws.ID), ws.CanEdit
	}
	if !editable[f.owned] || !editable[f.edited] || editable[f.viewed] {
		t.Fatalf("scope edit rights = %v, want owned and edited only", editable)
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

	if rows[0].FileKind != "md" || rows[0].MaterialKind != "" {
		t.Fatalf("owned file access type = %+v", rows[0])
	}
	if rows, err := s.AccountDocumentAccess(ctx, f.me, items[4:5]); err != nil || rows[0].MaterialKind != "note" {
		t.Fatalf("standalone note access type = %+v, %v", rows, err)
	}

	listed := map[string]AccountDocument{}
	for _, place := range []AccountDocumentPlace{{WorkspaceID: f.owned}, {WorkspaceID: f.edited}, {WorkspaceID: f.viewed}, {}} {
		docs, err := s.AccountDocuments(ctx, f.me, place)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range docs {
			listed[d.ID] = d
		}
	}
	for _, ws := range []string{f.owned, f.edited, f.viewed, "standalone"} {
		if _, ok := listed[f.files[ws]]; !ok {
			t.Errorf("account listing misses the file of %s", ws)
		}
	}
	if d := listed[f.files[f.viewed]]; d.CanEdit || d.WorkspaceName != "Viewed" {
		t.Errorf("viewed file row = %+v", d)
	}
	if d := listed[standalone.ID]; d.Kind != agenttools.KindMaterial || d.WorkspaceID != "" || !d.CanEdit {
		t.Errorf("standalone note row = %+v", d)
	}

	// One workspace's items, or the newest with no workspace up to a limit.
	place := func(p AccountDocumentPlace) []string {
		t.Helper()
		docs, err := s.AccountDocuments(ctx, f.me, p)
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, d := range docs {
			ids = append(ids, d.ID)
		}
		return ids
	}
	if got := place(AccountDocumentPlace{WorkspaceID: f.viewed}); !slices.Equal(got, []string{f.files[f.viewed]}) {
		t.Errorf("viewed workspace listing = %v", got)
	}
	if got := place(AccountDocumentPlace{WorkspaceID: f.linkReached}); len(got) != 0 {
		t.Errorf("link-reached workspace listing = %v, want none", got)
	}
	if got := place(AccountDocumentPlace{}); !slices.Contains(got, f.files["standalone"]) ||
		!slices.Contains(got, standalone.ID) || slices.Contains(got, f.files[f.owned]) {
		t.Errorf("no-workspace listing = %v", got)
	}
	if got := place(AccountDocumentPlace{Limit: 1}); len(got) != 1 {
		t.Errorf("limited no-workspace listing = %v, want 1", got)
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

// A file the user's account chat edited, now out of their reach, reads as
// moved out (Q468's rule in account chat, Epo 2026-10-28); one it never
// edited stays a plain not found, so nothing confirms it exists elsewhere.
func TestAccountAccessSaysMovedOutOnlyForAFileItsChatEdited(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	conv, err := s.CreateConversation(ctx, f.me, "", "Across my files")
	if err != nil {
		t.Fatal(err)
	}
	edited, untouched := f.files[f.edited], f.files[f.viewed]
	if _, err := s.pool.Exec(ctx, `INSERT INTO agent_operations
		(id, kind, request_hash, actor_user_id, conversation_id, outcome, effect)
		VALUES ($1, 'edit_document', 'h', $2, $3, 'succeeded',
		        jsonb_build_object('resource', jsonb_build_object('kind', 'source_file', 'id', $4::text)))`,
		uid("op"), f.me, conv.ID, edited); err != nil {
		t.Fatal(err)
	}
	// Both workspaces leave the user's reach.
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE user_id=$1 AND workspace_id = ANY($2)`,
		f.me, []string{f.edited, f.viewed}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.AccountDocumentAccess(ctx, f.me, []agenttools.ResourceRef{
		{Kind: agenttools.KindSourceFile, ID: edited}, {Kind: agenttools.KindSourceFile, ID: untouched},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].CanRead || !rows[0].MovedOut {
		t.Fatalf("edited file = %+v, want moved out", rows[0])
	}
	if rows[1].CanRead || rows[1].MovedOut {
		t.Fatalf("untouched file = %+v, want a plain not found", rows[1])
	}
}

// Review r1 T1: a trashed file, a trashed note and an item embedded in a
// trashed note are unreadable, though their owner could read them before.
func TestAccountAccessRefusesTrashedItems(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	note := func(title string) string {
		m, err := s.CreateMaterial(ctx, Material{
			CreatedBy: f.me, WorkspaceID: f.owned, Kind: "note", Title: title, Content: materialTestContent(t, "# "+title+"\n\nbody"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return m.ID
	}
	trashed, parent, child := note("Trashed"), note("Parent"), note("Child")
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET kind='quiz', privacy='private', chapter_id=NULL, parent_material_id=$1 WHERE id=$2`, parent, child); err != nil {
		t.Fatal(err)
	}
	items := []agenttools.ResourceRef{
		{Kind: agenttools.KindSourceFile, ID: f.files[f.owned]},
		{Kind: agenttools.KindMaterial, ID: trashed},
		{Kind: agenttools.KindMaterial, ID: child},
	}
	readable := func() []bool {
		t.Helper()
		rows, err := s.AccountDocumentAccess(ctx, f.me, items)
		if err != nil {
			t.Fatal(err)
		}
		out := []bool{}
		for _, row := range rows {
			out = append(out, row.CanRead)
		}
		return out
	}
	if got := readable(); !slices.Equal(got, []bool{true, true, true}) {
		t.Fatalf("before the trash = %v", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET trashed_at=now(), trash_episode_id='ep_acct', purge_after=now()+interval '30 days' WHERE id=$1`, f.files[f.owned]); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id='ep_acct', purge_after=now()+interval '30 days' WHERE id = ANY($1)`, []string{trashed, parent}); err != nil {
		t.Fatal(err)
	}
	if got := readable(); !slices.Equal(got, []bool{false, false, false}) {
		t.Fatalf("after the trash = %v", got)
	}
}

// Review r1 T5: a member workspace whose owner is deletion-pending or deleted
// leaves the scope, as a suspended owner's does.
func TestAccountScopeDropsWorkspacesOfOwnersBeingDeleted(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	scoped := func() bool {
		t.Helper()
		scope, err := s.AccountScope(ctx, f.me)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(scope, func(ws ScopeWorkspace) bool { return ws.ID == f.edited })
	}
	if !scoped() {
		t.Fatal("the edited workspace is not in scope")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now()
		WHERE id=(SELECT user_id FROM workspaces WHERE id=$1)`, f.edited); err != nil {
		t.Fatal(err)
	}
	if scoped() {
		t.Fatal("a deletion-pending owner's workspace stays in scope")
	}
}

// Review r1 F4: account voice input names the caller's files with no
// workspace and in workspaces they still reach, not uploads in one they left.
func TestAccountVoiceContextSkipsWorkspacesTheUserLeft(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := newAccountScopeFixture(t, s)
	left := uid("f_acct")
	if _, err := s.pool.Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, created_by, name, kind, size_bytes, status)
		VALUES ($1,$2,$3,$3,'left behind.md','md',10,'ready')`, left, f.edited, f.me); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.edited, f.me); err != nil {
		t.Fatal(err)
	}
	_, names, err := s.VoiceContext(ctx, f.me, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(names, "mine.md") || slices.Contains(names, "left behind.md") {
		t.Fatalf("voice context = %v", names)
	}
}

// Q522: an account chat thread stays its owner's to open after they lose a
// workspace it drew on, every message with its citations and kept results;
// the cited file itself answers not found, so the chat opens no files. Nobody
// else reads the thread.
func TestAccountThreadStaysReadableAfterLosingAWorkspace(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	f := newAccountScopeFixture(t, s)
	conv, err := s.CreateConversation(ctx, f.me, "", "Across my files")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddUserMessage(ctx, f.me, conv.ID, "What do my notes say?", false); err != nil {
		t.Fatal(err)
	}
	cfg, err := reg.ResolveUser(ctx, flashModelRef, models.SlotChat)
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := s.StartAssistantMessage(ctx, f.me, conv.ID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	file, place := f.files[f.edited], f.edited
	cited := []Citation{{FileID: file, FileName: "notes.md", Snippet: "ATP", WorkspaceID: &place, WorkspaceName: "Edited"}}
	evidence := json.RawMessage(`{"tools":[{"name":"search_files_summary","text":"kept hits"}],"passages":[]}`)
	if err := s.FinalizeAssistantMessage(ctx, assistant.ID, "Your notes say ATP [1].", "complete", 1, cited, "", nil, evidence, ""); err != nil {
		t.Fatal(err)
	}
	var owner string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1`, f.edited).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveWorkspaceMember(ctx, owner, f.edited, f.me); err != nil {
		t.Fatal(err)
	}

	if _, err := s.FileEffectiveRole(ctx, f.me, file); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cited file after removal = %v, want not found", err)
	}
	if _, err := s.GetConversation(ctx, f.me, conv.ID); err != nil {
		t.Fatalf("owner get = %v", err)
	}
	if listed, err := s.ListConversations(ctx, f.me, "", false); err != nil || len(listed) != 1 || listed[0].ID != conv.ID {
		t.Fatalf("owner list = %+v, %v", listed, err)
	}
	msgs, err := s.ListMessages(ctx, f.me, conv.ID)
	if err != nil || len(msgs) != 2 || len(msgs[1].Citations) != 1 {
		t.Fatalf("owner messages = %+v, %v", msgs, err)
	}
	if c := msgs[1].Citations[0]; c.FileID != file || c.Snippet != "ATP" || c.WorkspaceName != "Edited" {
		t.Fatalf("citation = %+v", c)
	}
	prompt, err := s.ConversationPrompt(ctx, conv.ID)
	if err != nil || len(prompt.History) != 2 || !bytes.Contains(prompt.History[1].ToolEvidence, []byte("kept hits")) {
		t.Fatalf("kept results = %+v, %v", prompt, err)
	}
	if _, err := s.GetConversation(ctx, f.stranger, conv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger get = %v, want not found", err)
	}
	if _, err := s.ListMessages(ctx, f.stranger, conv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger messages = %v, want not found", err)
	}
}
