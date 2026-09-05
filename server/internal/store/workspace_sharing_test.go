package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
)

func equalJSONDocuments(a, b string) bool {
	var left, right any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
}

func TestWorkspaceDeletionReleasesProviderSessionsButKeepsLateReceipts(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_delete_workspace_session")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Provider session workspace", ColorGreen, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	reservationID := uid("cr")
	callID := uid("call")
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id,reserved_micros)
		VALUES ($1,123)
		ON CONFLICT (user_id) DO UPDATE SET reserved_micros=EXCLUDED.reserved_micros`,
		ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO provider_sessions
		(id,actor_user_id,workspace_id,surface,reserved_micros,expires_at)
		VALUES ($1,$2,$3,'editor',123,now()+interval '1 hour')`,
		reservationID, ownerID, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO provider_calls
		(id,reservation_id,actor_user_id,kind)
		VALUES ($1,$2,$3,'audio')`, callID, reservationID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteWorkspace(ctx, ownerID, workspace.ID); err != nil {
		t.Fatal(err)
	}
	var sessionStatus string
	var workspaceID *string
	var reserved int64
	if err := s.pool.QueryRow(ctx, `SELECT ps.status,ps.workspace_id,uc.reserved_micros
		FROM provider_sessions ps JOIN user_credits uc ON uc.user_id=ps.actor_user_id
		WHERE ps.id=$1`, reservationID).Scan(&sessionStatus, &workspaceID, &reserved); err != nil {
		t.Fatal(err)
	}
	if sessionStatus != "released" || workspaceID != nil || reserved != 0 {
		t.Fatalf("deleted workspace session status=%q workspace=%v reserved=%d",
			sessionStatus, workspaceID, reserved)
	}
	if _, err := s.SettleProviderCall(ctx, reservationID, ProviderCallUsage{
		CallID: callID, Kind: KindAudio, Provider: "elevenlabs",
		Model: "scribe_v2", Units: 1, Unit: "seconds",
	}); err != nil {
		t.Fatalf("settle late workspace receipt: %v", err)
	}
}

func createSharingTestWorkspace(t *testing.T, s *Store, shareRole ShareRole) (context.Context, Workspace) {
	t.Helper()
	ctx := context.Background()
	ws, err := s.CreateWorkspace(
		ctx,
		"u_owner",
		"Sharing test "+uid("name"),
		ColorGraphite,
		[]TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })
	privacy := PrivacyLink
	if shareRole == "" {
		shareRole = ShareViewer
	}
	ws, err = s.UpdateWorkspaceSharing(ctx, "u_owner", ws.ID, &privacy, &shareRole)
	if err != nil {
		t.Fatal(err)
	}
	return ctx, ws
}

func TestWorkspaceDefaultsToInviteOnlyViewer(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, "u_owner", "Default test "+uid("name"), ColorGraphite, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })
	if ws.Privacy != PrivacyPrivate || ws.ShareRole != ShareViewer {
		t.Fatalf("default sharing = privacy %q, role %q; want private/viewer", ws.Privacy, ws.ShareRole)
	}
}

func TestEffectiveMaterialAccessUnionsMembershipAndShareRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareEditor)

	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Shared note",
		Content: content, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}

	access, err := s.MaterialEffectiveAccess(ctx, "u_other", material.ID)
	if err != nil || access.Role != RoleEditor || access.MemberRole != "" {
		t.Fatalf("signed-in nonmember access = %#v, %v", access, err)
	}
	anonymous, err := s.MaterialEffectiveAccess(ctx, "", material.ID)
	if err != nil || anonymous.Role != RoleViewer || anonymous.MemberRole != "" {
		t.Fatalf("anonymous access = %#v, %v", anonymous, err)
	}
	if err := s.AssertWorkspaceEditor(ctx, "u_other", ws.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("share editor gained structural workspace access: %v", err)
	}

	// A viewer membership must not leave the invited collaborator with less
	// than the link already hands to every other signed-in account.
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, ws.ID, "u_other"); err != nil {
		t.Fatal(err)
	}
	access, err = s.MaterialEffectiveAccess(ctx, "u_other", material.ID)
	if err != nil || access.Role != RoleEditor || access.MemberRole != RoleViewer {
		t.Fatalf("viewer member was not raised by the share editor role: %#v, %v", access, err)
	}
	if err := s.AssertWorkspaceEditor(ctx, "u_other", ws.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("raised member gained structural workspace access: %v", err)
	}
	role, err := s.WorkspaceEffectiveRole(ctx, "u_other", ws.ID)
	if err != nil || role != RoleEditor {
		t.Fatalf("workspace effective role = %q, %v; want editor", role, err)
	}

	// The reverse never demotes: a viewer share role leaves editors editing.
	viewerShare := ShareViewer
	if _, err := s.UpdateWorkspaceSharing(ctx, "u_owner", ws.ID, nil, &viewerShare); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='editor'
		WHERE workspace_id=$1 AND user_id=$2`, ws.ID, "u_other"); err != nil {
		t.Fatal(err)
	}
	access, err = s.MaterialEffectiveAccess(ctx, "u_other", material.ID)
	if err != nil || access.Role != RoleEditor || access.MemberRole != RoleEditor {
		t.Fatalf("editor member was lowered by the viewer share role: %#v, %v", access, err)
	}

	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: "u_owner", Kind: "note", Title: "Standalone link",
		Content: content, Privacy: PrivacyLink,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteMaterial(ctx, "u_owner", standalone.ID) })
	access, err = s.MaterialEffectiveAccess(ctx, "u_other", standalone.ID)
	if err != nil || access.Role != RoleViewer || access.MemberRole != "" {
		t.Fatalf("standalone sharing must remain view-only: %#v, %v", access, err)
	}
}

