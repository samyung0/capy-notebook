package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/evonotes/server/internal/materialdoc"
)

func equalJSONDocuments(a, b string) bool {
	var left, right any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
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

func TestEffectiveMaterialAccessAndMemberPrecedence(t *testing.T) {
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
	if err != nil || access.Role != RoleEditor || access.Explicit {
		t.Fatalf("signed-in nonmember access = %#v, %v", access, err)
	}
	anonymous, err := s.MaterialEffectiveAccess(ctx, "", material.ID)
	if err != nil || anonymous.Role != RoleViewer || anonymous.Explicit {
		t.Fatalf("anonymous access = %#v, %v", anonymous, err)
	}
	if err := s.AssertWorkspaceEditor(ctx, "u_other", ws.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("share editor gained structural workspace access: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, ws.ID, "u_other"); err != nil {
		t.Fatal(err)
	}
	access, err = s.MaterialEffectiveAccess(ctx, "u_other", material.ID)
	if err != nil || access.Role != RoleViewer || !access.Explicit {
		t.Fatalf("explicit viewer did not override share editor: %#v, %v", access, err)
	}

	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: "u_owner", Kind: "note", Title: "Standalone link",
		Content: content, Privacy: PrivacyLink,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteMaterial(ctx, standalone.ID) })
	access, err = s.MaterialEffectiveAccess(ctx, "u_other", standalone.ID)
	if err != nil || access.Role != RoleViewer || access.Explicit {
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
		ctx, ws.ID, "u_other", RoleEditor,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || roleNotification == nil || roleNotification.Href != "/workspaces/"+ws.ID {
		t.Fatalf("role notification = %#v, created=%v", roleNotification, created)
	}

	unchanged, created, err := s.SetWorkspaceMemberRoleWithResult(
		ctx, ws.ID, "u_other", RoleEditor,
	)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged != nil || created {
		t.Fatalf("unchanged role emitted an event: %#v, created=%v", unchanged, created)
	}

	removed, created, err := s.RemoveWorkspaceMemberWithResult(ctx, ws.ID, "u_other")
	if err != nil {
		t.Fatal(err)
	}
	if !created || removed == nil || removed.Href != "/workspaces" {
		t.Fatalf("removal notification = %#v, created=%v", removed, created)
	}
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

func TestCommentsAllowExactlyOneReplyLevel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
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
