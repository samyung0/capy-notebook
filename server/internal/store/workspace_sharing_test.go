package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
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
		UserID: "u_owner", Kind: "note", Title: "Standalone link",
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
	var inviteID, href string
	if err := s.pool.QueryRow(ctx, `SELECT wi.id, n.href
		FROM workspace_invites wi
		JOIN notifications n ON n.workspace_invite_id=wi.id
		WHERE wi.workspace_id=$1 AND wi.invited_user_id=$2
			AND wi.accepted_at IS NULL`, wsID, userID).Scan(&inviteID, &href); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(href, "/workspace-invites/")
	if token == href || token == "" {
		t.Fatalf("notification has invalid invitation href %q", href)
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

func TestAtomicSuggestionCommitAndReview(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)

	initialDoc := materialdoc.Empty()
	initialDoc.Value[0]["id"] = "block-1"
	initial, err := materialdoc.Marshal(initialDoc)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Suggested note",
		Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	markedDoc := materialdoc.Empty()
	markedDoc.Value[0]["id"] = "block-1"
	markedDoc.Value[0]["children"] = []any{map[string]any{
		"text":       "accepted",
		"suggestion": true,
		"suggestion_insert": map[string]any{
			"id": "plate-1", "type": "insert", "userId": "u_other",
		},
	}}
	marked, err := materialdoc.Marshal(markedDoc)
	if err != nil {
		t.Fatal(err)
	}
	unsafeDoc := markedDoc
	unsafeDoc.Value = []map[string]any{{
		"type": "p", "id": "block-1",
		"children": []any{
			map[string]any{"text": "unsuggested mutation"},
			map[string]any{
				"text": "suggested", "suggestion": true,
				"suggestion_insert": map[string]any{"id": "plate-1", "type": "insert"},
			},
		},
	}}
	unsafe, err := materialdoc.Marshal(unsafeDoc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", unsafe, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("unsafe suggestion commit error = %v", err)
	}
	committed, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", marked, 1)
	if err != nil {
		t.Fatal(err)
	}
	if committed.Material.Revision != 2 || !committed.Material.HasPendingSuggestions ||
		!reflect.DeepEqual(committed.SuggestionIDs, []string{"plate-1"}) {
		t.Fatalf("unexpected commit result: %#v", committed)
	}
	firstSuggestion := committed.Discussions[0].Suggestions[0]

	secondDoc := materialdoc.Empty()
	secondDoc.Value[0]["id"] = "block-1"
	secondDoc.Value[0]["children"] = []any{
		map[string]any{
			"text": "accepted revised", "suggestion": true,
			"suggestion_insert": map[string]any{
				"id": "plate-1", "type": "insert", "userId": "u_other",
			},
		},
		map[string]any{
			"text": " plus second", "suggestion": true,
			"suggestion_insert": map[string]any{
				"id": "plate-2", "type": "insert", "userId": "u_owner",
			},
		},
	}
	secondMarked, err := materialdoc.Marshal(secondDoc)
	if err != nil {
		t.Fatal(err)
	}
	secondCommit, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_owner", secondMarked, 2)
	if err != nil {
		t.Fatal(err)
	}
	if secondCommit.Material.Revision != 3 || len(secondCommit.Discussions) != 2 {
		t.Fatalf("second commit did not preserve the review tree: %#v", secondCommit)
	}
	plateCounts := map[string]int{}
	var revisedFirst MaterialSuggestion
	for _, discussion := range secondCommit.Discussions {
		for _, suggestion := range discussion.Suggestions {
			plateCounts[suggestion.PlateSuggestionID]++
			if suggestion.PlateSuggestionID == "plate-1" {
				revisedFirst = suggestion
			}
		}
	}
	if !reflect.DeepEqual(plateCounts, map[string]int{"plate-1": 1, "plate-2": 1}) ||
		revisedFirst.ID != firstSuggestion.ID ||
		revisedFirst.DiscussionID != firstSuggestion.DiscussionID ||
		revisedFirst.CommitRevision != 2 {
		t.Fatalf("existing suggestion metadata was duplicated or replaced: counts=%v first=%#v",
			plateCounts, revisedFirst)
	}

	refs, err := s.ListMaterialRefs(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	var pendingRef *MaterialRef
	for i := range refs {
		if refs[i].ID == material.ID {
			pendingRef = &refs[i]
			break
		}
	}
	if pendingRef == nil || !pendingRef.HasPendingSuggestions {
		t.Fatalf("material ref omitted pending state: %#v", pendingRef)
	}

	existingOnlyDoc := secondDoc
	existingOnlyDoc.Value = []map[string]any{{
		"type": "p", "id": "block-1",
		"children": []any{
			map[string]any{
				"text": "accepted revised again", "suggestion": true,
				"suggestion_insert": map[string]any{"id": "plate-1", "type": "insert"},
			},
			map[string]any{
				"text": " plus second", "suggestion": true,
				"suggestion_insert": map[string]any{"id": "plate-2", "type": "insert"},
			},
		},
	}}
	existingOnlyMarked, err := materialdoc.Marshal(existingOnlyDoc)
	if err != nil {
		t.Fatal(err)
	}
	existingOnlyCommit, err := s.CommitMaterialSuggestions(
		ctx,
		material.ID,
		"u_other",
		existingOnlyMarked,
		3,
	)
	if err != nil {
		t.Fatal(err)
	}
	if existingOnlyCommit.Material.Revision != 4 || len(existingOnlyCommit.Discussions) != 2 {
		t.Fatalf("existing-only commit duplicated metadata: %#v", existingOnlyCommit)
	}
	plateCounts = map[string]int{}
	for _, discussion := range existingOnlyCommit.Discussions {
		for _, suggestion := range discussion.Suggestions {
			plateCounts[suggestion.PlateSuggestionID]++
			if suggestion.PlateSuggestionID == "plate-1" &&
				suggestion.CommitRevision != 2 {
				t.Fatalf("existing lifecycle origin revision changed: %#v", suggestion)
			}
		}
	}
	if !reflect.DeepEqual(plateCounts, map[string]int{"plate-1": 1, "plate-2": 1}) {
		t.Fatalf("existing-only commit duplicated suggestions: %v", plateCounts)
	}

	accepted, err := s.ReviewMaterialSuggestions(
		ctx,
		material.ID,
		"u_owner",
		materialdoc.AcceptSuggestions,
		nil,
		4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Material.Revision != 5 || accepted.Material.HasPendingSuggestions {
		t.Fatalf("unexpected acceptance result: %#v", accepted)
	}
	updated, err := s.GetMaterial(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	finalizedDoc := materialdoc.Empty()
	finalizedDoc.Value[0]["id"] = "block-1"
	finalizedDoc.Value[0]["children"] = []any{
		map[string]any{"text": "accepted revised again plus second"},
	}
	finalized, err := materialdoc.Marshal(finalizedDoc)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 5 || !equalJSONDocuments(updated.Content, finalized) {
		t.Fatalf("material was not atomically finalized: revision=%d content=%s", updated.Revision, updated.Content)
	}
	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 5 ||
		revisions[0].EventType != RevisionSuggestionAccept ||
		revisions[1].EventType != RevisionSuggestionCommit ||
		revisions[2].EventType != RevisionSuggestionCommit ||
		revisions[3].EventType != RevisionSuggestionCommit ||
		revisions[4].EventType != RevisionCreate ||
		revisions[0].ParentRevision == nil || *revisions[0].ParentRevision != 4 {
		t.Fatalf("unexpected revision event history: %#v", revisions)
	}

	refs, err = s.ListMaterialRefs(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range refs {
		if ref.ID == material.ID && ref.HasPendingSuggestions {
			t.Fatalf("resolved material ref remained pending: %#v", ref)
		}
	}

	if _, err := s.ReviewMaterialSuggestions(
		ctx,
		material.ID,
		"u_owner",
		materialdoc.RejectSuggestions,
		[]string{"plate-1"},
		4,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale review error = %v", err)
	}
	unchanged, err := s.GetMaterial(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Revision != 5 ||
		!equalJSONDocuments(unchanged.Content, finalized) {
		t.Fatalf("stale review left partial state: material=%d", unchanged.Revision)
	}
}

func TestSuggestionCommitTracksExactPlateAndBlockPairs(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)

	initialDoc := materialdoc.Empty()
	initialDoc.Value = []map[string]any{
		{"type": "p", "id": "block-a", "children": []any{map[string]any{"text": ""}}},
		{"type": "p", "id": "block-b", "children": []any{map[string]any{"text": ""}}},
	}
	initial, err := materialdoc.Marshal(initialDoc)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Pair identity", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}

	markedDoc := initialDoc
	for i := range markedDoc.Value {
		markedDoc.Value[i]["children"] = []any{map[string]any{
			"text":       fmt.Sprintf("pending %d", i),
			"suggestion": true,
			"suggestion_shared": map[string]any{
				"id": "shared-plate-id", "type": "insert",
			},
		}}
	}
	marked, err := materialdoc.Marshal(markedDoc)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", marked, 1)
	if err != nil {
		t.Fatal(err)
	}
	firstIDs := map[string]string{}
	for _, discussion := range first.Discussions {
		if discussion.BlockID == nil || len(discussion.Suggestions) != 1 {
			t.Fatalf("suggestion discussion lacks a stable block: %#v", discussion)
		}
		suggestion := discussion.Suggestions[0]
		if suggestion.PlateSuggestionID != "shared-plate-id" ||
			suggestion.CommitRevision != 2 {
			t.Fatalf("unexpected lifecycle row: %#v", suggestion)
		}
		firstIDs[*discussion.BlockID] = suggestion.ID
	}
	if len(firstIDs) != 2 || firstIDs["block-a"] == "" || firstIDs["block-b"] == "" ||
		firstIDs["block-a"] == firstIDs["block-b"] {
		t.Fatalf("Plate/block pairs were conflated: %#v", firstIDs)
	}

	second, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_owner", marked, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, discussion := range second.Discussions {
		if discussion.BlockID == nil || len(discussion.Suggestions) != 1 {
			continue
		}
		suggestion := discussion.Suggestions[0]
		if firstIDs[*discussion.BlockID] != suggestion.ID || suggestion.CommitRevision != 2 {
			t.Fatalf("existing pair lifecycle was not updated in place: %#v", discussion)
		}
	}
}

func TestDirectMaterialEditPreservesPendingSuggestions(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)

	initialDoc := materialdoc.Empty()
	initialDoc.Value[0]["id"] = "block-1"
	initial, err := materialdoc.Marshal(initialDoc)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Pending edit", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	markedDoc := materialdoc.Empty()
	markedDoc.Value[0]["id"] = "block-1"
	markedDoc.Value[0]["children"] = []any{map[string]any{
		"text": "pending", "suggestion": true,
		"suggestion_insert": map[string]any{"id": "plate-1", "type": "insert"},
	}}
	marked, err := materialdoc.Marshal(markedDoc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", marked, 1); err != nil {
		t.Fatal(err)
	}

	title := "Renamed while pending"
	expected := int64(2)
	renamed, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Title: &title, ExpectedRevision: &expected, UpdatedBy: "u_owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Revision != 3 || !renamed.HasPendingSuggestions ||
		!equalJSONDocuments(renamed.Content, marked) {
		t.Fatalf("title-only edit cleared pending state: %#v", renamed)
	}

	markedDoc.Value[0]["children"].([]any)[0].(map[string]any)["text"] = "pending updated"
	updatedMarked, err := materialdoc.Marshal(markedDoc)
	if err != nil {
		t.Fatal(err)
	}
	expected = 3
	updated, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &updatedMarked, ExpectedRevision: &expected, UpdatedBy: "u_owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 4 || !updated.HasPendingSuggestions ||
		!equalJSONDocuments(updated.Content, updatedMarked) {
		t.Fatalf("marked edit did not recompute pending state: %#v", updated)
	}

	expected = 4
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &initial, ExpectedRevision: &expected, UpdatedBy: "u_owner",
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("direct edit removed pending IDs: %v", err)
	}

	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 4 || revisions[0].EventType != RevisionEdit ||
		revisions[0].ParentRevision == nil || *revisions[0].ParentRevision != 3 ||
		!revisions[0].HasPendingSuggestions {
		t.Fatalf("direct edit revision metadata is incorrect: %#v", revisions)
	}
	var metadata struct {
		ChangedFields []string `json:"changedFields"`
	}
	if err := json.Unmarshal(revisions[1].EventMetadata, &metadata); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata.ChangedFields, []string{"title"}) ||
		!revisions[1].HasPendingSuggestions {
		t.Fatalf("title edit event metadata or pending flag is incorrect: %#v / %#v",
			metadata, revisions[1])
	}
}