func workspaceInviteToken(t *testing.T, s *Store, ctx context.Context, wsID, identifier, userID string, role WorkspaceRole) (string, string) {
	t.Helper()
	if err := s.CreateWorkspaceInvite(ctx, wsID, identifier, role, "u_owner"); err != nil {
		t.Fatal(err)
	}
	var inviteID, href, invitePath string
	var notificationData []byte
	if err := s.pool.QueryRow(ctx, `SELECT wi.id, n.href, n.data, o.payload->>'invitePath'
		FROM workspace_invites wi
		JOIN notifications n ON n.workspace_invite_id=wi.id
		JOIN email_outbox o ON o.template='workspace-invite'
			AND o.payload->>'inviteId'=wi.id
		WHERE wi.workspace_id=$1 AND wi.invited_user_id=$2
			AND wi.accepted_at IS NULL`, wsID, userID).
		Scan(&inviteID, &href, &notificationData, &invitePath); err != nil {
		t.Fatal(err)
	}
	if href != "/workspace-invites/"+inviteID {
		t.Fatalf("notification has unsafe invitation href %q", href)
	}
	const invitePathPrefix = "/workspace-invites/"
	if len(invitePath) <= len(invitePathPrefix) ||
		invitePath[:len(invitePathPrefix)] != invitePathPrefix {
		t.Fatalf("outbox has invalid invitation path %q", invitePath)
	}
	token := invitePath[len(invitePathPrefix):]
	if bytes.Contains(notificationData, []byte(token)) {
		t.Fatal("notification payload contains the plaintext invitation token")
	}
	return inviteID, token
}

