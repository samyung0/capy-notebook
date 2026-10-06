package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// pushOverQuota puts a user into over_quota_grace the way production does: a
// paid period that has ended, plus stored bytes above the free limit.
func pushOverQuota(t *testing.T, s *Store, userID, workspaceID string) {
	t.Helper()
	ctx := context.Background()
	subID := uid("sub")
	now := time.Now().Unix()
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subID, now-1)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, workspaceID, userID, "big.pdf", "pdf", nil, "",
		mustPlanLimits(t, s, PlanFree).StorageBytes+1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	lapsed := time.Now().Add(-2 * 24 * time.Hour).UTC()
	ended := proSubscription(userID, subID, now)
	ended.Status = "canceled"
	ended.CurrentPeriodEnd = &lapsed
	if err := s.UpsertSubscription(ctx, ended); err != nil {
		t.Fatal(err)
	}
}

// pushFrozen is pushOverQuota past the grace window.
func pushFrozen(t *testing.T, s *Store, userID, workspaceID string) {
	t.Helper()
	pushOverQuota(t, s, userID, workspaceID)
	if _, err := s.pool.Exec(context.Background(), `UPDATE user_subscriptions
		SET current_period_end=now()-interval '20 days' WHERE user_id=$1`, userID); err != nil {
		t.Fatal(err)
	}
}

func wantOverQuotaLock(t *testing.T, what string, err error) {
	t.Helper()
	var locked *AccountLockedError
	if !errors.As(err, &locked) || locked.State != AccountOverQuotaFrozen {
		t.Fatalf("%s = %v, want the frozen account lock", what, err)
	}
}