func TestSuggestionCommitRejectProjectionProtectsExistingPendingHead(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)

	base := materialdoc.Empty()
	base.Value[0]["id"] = "block-1"
	initial, err := materialdoc.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Protected pending head", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}

	first := materialdoc.Empty()
	first.Value[0]["id"] = "block-1"
	first.Value[0]["children"] = []any{map[string]any{
		"text": "pending", "suggestion": true,
		"suggestion_first": map[string]any{"id": "first", "type": "insert"},
	}}
	firstMarked, _ := materialdoc.Marshal(first)
	if _, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", firstMarked, 1); err != nil {
		t.Fatal(err)
	}

	// The existing pending ID is retained, but the commenter also smuggles an
	// unsuggested base mutation into the marked head. Rejecting both documents
	// must expose the mismatch and reject the whole transaction.
	malicious := materialdoc.Empty()
	malicious.Value[0]["id"] = "block-1"
	malicious.Value[0]["children"] = []any{
		map[string]any{"text": "unsuggested base mutation"},
		map[string]any{
			"text": "pending", "suggestion": true,
			"suggestion_first": map[string]any{"id": "first", "type": "insert"},
		},
		map[string]any{
			"text": "second", "suggestion": true,
			"suggestion_second": map[string]any{"id": "second", "type": "insert"},
		},
	}
	maliciousMarked, _ := materialdoc.Marshal(malicious)
	if _, err := s.CommitMaterialSuggestions(
		ctx, material.ID, "u_other", maliciousMarked, 2,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("commenter base mutation error = %v, want conflict", err)
	}

	unchanged, err := s.GetMaterial(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Revision != 2 || !unchanged.HasPendingSuggestions ||
		!equalJSONDocuments(unchanged.Content, firstMarked) {
		t.Fatalf("rejected commit changed pending head: %#v", unchanged)
	}
	discussions, err := s.ListCollaborationDiscussions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(discussions) != 1 || len(discussions[0].Suggestions) != 1 ||
		discussions[0].Suggestions[0].PlateSuggestionID != "first" ||
		discussions[0].Suggestions[0].Status != SuggestionPending {
		t.Fatalf("rejected commit changed suggestion rows: %#v", discussions)
	}
}