func TestWorkspaceInviteAcceptanceGrantsRoleCapabilities(t *testing.T) {
	s := openAccessTestStore(t)
	cases := []struct {
		name       string
		userID     string
		role       WorkspaceRole
		canEdit    bool
		canComment bool
	}{
		{name: "editor", userID: "u_editor", role: RoleEditor, canEdit: true, canComment: true},
		{name: "commenter", userID: "u_commenter", role: RoleCommenter, canComment: true},
		{name: "viewer", userID: "u_viewer", role: RoleViewer},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			ws, err := s.CreateWorkspace(ctx, "u_owner", "Invite role "+uid("name"), ColorGraphite, []TagRef{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })

			inviteID, token := workspaceInviteToken(t, s, ctx, ws.ID, tc.userID, tc.userID, tc.role)
			member, err := s.AcceptWorkspaceInvite(ctx, token, tc.userID)
			if err != nil {
				t.Fatal(err)
			}
			if member.WorkspaceID != ws.ID || member.UserID != tc.userID || member.Role != tc.role {
				t.Fatalf("accepted member = %#v", member)
			}

			role, err := s.WorkspaceRole(ctx, tc.userID, ws.ID)
			if err != nil || role != tc.role {
				t.Fatalf("persisted role = %q, %v; want %q", role, err, tc.role)
			}
			if _, err := s.WorkspaceAccess(ctx, tc.userID, ws.ID); err != nil {
				t.Fatalf("accepted member cannot view workspace: %v", err)
			}
			if err := s.AssertWorkspaceEditor(ctx, tc.userID, ws.ID); (err == nil) != tc.canEdit {
				t.Fatalf("edit access error = %v, want canEdit=%v", err, tc.canEdit)
			}
			if err := s.AssertWorkspaceCommenter(ctx, tc.userID, ws.ID); (err == nil) != tc.canComment {
				t.Fatalf("comment access error = %v, want canComment=%v", err, tc.canComment)
			}

			members, err := s.ListWorkspaceMembers(ctx, ws.ID)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, listed := range members {
				found = found || (listed.UserID == tc.userID && listed.Role == tc.role)
			}
			if !found {
				t.Fatalf("%s was not listed as an accepted %s member", tc.userID, tc.role)
			}

			var notificationCount int
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications
				WHERE workspace_invite_id=$1`, inviteID).Scan(&notificationCount); err != nil {
				t.Fatal(err)
			}
			if notificationCount != 0 {
				t.Fatal("accepted invitation notification was not removed")
			}
		})
	}
}

func TestReciprocalWorkspaceInviteAcceptanceUsesCanonicalAccountLockOrder(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	firstUserID := newBlobTestUser(t, s, "a_reciprocal_invite")
	secondUserID := newBlobTestUser(t, s, "z_reciprocal_invite")
	firstWorkspace, err := s.CreateWorkspace(
		ctx, firstUserID, "First reciprocal invite", ColorGreen, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	secondWorkspace, err := s.CreateWorkspace(
		ctx, secondUserID, "Second reciprocal invite", ColorBlue, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(
		ctx, firstWorkspace.ID, secondUserID, RoleViewer, firstUserID,
	); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(
		ctx, secondWorkspace.ID, firstUserID, RoleViewer, secondUserID,
	); err != nil {
		t.Fatal(err)
	}
	inviteTokenFor := func(workspaceID, invitedUserID string) string {
		var path string
		if err := s.pool.QueryRow(ctx, `SELECT o.payload->>'invitePath'
			FROM workspace_invites wi
			JOIN email_outbox o ON o.template='workspace-invite'
			 AND o.payload->>'inviteId'=wi.id
			WHERE wi.workspace_id=$1 AND wi.invited_user_id=$2`,
			workspaceID, invitedUserID).Scan(&path); err != nil {
			t.Fatal(err)
		}
		return strings.TrimPrefix(path, "/workspace-invites/")
	}
	firstToken := inviteTokenFor(firstWorkspace.ID, secondUserID)
	secondToken := inviteTokenFor(secondWorkspace.ID, firstUserID)

	// Hold the lexically first user so both acceptances reach their account-lock
	// boundary together. With owner-first locking, the second acceptance holds
	// the other owner and the two transactions deadlock when this lock releases.
	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	var locked string
	if err := blocker.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, firstUserID).
		Scan(&locked); err != nil {
		t.Fatal(err)
	}

	firstResult := make(chan error, 1)
	go func() {
		_, err := s.AcceptWorkspaceInvite(ctx, firstToken, secondUserID)
		firstResult <- err
	}()
	time.Sleep(50 * time.Millisecond)
	secondResult := make(chan error, 1)
	go func() {
		_, err := s.AcceptWorkspaceInvite(ctx, secondToken, firstUserID)
		secondResult <- err
	}()
	time.Sleep(50 * time.Millisecond)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if err := <-firstResult; err != nil {
		t.Fatalf("first reciprocal acceptance: %v", err)
	}
	if err := <-secondResult; err != nil {
		t.Fatalf("second reciprocal acceptance: %v", err)
	}
}

func TestWorkspaceMembershipNotificationsAndNoOpRoleChange(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, "u_owner", "Membership events "+uid("name"), ColorGraphite, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })

	_, token := workspaceInviteToken(t, s, ctx, ws.ID, "u_other", "u_other", RoleViewer)
	if _, err := s.AcceptWorkspaceInvite(ctx, token, "u_other"); err != nil {
		t.Fatal(err)
	}

	roleNotification, created, err := s.SetWorkspaceMemberRoleWithResult(
		ctx, "u_owner", ws.ID, "u_other", RoleEditor,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || roleNotification == nil || roleNotification.Href != "/workspaces/"+ws.ID {
		t.Fatalf("role notification = %#v, created=%v", roleNotification, created)
	}

	unchanged, created, err := s.SetWorkspaceMemberRoleWithResult(
		ctx, "u_owner", ws.ID, "u_other", RoleEditor,
	)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged != nil || created {
		t.Fatalf("unchanged role emitted an event: %#v, created=%v", unchanged, created)
	}

	removed, created, err := s.RemoveWorkspaceMemberWithResult(
		ctx, "u_owner", ws.ID, "u_other",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || removed == nil || removed.Href != "/workspaces" {
		t.Fatalf("removal notification = %#v, created=%v", removed, created)
	}
}

func TestEmailLessInviteeGetsInAppMembershipEventsWithoutEmail(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	inviteeID := newBlobTestUser(t, s, "u_email_less_invitee")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET email=NULL WHERE id=$1`, inviteeID); err != nil {
		t.Fatal(err)
	}
	ws, err := s.CreateWorkspace(
		ctx, "u_owner", "Email-less membership "+uid("name"), ColorGraphite, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })

	invite, created, err := s.CreateWorkspaceInviteWithResult(
		ctx, ws.ID, inviteeID, RoleViewer, "u_owner",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || invite == nil || invite.WorkspaceInviteID == "" {
		t.Fatalf("invite notification = %#v, created=%v", invite, created)
	}
	assertNoEmail := func(stage string) {
		t.Helper()
		var count int
		if err := s.pool.QueryRow(ctx,
			`SELECT count(*) FROM email_outbox WHERE user_id=$1`, inviteeID,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s created %d email outbox row(s)", stage, count)
		}
	}
	assertNoEmail("invite")

	if _, err := s.pool.Exec(ctx,
		`DELETE FROM workspace_invites WHERE id=$1`, invite.WorkspaceInviteID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id,user_id,role) VALUES ($1,$2,'viewer')`, ws.ID, inviteeID); err != nil {
		t.Fatal(err)
	}
	roleNotification, created, err := s.SetWorkspaceMemberRoleWithResult(
		ctx, "u_owner", ws.ID, inviteeID, RoleEditor,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || roleNotification == nil {
		t.Fatalf("role notification = %#v, created=%v", roleNotification, created)
	}
	assertNoEmail("role change")

	removed, created, err := s.RemoveWorkspaceMemberWithResult(
		ctx, "u_owner", ws.ID, inviteeID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || removed == nil {
		t.Fatalf("removal notification = %#v, created=%v", removed, created)
	}
	assertNoEmail("member removal")
}

func TestWorkspaceInvitePrivacyAndAutomaticExpiry(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, "u_owner", "Invite expiry "+uid("name"), ColorGraphite, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(ctx, "u_owner", ws.ID) })

	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "missing@example.com", RoleViewer, "u_owner"); err != nil {
		t.Fatal(err)
	}
	var missingCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_invites
		WHERE workspace_id=$1`, ws.ID).Scan(&missingCount); err != nil {
		t.Fatal(err)
	}
	if missingCount != 0 {
		t.Fatalf("unknown identifier created %d invitation rows", missingCount)
	}

	inviteID, token := workspaceInviteToken(t, s, ctx, ws.ID, "u_other", "u_other", RoleViewer)
	var lifetimeSeconds int64
	if err := s.pool.QueryRow(ctx, `SELECT extract(epoch FROM expires_at-created_at)::bigint
		FROM workspace_invites WHERE id=$1`, inviteID).Scan(&lifetimeSeconds); err != nil {
		t.Fatal(err)
	}
	if lifetimeSeconds != 7*24*60*60 {
		t.Fatalf("invite lifetime = %d seconds, want 7 days", lifetimeSeconds)
	}

	if _, err := s.AcceptWorkspaceInvite(ctx, token, "u_viewer"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("mismatched user accepted bound invite: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_invites
		SET expires_at=now()-interval '1 second' WHERE id=$1`, inviteID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, token, "u_other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired invitation was accepted: %v", err)
	}
	notifications, err := s.Notifications(ctx, "u_other")
	if err != nil {
		t.Fatal(err)
	}
	for _, notification := range notifications {
		if notification.Href == "/workspace-invites/"+token {
			t.Fatal("expired invitation remained visible in notifications")
		}
	}

	expired, err := s.ExpireWorkspaceInvites(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if expired != 1 {
		t.Fatalf("expired cleanup removed %d invites, want 1", expired)
	}
	var inviteCount, notificationCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_invites WHERE id=$1`, inviteID).
		Scan(&inviteCount); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications
		WHERE workspace_invite_id=$1`, inviteID).Scan(&notificationCount); err != nil {
		t.Fatal(err)
	}
	if inviteCount != 0 || notificationCount != 0 {
		t.Fatalf("expired rows remain: invites=%d notifications=%d", inviteCount, notificationCount)
	}
	role, err := s.WorkspaceRole(ctx, "u_other", ws.ID)
	if err != nil || role != "" {
		t.Fatalf("non-accepting user became a member: role=%q err=%v", role, err)
	}
}

func TestQueuedInviteEmailMaySendButDeletingWorkspaceOwnerMakesLinkUnavailable(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_invite_deleting_owner")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Deleting invite owner", ColorGraphite, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.CancelAccountDeletion(ctx, ownerID)
		_ = s.DeleteWorkspace(ctx, ownerID, ws.ID)
	})

	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "u_other", RoleViewer, ownerID); err != nil {
		t.Fatal(err)
	}
	var inviteID, invitePath, mailID string
	if err := s.pool.QueryRow(ctx, `SELECT wi.id, o.payload->>'invitePath', o.id
		FROM workspace_invites wi
		JOIN email_outbox o ON o.template='workspace-invite'
			AND o.payload->>'inviteId'=wi.id
		WHERE wi.workspace_id=$1 AND wi.invited_user_id='u_other'`, ws.ID).
		Scan(&inviteID, &invitePath, &mailID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, ownerID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox
		SET next_attempt_at=now()+interval '1 day'
		WHERE status='pending' AND id<>$1`, mailID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != mailID {
		t.Fatalf("claimed invite mail=%#v, want %s", items, mailID)
	}
	active, err := s.EmailClaimActive(ctx, items[0])
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("queued invite email was retracted after workspace owner requested deletion")
	}
	if err := s.CancelEmailClaim(ctx, items[0]); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(invitePath, "/workspace-invites/")
	if token == invitePath || token == "" {
		t.Fatalf("invalid invite path %q for %s", invitePath, inviteID)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, token, "u_other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deletion-pending owner invite acceptance=%v, want not found", err)
	}
}