// Frozen is read-only in both directions: the frozen user edits nowhere, and
// every role is read-only in a workspace the frozen account pays for. Deleting
// and workspace chat stay open.
func TestFrozenIsReadOnlyBothWays(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"hi"}]}]`)

	frozenUser := newBlobTestUser(t, s, "frozen_user")
	healthyUser := newBlobTestUser(t, s, "healthy_user")
	frozenWS, err := s.CreateWorkspace(ctx, frozenUser, WorkspaceCreate{Name: "Frozen", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	healthyWS, err := s.CreateWorkspace(ctx, healthyUser, WorkspaceCreate{Name: "Healthy", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, healthyWS.ID, frozenUser)
	addWorkspaceEditor(t, s, frozenWS.ID, healthyUser)
	material := func(ws Workspace, author string) Material {
		mt, err := s.CreateMaterial(ctx, Material{
			CreatedBy: author, WorkspaceID: ws.ID, Kind: "note", Title: "Note " + uid("t"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	inFrozen, inHealthy := material(frozenWS, healthyUser), material(healthyWS, frozenUser)
	trashable := material(frozenWS, healthyUser)
	discussion, err := s.CreateCommentDiscussion(ctx, inFrozen.ID, healthyUser, nil, nil, nil, 1, "", rich)
	if err != nil {
		t.Fatal(err)
	}

	pushFrozen(t, s, frozenUser, frozenWS.ID)

	for _, c := range []struct {
		name string
		ws   Workspace
		mt   Material
		who  string
	}{
		{"frozen actor in a healthy workspace", healthyWS, inHealthy, frozenUser},
		{"healthy member in a frozen owner's workspace", frozenWS, inFrozen, healthyUser},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.AddChapter(ctx, c.ws.ID, c.who, "Blocked")
			wantOverQuotaLock(t, "chapter", err)
			title := "Renamed"
			_, err = s.UpdateMaterial(ctx, c.mt.ID, MaterialPatch{Title: &title, UpdatedBy: c.who})
			wantOverQuotaLock(t, "rename", err)
			_, err = s.CreateCommentDiscussion(ctx, c.mt.ID, c.who, nil, nil, nil, 1, "", rich)
			wantOverQuotaLock(t, "comment", err)
			if _, err := s.CreateConversation(ctx, c.who, c.ws.ID, "Chat"); err != nil {
				t.Fatalf("workspace chat is open to frozen accounts: %v", err)
			}
		})
	}

	_, err = s.AddComment(ctx, discussion.ID, healthyUser, rich)
	wantOverQuotaLock(t, "reply", err)
	if err := s.SoftDeleteDiscussion(ctx, discussion.ID, healthyUser); err != nil {
		t.Fatalf("deleting a comment stays open: %v", err)
	}
	if _, err := s.TrashMaterial(ctx, healthyUser, trashable.ID, "", AgentOperation{}); err != nil {
		t.Fatalf("deleting stays open in a frozen owner's workspace: %v", err)
	}
	if _, err := s.TrashMaterial(ctx, frozenUser, inHealthy.ID, "", AgentOperation{}); err != nil {
		t.Fatalf("a frozen actor keeps deleting: %v", err)
	}
	if _, err := s.CreateWorkspace(ctx, frozenUser, WorkspaceCreate{Name: "New", Tags: []TagRef{}}); err == nil {
		t.Fatal("a frozen account created a workspace")
	}
}

// Grace blocks only storage growth, exactly like an active account at its
// hard quota: the create fails the quota check, sharing and invites work.
func TestGraceBlocksOnlyStorageGrowth(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "grace_owner")
	viewerID := newBlobTestUser(t, s, "grace_viewer")
	inviteeID := newBlobTestUser(t, s, "grace_invitee")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Grace", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id,user_id,role) VALUES ($1,$2,'viewer')`, ws.ID, viewerID); err != nil {
		t.Fatal(err)
	}
	pushOverQuota(t, s, ownerID, ws.ID)
	status, err := s.AccountAccess(ctx, ownerID)
	if err != nil || status.State != AccountOverQuotaGrace || status.PlanTier != PlanFree {
		t.Fatalf("setup = %#v, %v; want grace on Free limits", status, err)
	}

	var quota *QuotaExceededError
	if _, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, Kind: "note", Title: "Growth",
	}); !errors.As(err, &quota) || quota.LimitBytes != mustPlanLimits(t, s, PlanFree).StorageBytes {
		t.Fatalf("grace growth = %v, want the Free hard quota", err)
	}
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, inviteeID, RoleViewer, ownerID); err != nil {
		t.Fatalf("grace invite: %v", err)
	}
	if err := s.SetWorkspaceMemberRole(ctx, ownerID, ws.ID, viewerID, RoleEditor); err != nil {
		t.Fatalf("grace promotion: %v", err)
	}
	public, editor := PrivacyPublic, ShareEditor
	if _, err := s.UpdateWorkspaceSharing(ctx, ownerID, ws.ID, &public, &editor); err != nil {
		t.Fatalf("grace widening: %v", err)
	}
	if _, err := s.AddChapter(ctx, ws.ID, viewerID, "Size neutral"); err != nil {
		t.Fatalf("grace edit: %v", err)
	}
}