func TestReviewRawPlateSuggestionWithoutProjectionRow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)

	clean := materialdoc.Empty()
	clean.Value[0]["id"] = "block-orphan"
	cleanContent, _ := materialdoc.Marshal(clean)
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Raw Plate orphan", Content: cleanContent, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	marked := materialdoc.Empty()
	marked.Value[0]["id"] = "block-orphan"
	marked.Value[0]["children"] = []any{map[string]any{
		"text": "orphaned insertion", "suggestion": true,
		"suggestion_raw": map[string]any{"id": "raw-plate-id", "type": "insert"},
	}}
	content, _ := materialdoc.Marshal(marked)
	expected := int64(1)
	material, err = s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &content, ExpectedRevision: &expected, UpdatedBy: "u_owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	discussions, err := s.ListCollaborationDiscussions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(discussions) != 0 {
		t.Fatalf("raw Plate metadata unexpectedly had relational rows: %#v", discussions)
	}

	result, err := s.ReviewMaterialSuggestions(
		ctx, material.ID, "u_owner", materialdoc.AcceptSuggestions,
		[]string{"raw-plate-id"}, 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Material.Revision != 3 || result.Material.HasPendingSuggestions ||
		!reflect.DeepEqual(result.SuggestionIDs, []string{"raw-plate-id"}) {
		t.Fatalf("orphan review result = %#v", result)
	}
	if strings.Contains(result.Material.Content, "suggestion_") ||
		!strings.Contains(result.Material.Content, "orphaned insertion") {
		t.Fatalf("orphan review did not accept raw Plate mark: %s", result.Material.Content)
	}
	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 3 || revisions[0].EventType != RevisionSuggestionAccept ||
		revisions[0].ParentRevision == nil || *revisions[0].ParentRevision != 2 ||
		revisions[1].EventType != RevisionEdit ||
		revisions[1].ParentRevision == nil || *revisions[1].ParentRevision != 1 {
		t.Fatalf("orphan review revision lineage = %#v", revisions)
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
		ctx, material.ID, "u_commenter", nil, json.RawMessage(`{}`), rich,
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

func TestSuggestionCommentsAllowExactlyOneReplyLevel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	initialDoc := materialdoc.Empty()
	initialDoc.Value[0]["id"] = "block-suggestion-reply"
	initial, err := materialdoc.Marshal(initialDoc)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Suggestion reply depth", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}

	markedDoc := materialdoc.Empty()
	markedDoc.Value[0]["id"] = "block-suggestion-reply"
	markedDoc.Value[0]["children"] = []any{map[string]any{
		"text":       "suggested text",
		"suggestion": true,
		"suggestion_reply": map[string]any{
			"id": "suggestion-reply", "type": "insert",
		},
	}}
	marked, err := materialdoc.Marshal(markedDoc)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := s.CommitMaterialSuggestions(
		ctx, material.ID, "u_other", marked, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(committed.Discussions) != 1 {
		t.Fatalf("suggestion discussion count = %d", len(committed.Discussions))
	}
	discussion := committed.Discussions[0]
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"root"}]}]`)
	root, err := s.AddNestedComment(ctx, discussion.ID, "u_commenter", nil, rich)
	if err != nil {
		t.Fatal(err)
	}
	reply, err := s.AddNestedComment(
		ctx, discussion.ID, "u_editor", &root.ID,
		json.RawMessage(`[{"type":"p","children":[{"text":"reply"}]}]`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if reply.ParentCommentID == nil || *reply.ParentCommentID != root.ID {
		t.Fatalf("suggestion reply parent link = %#v", reply)
	}
	if _, err := s.AddNestedComment(
		ctx, discussion.ID, "u_owner", &reply.ID, rich,
	); err == nil || !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("suggestion second-level reply error = %v, want invalid", err)
	}
	listed, err := s.ListCollaborationDiscussions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Kind != "suggestion" ||
		len(listed[0].Comments) != 1 ||
		len(listed[0].Comments[0].Replies) != 1 ||
		listed[0].Comments[0].Replies[0].ID != reply.ID {
		t.Fatalf("suggestion reply tree is not one level: %#v", listed)
	}
}

func TestSuggestionDeleteConflictRollsBackProjectionAndRows(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	initialDoc := materialdoc.Empty()
	initialDoc.Value[0]["id"] = "block-delete"
	initial, _ := materialdoc.Marshal(initialDoc)
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Delete rollback", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	marked := materialdoc.Empty()
	marked.Value[0]["id"] = "block-delete"
	marked.Value[0]["children"] = []any{map[string]any{
		"text": "pending delete", "suggestion": true,
		"suggestion_delete": map[string]any{"id": "delete-id", "type": "insert"},
	}}
	markedContent, _ := materialdoc.Marshal(marked)
	committed, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", markedContent, 1)
	if err != nil {
		t.Fatal(err)
	}
	discussionID := committed.Discussions[0].ID
	stale := int64(1)
	if _, err := s.SoftDeleteDiscussion(
		ctx, discussionID, "u_other", &stale,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale delete error = %v, want conflict", err)
	}

	unchanged, err := s.GetMaterial(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Revision != 2 || !unchanged.HasPendingSuggestions ||
		!equalJSONDocuments(unchanged.Content, markedContent) {
		t.Fatalf("stale delete changed material: %#v", unchanged)
	}
	resource, err := s.DiscussionResource(ctx, discussionID)
	if err != nil || resource.MaterialID != material.ID {
		t.Fatalf("stale delete removed discussion: %#v / %v", resource, err)
	}
	suggestion, err := s.SuggestionResource(ctx, committed.Discussions[0].Suggestions[0].ID)
	if err != nil || suggestion.Status != SuggestionPending {
		t.Fatalf("stale delete changed suggestion: %#v / %v", suggestion, err)
	}
	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 2 {
		t.Fatalf("stale delete wrote a revision: %#v", revisions)
	}
}

func TestConcurrentReviewConflictLeavesEveryRevisionSurfaceUnchanged(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	initialDoc := materialdoc.Empty()
	initialDoc.Value[0]["id"] = "block-race"
	initial, _ := materialdoc.Marshal(initialDoc)
	material, err := s.CreateMaterial(ctx, Material{
		WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
		Title: "Concurrent review", Content: initial, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	marked := materialdoc.Empty()
	marked.Value[0]["id"] = "block-race"
	marked.Value[0]["children"] = []any{map[string]any{
		"text": "pending race", "suggestion": true,
		"suggestion_race": map[string]any{"id": "race-id", "type": "insert"},
	}}
	markedContent, _ := materialdoc.Marshal(marked)
	committed, err := s.CommitMaterialSuggestions(ctx, material.ID, "u_other", markedContent, 1)
	if err != nil {
		t.Fatal(err)
	}
	suggestionID := committed.Discussions[0].Suggestions[0].ID

	// Simulate a competing material mutation winning revision 3 first.
	title := "Concurrent review winner"
	expected := int64(2)
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Title: &title, ExpectedRevision: &expected, UpdatedBy: "u_owner",
	}); err != nil {
		t.Fatal(err)
	}
	before, _ := s.GetMaterial(ctx, material.ID)
	beforeRevisions, _ := s.ListMaterialRevisions(ctx, material.ID)

	if _, err := s.ReviewMaterialSuggestions(
		ctx, material.ID, "u_editor", materialdoc.AcceptSuggestions,
		[]string{"race-id"}, 2,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("losing concurrent review error = %v, want conflict", err)
	}
	after, _ := s.GetMaterial(ctx, material.ID)
	afterRevisions, _ := s.ListMaterialRevisions(ctx, material.ID)
	resource, err := s.SuggestionResource(ctx, suggestionID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision || after.Title != before.Title ||
		!equalJSONDocuments(after.Content, before.Content) ||
		after.HasPendingSuggestions != before.HasPendingSuggestions ||
		len(afterRevisions) != len(beforeRevisions) ||
		resource.Status != SuggestionPending {
		t.Fatalf("conflicting review left partial state: before=%#v after=%#v revisions=%d/%d suggestion=%#v",
			before, after, len(beforeRevisions), len(afterRevisions), resource)
	}
}
