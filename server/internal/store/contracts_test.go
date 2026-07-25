package store

import (
	"encoding/json"
	"testing"

	"github.com/evonotes/server/internal/materialdoc"
)

func TestWorkspaceRoleCapabilities(t *testing.T) {
	cases := []struct {
		role             WorkspaceRole
		canEdit, comment bool
	}{
		{RoleOwner, true, true},
		{RoleEditor, true, true},
		{RoleCommenter, false, true},
		{RoleViewer, false, false},
		{"", false, false},
	}
	for _, tc := range cases {
		if got := RoleCanEdit(tc.role); got != tc.canEdit {
			t.Errorf("RoleCanEdit(%q) = %v", tc.role, got)
		}
		if got := RoleCanComment(tc.role); got != tc.comment {
			t.Errorf("RoleCanComment(%q) = %v", tc.role, got)
		}
		capabilities := CapabilitiesForRole(tc.role, true)
		if !capabilities.CanView || capabilities.CanEdit != tc.canEdit || capabilities.CanComment != tc.comment {
			t.Errorf("CapabilitiesForRole(%q) = %#v", tc.role, capabilities)
		}
		if capabilities.CanManageMembers != (tc.role == RoleOwner) {
			t.Errorf("CanManageMembers(%q) = %v", tc.role, capabilities.CanManageMembers)
		}
	}
}

func TestShareRoleIsSafeWorkspaceRoleSubset(t *testing.T) {
	cases := map[ShareRole]WorkspaceRole{
		ShareViewer:    RoleViewer,
		ShareCommenter: RoleCommenter,
		ShareEditor:    RoleEditor,
	}
	for shareRole, expected := range cases {
		if got := shareRole.WorkspaceRole(); got != expected {
			t.Errorf("%q maps to %q, want %q", shareRole, got, expected)
		}
	}
	if got := ShareRole("invalid").WorkspaceRole(); got != RoleViewer {
		t.Fatalf("unknown persisted share role must fail closed to viewer, got %q", got)
	}
}

func TestInviteTokensAreBearerSafe(t *testing.T) {
	first, err := inviteToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := inviteToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) < 32 || first == second {
		t.Fatalf("invite tokens are too weak or collided: %q %q", first, second)
	}
	firstHash := inviteTokenHash(first)
	secondHash := inviteTokenHash(second)
	if firstHash == secondHash || len(firstHash) != 32 {
		t.Fatalf("invite token hashes are invalid: %x %x", firstHash, secondHash)
	}
	if string(firstHash[:]) == first {
		t.Fatal("invite token hash retained the raw bearer token")
	}
}

func TestCommentContentMustBePlateNodes(t *testing.T) {
	valid, err := json.Marshal(materialdoc.Empty().Value)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRichContent(valid); err != nil {
		t.Fatalf("valid Plate fragment was rejected: %v", err)
	}
	for _, invalid := range []json.RawMessage{
		json.RawMessage(`[]`),
		json.RawMessage(`[{"type":"p","children":[]}]`),
		json.RawMessage(`{"type":"p"}`),
	} {
		if err := validateRichContent(invalid); err == nil {
			t.Errorf("invalid Plate fragment was accepted: %s", invalid)
		}
	}
}

func TestCommentAnchorRejectsCollapsedAndMalformedRanges(t *testing.T) {
	valid := map[string]any{
		"anchor": map[string]any{"path": []any{float64(0), float64(0)}, "offset": float64(1)},
		"focus":  map[string]any{"path": []any{float64(0), float64(0)}, "offset": float64(4)},
	}
	if err := validateCommentAnchor(valid); err != nil {
		t.Fatalf("valid comment range was rejected: %v", err)
	}
	for _, invalid := range []map[string]any{
		{
			"anchor": map[string]any{"path": []any{float64(0)}, "offset": float64(2)},
			"focus":  map[string]any{"path": []any{float64(0)}, "offset": float64(2)},
		},
		{
			"anchor": map[string]any{"path": []any{float64(0)}, "offset": float64(1)},
		},
	} {
		if err := validateCommentAnchor(invalid); err == nil {
			t.Fatalf("invalid comment range was accepted: %#v", invalid)
		}
	}
}

func TestMaterialJSONEmbedsPlateEnvelope(t *testing.T) {
	content, err := materialdoc.FlashcardsDocument("Deck", []materialdoc.Card{
		{ID: "c_1", Front: "front", Back: "back"},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(Material{ID: "mat_1", Content: content, Revision: 3})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	envelope, ok := wire["content"].(map[string]any)
	if !ok || envelope["schemaVersion"] != float64(1) {
		t.Fatalf("content was not an embedded envelope: %s", body)
	}
	if wire["revision"] != float64(3) {
		t.Fatalf("revision missing from material: %s", body)
	}
}

func TestRewriteCardIDsUsesStableMapAcrossRevisions(t *testing.T) {
	first, err := materialdoc.FlashcardsDocument("Deck", []materialdoc.Card{
		{ID: "c_old", Front: "one", Back: "answer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := materialdoc.FlashcardsDocument("Deck", []materialdoc.Card{
		{ID: "c_old", Front: "two", Back: "answer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	idMap := map[string]string{}
	rewrittenFirst, ids, err := rewriteCardIDsWithMap(first, idMap)
	if err != nil {
		t.Fatal(err)
	}
	rewrittenSecond, secondIDs, err := rewriteCardIDsWithMap(second, idMap)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || len(secondIDs) != 1 || ids[0] != secondIDs[0] || ids[0] == "c_old" {
		t.Fatalf("card mapping is not stable: %v then %v", ids, secondIDs)
	}
	cards, err := materialdoc.ExtractFlashcards(rewrittenSecond)
	if err != nil {
		t.Fatal(err)
	}
	if cards[0].ID != ids[0] || cards[0].Front != "two" {
		t.Fatalf("rewritten revision lost content: %s / %#v", rewrittenFirst, cards)
	}
}