// At or over its storage limit (full, and grace, which is over the Free limit)
// everything the owner pays for is view-only for owner and member alike:
// content, comments, PDF marks and source edits are refused with the storage
// code, while renaming, moving between chapters and trashing go on.
func TestViewOnlyAtTheStorageLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"hi"}]}]`)
	mark := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "rectangle", Color: "#d94848", Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}}
	for name, reach := range map[string]func(owner, ws string){
		"full": func(owner, _ string) {
			if _, err := s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
				ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
				owner, mustPlanLimits(t, s, PlanFree).StorageBytes); err != nil {
				t.Fatal(err)
			}
		},
		"grace": func(owner, ws string) { pushOverQuota(t, s, owner, ws) },
	} {
		t.Run(name, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "limit_owner")
			member := newBlobTestUser(t, s, "limit_member")
			ws, pdf := sourceTestFile(t, s, owner, "marks.pdf", "pdf")
			text, err := s.CreateSourceReady(ctx, ws.ID, owner, "notes.txt", "txt", nil, "", 100, "sources/"+uid("base"))
			if err != nil {
				t.Fatal(err)
			}
			addWorkspaceEditor(t, s, ws.ID, member)
			chapter, err := s.AddChapter(ctx, ws.ID, owner, "Chapter")
			if err != nil {
				t.Fatal(err)
			}
			note, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, Kind: "note", Title: "Note"})
			if err != nil {
				t.Fatal(err)
			}
			set, err := s.CreateFlashcardSetWithCards(ctx, owner, "Cards", "blue", ws.ID, [][2]string{{"a", "b"}}, "", nil, nil)
			if err != nil {
				t.Fatal(err)
			}

			reach(owner, ws.ID)

			for _, who := range []string{owner, member} {
				var quota *QuotaExceededError
				want := func(what string, err error) {
					t.Helper()
					if !errors.As(err, &quota) || quota.UserID != owner {
						t.Fatalf("%s by %s = %v, want the owner's storage limit", what, who, err)
					}
				}
				_, err := s.UpdateFlashcardContent(ctx, who, set.ID, set.Revision, []materialdoc.Card{{Front: "c", Back: "d"}})
				want("card edit", err)
				_, err = s.CreateCommentDiscussion(ctx, note.ID, who, nil, nil, nil, 1, "", rich)
				want("comment", err)
				_, err = s.SavePDFAnnotation(ctx, who, pdf.ID, "", mark)
				want("PDF mark", err)
				session, err := s.SourceSession(ctx, who, text.ID)
				if err != nil || session.Access != "read" {
					t.Fatalf("%s source session = %q %v, want read", who, session.Access, err)
				}
				want("source edit", s.CheckSourceAccess(ctx, who, text.ID, session.Epoch, true))
				title := "Renamed by " + who
				if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Title: &title, UpdatedBy: who}); err != nil {
					t.Fatalf("rename by %s: %v", who, err)
				}
			}
			into := &chapter.ID
			if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{ChapterID: &into, UpdatedBy: member}); err != nil {
				t.Fatalf("moving between chapters: %v", err)
			}
			if _, err := s.TrashMaterial(ctx, member, note.ID, "", AgentOperation{}); err != nil {
				t.Fatalf("trashing: %v", err)
			}
		})
	}
}

func TestStorageUsageLevels(t *testing.T) {
	for _, c := range []struct {
		used int64
		want StorageUsageLevel
	}{
		{0, StorageUsageOK},
		{94_999_999, StorageUsageOK},
		{95_000_000, StorageUsageNearLimit},
		{99_999_999, StorageUsageNearLimit},
		{100_000_000, StorageUsageFull},
		{100_000_001, StorageUsageFull},
	} {
		if got := StorageUsageLevelFor(c.used, 100_000_000); got != c.want {
			t.Errorf("level(%d) = %s, want %s", c.used, got, c.want)
		}
	}
}

// The collaboration service decides read-only rooms with its own SQL
// (collaboration/src/persistence.ts frozenSQL and fullSQL). Run it verbatim
// against the accounts Go resolves, so the two cannot drift apart.
func TestCollaborationFrozenSQLMatchesGo(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	raw, err := os.ReadFile("../../../collaboration/src/persistence.ts")
	if err != nil {
		t.Fatal(err)
	}
	sqlOf := func(name string) string {
		match := regexp.MustCompile("(?s)function " + name + "\\(userAlias: string, storageAlias: string\\): string \\{\\s*return `(.*?)`;").FindSubmatch(raw)
		if match == nil {
			t.Fatalf("%s not found in persistence.ts", name)
		}
		return strings.NewReplacer("${userAlias}", "u", "${storageAlias}", "st").Replace(string(match[1]))
	}
	query := `SELECT ` + sqlOf("frozenSQL") + `, ` + sqlOf("fullSQL") + ` FROM users u LEFT JOIN user_storage st ON st.user_id=u.id WHERE u.id=$1`

	cases := map[string]func(user, ws string){
		"active": func(string, string) {},
		"active at the limit": func(user, _ string) {
			if _, err := s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
				ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
				user, mustPlanLimits(t, s, PlanFree).StorageBytes); err != nil {
				t.Fatal(err)
			}
		},
		"grace":  func(user, ws string) { pushOverQuota(t, s, user, ws) },
		"frozen": func(user, ws string) { pushFrozen(t, s, user, ws) },
		"frozen by a closed subscription": func(user, ws string) {
			pushFrozen(t, s, user, ws)
			if _, err := s.pool.Exec(ctx, `UPDATE user_subscriptions
				SET current_period_end=NULL, ended_at=now()-interval '20 days' WHERE user_id=$1`, user); err != nil {
				t.Fatal(err)
			}
		},
		"lapsed but under the limit": func(user, ws string) {
			pushFrozen(t, s, user, ws)
			if _, err := s.pool.Exec(ctx, `DELETE FROM files WHERE workspace_id=$1`, ws); err != nil {
				t.Fatal(err)
			}
		},
		"live pro again": func(user, ws string) {
			pushFrozen(t, s, user, ws)
			live := time.Now().Add(20 * 24 * time.Hour).UTC()
			sub := proSubscription(user, uid("sub"), time.Now().Unix())
			sub.CurrentPeriodEnd = &live
			if err := s.UpsertSubscription(ctx, sub); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			user := newBlobTestUser(t, s, "frozen_sql")
			ws, err := s.CreateWorkspace(ctx, user, WorkspaceCreate{Name: "Frozen SQL", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			setup(user, ws.ID)
			status, err := s.AccountAccess(ctx, user)
			if err != nil {
				t.Fatal(err)
			}
			usage, err := s.StorageUsage(ctx, user)
			if err != nil {
				t.Fatal(err)
			}
			var sqlFrozen, sqlFull bool
			if err := s.pool.QueryRow(ctx, query, user).Scan(&sqlFrozen, &sqlFull); err != nil {
				t.Fatal(err)
			}
			if sqlFrozen != (status.State == AccountOverQuotaFrozen) || sqlFull != usage.Full() {
				t.Fatalf("collaboration frozen = %v full = %v, Go state = %s full = %v",
					sqlFrozen, sqlFull, status.State, usage.Full())
			}
		})
	}
}

// The edges of the frozen whitelist: narrowing a standalone material,
// trashing a whole set and transferring a workspace stay open; accepting an
// invite, recording study progress, deleting one flashcard, saving or deleting
// PDF marks and source edits are refused, while checkpoints of source edits
// the room admitted before the freeze are saved.
func TestFrozenEdges(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	frozenUser := newBlobTestUser(t, s, "frozen_edges")
	member := newBlobTestUser(t, s, "frozen_edges_member")
	inviter := newBlobTestUser(t, s, "frozen_edges_inviter")

	ws, pdf := sourceTestFile(t, s, frozenUser, "marks.pdf", "pdf")
	textWS, text := sourceTestFile(t, s, frozenUser, "notes.txt", "txt")
	addWorkspaceEditor(t, s, textWS.ID, member)
	mark := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "rectangle", Color: "#d94848", Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}}
	saved, err := s.SavePDFAnnotation(ctx, frozenUser, pdf.ID, "", mark)
	if err != nil {
		t.Fatal(err)
	}
	standalone, err := s.CreateMaterial(ctx, Material{CreatedBy: frozenUser, Kind: "note", Title: "Shared note", Privacy: PrivacyLink})
	if err != nil {
		t.Fatal(err)
	}
	set, err := s.CreateFlashcardSetWithCards(ctx, frozenUser, "Cards", "blue", "", [][2]string{{"a", "b"}, {"c", "d"}}, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	cards, err := s.ListCards(ctx, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	inviterWS, err := s.CreateWorkspace(ctx, inviter, WorkspaceCreate{Name: "Invite", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(ctx, inviterWS.ID, frozenUser, RoleViewer, inviter); err != nil {
		t.Fatal(err)
	}
	var inviteID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM workspace_invites
		WHERE workspace_id=$1 AND invited_user_id=$2`, inviterWS.ID, frozenUser).Scan(&inviteID); err != nil {
		t.Fatal(err)
	}

	pushFrozen(t, s, frozenUser, ws.ID)

	private, public := PrivacyPrivate, PrivacyPublic
	_, err = s.UpdateStandaloneMaterialPrivacy(ctx, frozenUser, standalone.ID, "", public)
	wantOverQuotaLock(t, "standalone widening", err)
	title := "Renamed"
	_, err = s.UpdateMaterial(ctx, standalone.ID, MaterialPatch{Title: &title, UpdatedBy: frozenUser})
	wantOverQuotaLock(t, "standalone rename", err)
	if _, err := s.UpdateStandaloneMaterialPrivacy(ctx, frozenUser, standalone.ID, "", private); err != nil {
		t.Fatalf("standalone narrowing: %v", err)
	}

	// Study progress is the user's own data and charges no storage.
	good := 3
	if err := s.RateItem(ctx, frozenUser, Rating{MaterialID: set.ID, ItemID: cards[0].ID, Rating: &good}, time.Now()); err != nil {
		t.Fatalf("frozen study progress: %v", err)
	}
	_, err = s.UpdateFlashcardContent(ctx, frozenUser, set.ID, cards[0].Revision, nil)
	wantOverQuotaLock(t, "removing every flashcard", err)
	if _, err := s.TrashMaterial(ctx, frozenUser, set.ID, "", AgentOperation{}); err != nil {
		t.Fatalf("trashing the whole set: %v", err)
	}

	_, err = s.SavePDFAnnotation(ctx, frozenUser, pdf.ID, "", mark)
	wantOverQuotaLock(t, "PDF mark", err)
	wantOverQuotaLock(t, "deleting a PDF mark", s.DeletePDFAnnotation(ctx, frozenUser, pdf.ID, saved.ID))

	for _, actor := range []string{frozenUser, member} {
		session, err := s.SourceSession(ctx, actor, text.ID)
		if err != nil {
			t.Fatal(err)
		}
		if session.Access != "read" {
			t.Fatalf("%s source session access = %q, want read", actor, session.Access)
		}
		wantOverQuotaLock(t, "source edit", s.CheckSourceAccess(ctx, actor, text.ID, session.Epoch, true))
		if err := s.CheckSourceAccess(ctx, actor, text.ID, session.Epoch, false); err != nil {
			t.Fatalf("%s source read: %v", actor, err)
		}
	}
	// A checkpoint saves edits the room admitted before the frozen editor's
	// freeze (frozen is enforced at admission only) in a healthy owner's room.
	healthyWS, healthyText := sourceTestFile(t, s, inviter, "healthy.txt", "txt")
	addWorkspaceEditor(t, s, healthyWS.ID, frozenUser)
	session, err := s.SourceSession(ctx, inviter, healthyText.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveSourceCheckpoint(ctx, healthyText.ID, sourceTestSave(session, frozenUser, "admitted")); err != nil {
		t.Fatalf("checkpoint of edits admitted before the freeze: %v", err)
	}

	_, err = s.AcceptWorkspaceInvite(ctx, inviteID, frozenUser)
	wantOverQuotaLock(t, "invite acceptance", err)

	if _, err := s.TransferWorkspace(ctx, frozenUser, textWS.ID, member); err != nil {
		t.Fatalf("a frozen owner transfers a workspace away: %v", err)
	}
}

// The level counts reserved bytes and unfolded material deltas, the numbers
// the quota check uses.
func TestStorageUsageCountsReservedAndPendingBytes(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "usage_level")
	limit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes, reserved_bytes)
		VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE
		SET used_bytes=EXCLUDED.used_bytes, reserved_bytes=EXCLUDED.reserved_bytes`,
		user, limit*90/100, limit*4/100); err != nil {
		t.Fatal(err)
	}
	level := func() AccountStatus {
		t.Helper()
		status, err := s.AccountAccess(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		status, err = s.WithStorageUsage(ctx, status)
		if err != nil {
			t.Fatal(err)
		}
		return status
	}
	if got := level(); got.StorageUsage != StorageUsageOK || got.StorageUsedBytes != limit*94/100 {
		t.Fatalf("94%% = %s used %d", got.StorageUsage, got.StorageUsedBytes)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_storage_deltas (user_id, delta_bytes)
		VALUES ($1, $2)`, user, limit*2/100); err != nil {
		t.Fatal(err)
	}
	if got := level(); got.StorageUsage != StorageUsageNearLimit || got.StorageLimitBytes != limit {
		t.Fatalf("96%% with a pending delta = %s limit %d", got.StorageUsage, got.StorageLimitBytes)
	}
}
