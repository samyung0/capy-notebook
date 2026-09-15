package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

func TestIconCatalogMatchesAssets(t *testing.T) {
	base := "../../../public/icons"
	raw, err := os.ReadFile("../../../src/lib/icon-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Styles []struct {
			ID      string
			Avatars []struct{ ID, Src string }
		}
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, style := range catalog.Styles {
		for _, icon := range style.Avatars {
			if !ValidIconID(icon.ID) || ids[icon.ID] {
				t.Fatalf("invalid or duplicate catalog id %q", icon.ID)
			}
			ids[icon.ID] = true
			if icon.Src != "/icons/"+icon.ID+".svg" {
				t.Fatalf("wrong asset path %s", icon.Src)
			}
			if _, err := os.Stat(filepath.Join(base, icon.ID+".svg")); err != nil {
				t.Fatal(err)
			}
		}
		for n := 0; n <= 99; n++ {
			id := fmt.Sprintf("%s-%02d", style.ID, n)
			if ValidIconID(id) != ids[id] {
				t.Fatalf("validator/catalog mismatch: %s", id)
			}
		}
	}
	if len(ids) != 75 {
		t.Fatalf("catalog contains %d icons, want 75", len(ids))
	}
	for _, bad := range []string{"", "../../secret", "slice-01", "slice-1", "unknown-01", "slice-01.svg", "slice-01\n"} {
		if ValidIconID(bad) {
			t.Errorf("accepted invalid id %q", bad)
		}
	}
}

func TestProfileIconSurvivesClerkSyncAndRestoresPhoto(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	for _, initialPhoto := range []string{"", "https://example.test/oauth.png"} {
		userID := uid("icon_user")
		t.Cleanup(func() { _, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
		if _, err := s.UpsertUserFromClerk(ctx, userID, "Name", userID+"@example.test", initialPhoto); err != nil {
			t.Fatal(err)
		}
		me, err := s.Me(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if initialPhoto == "" {
			if !strings.HasPrefix(me.AvatarIconID, "avataaars-") || !ValidIconID(me.AvatarIconID) {
				t.Fatalf("missing initial avatar: %+v", me)
			}
		} else if me.AvatarIconID != "" || me.AvatarURL != initialPhoto {
			t.Fatalf("OAuth photo replaced: %+v", me)
		}
		selected := "notionists-07"
		if err := s.SetProfile(ctx, userID, "Typed", &selected, nil); err != nil {
			t.Fatal(err)
		}
		photo := "https://example.test/upload.png"
		if _, err := s.UpsertUserFromClerk(ctx, userID, "Provider", "", photo); err != nil {
			t.Fatal(err)
		}
		me, err = s.Me(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if me.Name != "Typed" || me.AvatarIconID != selected || me.AvatarURL != "/icons/"+selected+".svg" {
			t.Fatalf("override lost: %+v", me)
		}
		empty := ""
		if err := s.SetProfile(ctx, userID, "Typed", &empty, nil); err == nil {
			t.Fatal("cleared icon without confirmed photo")
		}
		if err := s.SetProfile(ctx, userID, "Typed", &empty, &photo); err != nil {
			t.Fatal(err)
		}
		me, err = s.Me(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if me.AvatarIconID != "" || me.AvatarURL != photo {
			t.Fatalf("photo not restored: %+v", me)
		}
		// A delayed no-photo event must not reassign a default after restoration.
		if _, err := s.UpsertUserFromClerk(ctx, userID, "Provider", "", ""); err != nil {
			t.Fatal(err)
		}
		if _, err := s.UpsertUserFromClerk(ctx, userID, "Provider", "", photo); err != nil {
			t.Fatal(err)
		}
		me, err = s.Me(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if me.AvatarIconID != "" || me.AvatarURL != photo {
			t.Fatalf("late event replaced photo: %+v", me)
		}
	}
}

func TestWorkspaceIconPersistsAndClonesWithMemberPermissions(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "icon_owner")
	editor := newBlobTestUser(t, s, "icon_editor")
	visitor := newBlobTestUser(t, s, "icon_visitor")
	ws, err := s.CreateWorkspace(ctx, owner, "Icons", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ws.IconID, "waves-") || !ValidIconID(ws.IconID) {
		t.Fatalf("invalid default %s", ws.IconID)
	}
	loaded, err := s.GetWorkspace(ctx, owner, ws.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.IconID != ws.IconID {
		t.Fatal("default changed on read")
	}
	selected := "critters-16"
	if _, err := s.UpdateWorkspace(ctx, visitor, ws.ID, WorkspacePatch{IconID: &selected}); err == nil {
		t.Fatal("visitor changed icon")
	}
	addWorkspaceEditor(t, s, ws.ID, editor)
	updated, err := s.UpdateWorkspace(ctx, editor, ws.ID, WorkspacePatch{IconID: &selected})
	if err != nil {
		t.Fatal(err)
	}
	if updated.IconID != selected {
		t.Fatal("icon edit failed")
	}
	cloned, err := s.CloneWorkspace(ctx, owner, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cloned.IconID != selected {
		t.Fatal("clone lost icon")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	for actor, role := range map[string]WorkspaceRole{owner: RoleOwner, editor: RoleEditor, visitor: ""} {
		public, err := s.ListPublicWorkspaces(ctx, actor)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, item := range public {
			if item.ID == ws.ID {
				found = true
				if item.IconID != selected || item.MemberRole != role {
					t.Fatalf("Explore lost icon or membership: icon=%s role=%s, want %s", item.IconID, item.MemberRole, role)
				}
			}
		}
		if !found {
			t.Fatal("workspace missing from Explore")
		}
	}
	bad := "critters-17"
	if _, err := s.UpdateWorkspace(ctx, owner, ws.ID, WorkspacePatch{IconID: &bad}); err == nil {
		t.Fatal("invalid icon accepted")
	}
}