func TestQueuedInviteEmailMaySendAfterWorkspaceDeletion(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_invite_deleted_workspace_owner")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Deleted invitation workspace", ColorGraphite, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID)
	})

	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "u_other", RoleViewer, ownerID); err != nil {
		t.Fatal(err)
	}
	var inviteID, invitePath, mailID string
	if err := s.pool.QueryRow(ctx, `SELECT wi.id, o.payload->>'invitePath', o.id
		FROM workspace_invites wi
		JOIN email_outbox o ON o.template='workspace-invite'
			AND o.payload->>'inviteId'=wi.id
		WHERE wi.workspace_id=$1 AND wi.invited_user_id='u_other'`, ws.ID).
		Scan(&inviteID, &invitePath, &mailID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteWorkspace(ctx, ownerID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox
		SET next_attempt_at=now()+interval '1 day'
		WHERE status='pending' AND id<>$1`, mailID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != mailID {
		t.Fatalf("claimed invite mail=%#v, want %s", items, mailID)
	}
	active, err := s.EmailClaimActive(ctx, items[0])
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("queued invite email was retracted after workspace deletion")
	}
	if err := s.CancelEmailClaim(ctx, items[0]); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(invitePath, "/workspace-invites/")
	if token == invitePath || token == "" {
		t.Fatalf("invalid invite path %q for %s", invitePath, inviteID)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, token, "u_other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted workspace invite acceptance=%v, want not found", err)
	}
}

func TestOverQuotaOwnerCannotInviteOrPromoteButCanDemote(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_over_quota_members_owner")
	viewerID := newBlobTestUser(t, s, "u_over_quota_members_viewer")
	editorID := newBlobTestUser(t, s, "u_over_quota_members_editor")
	inviteeID := newBlobTestUser(t, s, "u_over_quota_members_invitee")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Over quota membership", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id,user_id,role) VALUES ($1,$2,'viewer'),($1,$3,'editor')`,
		ws.ID, viewerID, editorID); err != nil {
		t.Fatal(err)
	}
	pushOverQuota(t, s, ownerID, ws.ID)

	if err := s.CreateWorkspaceInvite(ctx, ws.ID, inviteeID, RoleViewer, ownerID); err == nil {
		t.Fatal("over-quota owner created an invitation")
	} else {
		var locked *AccountLockedError
		if !errors.As(err, &locked) || locked.Code() != "account_over_quota" {
			t.Fatalf("invite error=%v, want over-quota account error", err)
		}
	}
	if err := s.SetWorkspaceMemberRole(ctx, ownerID, ws.ID, viewerID, RoleCommenter); err == nil {
		t.Fatal("over-quota owner promoted a viewer")
	} else {
		var locked *AccountLockedError
		if !errors.As(err, &locked) || locked.Code() != "account_over_quota" {
			t.Fatalf("promotion error=%v, want over-quota account error", err)
		}
	}
	if err := s.SetWorkspaceMemberRole(ctx, ownerID, ws.ID, editorID, RoleViewer); err != nil {
		t.Fatalf("over-quota demotion failed: %v", err)
	}
}

