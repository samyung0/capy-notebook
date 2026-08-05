package store

import (
	"context"
	"errors"
	"os"
	"testing"
)

func openAccessTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestWorkspaceAccessMatrix(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	cases := []struct {
		name    string
		user    string
		ws      string
		wantOwn bool
		wantErr error
	}{
		{"owner private", "u_owner", "ws_e2e_private", true, nil},
		{"editor private", "u_editor", "ws_e2e_private", false, nil},
		{"other private", "u_other", "ws_e2e_private", false, ErrNotFound},
		{"anon private", "", "ws_e2e_private", false, ErrNotFound},
		{"other link", "u_other", "ws_e2e_link", false, nil},
		{"anon link", "", "ws_e2e_link", false, nil},
		{"other public", "u_other", "ws_e2e_public", false, nil},
		{"anon public", "", "ws_e2e_public", false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			own, err := s.WorkspaceAccess(ctx, tc.user, tc.ws)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if own != tc.wantOwn {
				t.Fatalf("isOwner = %v, want %v", own, tc.wantOwn)
			}
		})
	}
}

func TestWorkspaceCapabilitiesForRoles(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	ownerRole, err := s.WorkspaceRole(ctx, "u_owner", "ws_e2e_private")
	if err != nil || ownerRole != RoleOwner {
		t.Fatalf("owner role = %q (%v)", ownerRole, err)
	}
	caps := CapabilitiesForRole(ownerRole, true)
	if !caps.CanEdit || !caps.CanManageMembers {
		t.Fatalf("owner caps = %#v", caps)
	}

	editorRole, err := s.WorkspaceRole(ctx, "u_editor", "ws_e2e_private")
	if err != nil || editorRole != RoleEditor {
		t.Fatalf("editor role = %q (%v)", editorRole, err)
	}
	caps = CapabilitiesForRole(editorRole, true)
	if !caps.CanEdit || caps.CanManageMembers {
		t.Fatalf("editor caps = %#v", caps)
	}

	viewerCaps := CapabilitiesForRole("", true)
	if !viewerCaps.CanView || viewerCaps.CanEdit || viewerCaps.CanManageMembers {
		t.Fatalf("viewer caps = %#v", viewerCaps)
	}
}

func TestMaterialAccessMatrix(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	cases := []struct {
		name    string
		user    string
		mat     string
		wantErr error
	}{
		{"owner private quiz", "u_owner", "qz_e2e_private", nil},
		{"other private quiz", "u_other", "qz_e2e_private", ErrNotFound},
		{"anon private quiz", "", "qz_e2e_private", ErrNotFound},
		{"other link quiz", "u_other", "qz_e2e_link", nil},
		{"anon link quiz", "", "qz_e2e_link", nil},
		{"other public quiz", "u_other", "qz_e2e_public", nil},
		// Private child material inherits readability from link parent workspace.
		{"other private note in link ws", "u_other", "note_e2e_private", ErrNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.MaterialAccess(ctx, tc.user, tc.mat)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMaterialInheritsParentWorkspaceShare(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	mt, err := s.CreateMaterial(ctx, Material{
		CreatedBy: "u_owner", WorkspaceID: "ws_e2e_link", WorkspaceName: "E2E Link Workspace",
		Kind: "note", Title: "Inherited private note",
		Content: "body",
		Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteMaterial(ctx, mt.ID) })

	if _, err := s.MaterialAccess(ctx, "u_other", mt.ID); err != nil {
		t.Fatalf("expected parent workspace share to grant read: %v", err)
	}
	if _, err := s.MaterialAccess(ctx, "", mt.ID); err != nil {
		t.Fatalf("anonymous should read via parent workspace share: %v", err)
	}
}

func TestMaterialLevelShareUnderPrivateWorkspace(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	mt, err := s.CreateMaterial(ctx, Material{
		CreatedBy: "u_owner", WorkspaceID: "ws_e2e_private", WorkspaceName: "E2E Private Workspace",
		Kind: "note", Title: "Standalone-shared note",
		Content: "shared",
		Privacy: PrivacyLink,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteMaterial(ctx, mt.ID) })

	if _, err := s.MaterialAccess(ctx, "u_other", mt.ID); err != nil {
		t.Fatalf("material-level link should be readable: %v", err)
	}
}

func TestSearchFlashcardsUsesMaterials(t *testing.T) {
	s := openAccessTestStore(t)

	results, err := s.Search(context.Background(), "u_editor", "E2E Private Deck")
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range results {
		if result.ID == "dk_e2e_private" {
			if result.Kind != SearchFlashcards || result.Title != "E2E Private Deck" {
				t.Fatalf("unexpected flashcard result: %#v", result)
			}
			return
		}
	}
	t.Fatalf("flashcard material missing from search results: %#v", results)
}