func TestOwnerLifecycleBlocksAcceptanceOfPreviouslyIssuedInvite(t *testing.T) {
	for _, lifecycle := range []string{"over_quota", "suspended"} {
		t.Run(lifecycle, func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx := context.Background()
			ownerID := newBlobTestUser(t, s, "u_invite_owner_"+lifecycle)
			inviteeID := newBlobTestUser(t, s, "u_invite_target_"+lifecycle)
			ws, err := s.CreateWorkspace(ctx, ownerID, "Lifecycle invite", ColorGreen, []TagRef{})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.CreateWorkspaceInvite(ctx, ws.ID, inviteeID, RoleViewer, ownerID); err != nil {
				t.Fatal(err)
			}
			var invitePath string
			if err := s.pool.QueryRow(ctx, `SELECT o.payload->>'invitePath'
				FROM workspace_invites wi
				JOIN email_outbox o ON o.template='workspace-invite'
				 AND o.payload->>'inviteId'=wi.id
				WHERE wi.workspace_id=$1 AND wi.invited_user_id=$2`, ws.ID, inviteeID).
				Scan(&invitePath); err != nil {
				t.Fatal(err)
			}
			switch lifecycle {
			case "over_quota":
				pushOverQuota(t, s, ownerID, ws.ID)
			case "suspended":
				if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
					suspended_reason='operator hold' WHERE id=$1`, ownerID); err != nil {
					t.Fatal(err)
				}
			}
			token := strings.TrimPrefix(invitePath, "/workspace-invites/")
			if _, err := s.AcceptWorkspaceInvite(ctx, token, inviteeID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("%s owner invite acceptance=%v, want not found", lifecycle, err)
			}
			var memberCount int
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members
				WHERE workspace_id=$1 AND user_id=$2`, ws.ID, inviteeID).Scan(&memberCount); err != nil {
				t.Fatal(err)
			}
			if memberCount != 0 {
				t.Fatalf("%s owner invite created membership", lifecycle)
			}
		})
	}
}

func TestCommentsAllowExactlyOneReplyLevel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role) VALUES
		($1,'u_commenter','commenter'),($1,'u_editor','editor')`, ws.ID); err != nil {
		t.Fatal(err)
	}
	content, _ := materialdoc.Marshal(materialdoc.Empty())
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Reply depth", Content: content, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"root"}]}]`)
	discussion, err := s.CreateCommentDiscussion(
		ctx, material.ID, "u_commenter", nil, nil, nil, 1, "", rich,
	)
	if err != nil {
		t.Fatal(err)
	}
	root := discussion.Comments[0]
	reply, err := s.AddNestedComment(ctx, discussion.ID, "u_editor", &root.ID,
		json.RawMessage(`[{"type":"p","children":[{"text":"reply"}]}]`))
	if err != nil {
		t.Fatal(err)
	}
	if reply.ParentCommentID == nil || *reply.ParentCommentID != root.ID {
		t.Fatalf("reply parent link = %#v", reply)
	}
	if _, err := s.AddNestedComment(ctx, discussion.ID, "u_owner", &reply.ID, rich); err == nil ||
		!errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("second-level reply error = %v, want invalid", err)
	}
	listed, err := s.ListCollaborationDiscussions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || len(listed[0].Comments) != 1 ||
		len(listed[0].Comments[0].Replies) != 1 ||
		listed[0].Comments[0].Replies[0].ID != reply.ID ||
		len(listed[0].Comments[0].Replies[0].Replies) != 0 {
		t.Fatalf("reply tree is not one level: %#v", listed)
	}
}

func TestCommentMutationsRecheckLifecycleAndCurrentRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_comment_owner")
	commenterID := newBlobTestUser(t, s, "u_comment_actor")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Comment lifecycle", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role) VALUES ($1,$2,'commenter')`, ws.ID, commenterID); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
		Kind: "note", Title: "Comment lifecycle", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"root"}]}]`)
	discussion, err := s.CreateCommentDiscussion(
		ctx, material.ID, commenterID, nil, nil, nil, 1, "", rich,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='test suspension'
		WHERE id=$1`, commenterID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddNestedComment(ctx, discussion.ID, commenterID, nil, rich); err == nil {
		t.Fatal("suspended commenter added a comment")
	} else {
		var locked *AccountLockedError
		if !errors.As(err, &locked) || locked.State != AccountSuspended {
			t.Fatalf("suspended commenter error = %v", err)
		}
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=NULL,
		suspended_reason=NULL WHERE id=$1`,
		commenterID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='viewer'
		WHERE workspace_id=$1 AND user_id=$2`, ws.ID, commenterID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCollaborationDiscussionResolved(
		ctx, discussion.ID, commenterID, true,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer resolve error = %v, want forbidden", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='commenter'
		WHERE workspace_id=$1 AND user_id=$2`, ws.ID, commenterID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users
		SET deletion_requested_at=now(), purge_after=now()+interval '30 days'
		WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddNestedComment(ctx, discussion.ID, commenterID, nil, rich); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting-owner comment error = %v, want not found", err)
	}
}
