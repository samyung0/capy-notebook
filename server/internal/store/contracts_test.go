package store

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestWorkspaceRoleCapabilities(t *testing.T) {
	cases := []struct {
		role    WorkspaceRole
		canEdit bool
	}{
		{RoleOwner, true},
		{RoleEditor, true},
		{RoleViewer, false},
		{"", false},
	}
	for _, tc := range cases {
		if got := RoleCanEdit(tc.role); got != tc.canEdit {
			t.Errorf("RoleCanEdit(%q) = %v", tc.role, got)
		}
		capabilities := CapabilitiesForRole(tc.role, true)
		if !capabilities.CanView || capabilities.CanEdit != tc.canEdit {
			t.Errorf("CapabilitiesForRole(%q) = %#v", tc.role, capabilities)
		}
		if capabilities.CanManageMembers != (tc.role == RoleOwner) {
			t.Errorf("CanManageMembers(%q) = %v", tc.role, capabilities.CanManageMembers)
		}
	}
}

func TestShareRoleIsSafeWorkspaceRoleSubset(t *testing.T) {
	cases := map[ShareRole]WorkspaceRole{
		ShareViewer: RoleViewer,
		ShareEditor: RoleEditor,
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

func TestCommentTextMustBePlain(t *testing.T) {
	for _, valid := range []string{"hi", "two\nlines\tand a tab", strings.Repeat("光", fieldlimits.Comment)} {
		if err := validateCommentText(valid); err != nil {
			t.Errorf("plain text %.20q refused: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", " \n\t", strings.Repeat("a", fieldlimits.Comment+1), "a\x00b", "a\rb", "a\u0085b"} {
		if err := validateCommentText(invalid); err == nil {
			t.Errorf("text %.20q accepted", invalid)
		}
	}
}

// TestCommentFieldsRefuseBidiControls (security regression: rate-limit audit
// r2 N-7, Q313). Text, quote and block id refuse bidi overrides and isolates
// and control characters but newline and tab; zero-width joiners stay.
func TestCommentFieldsRefuseBidiControls(t *testing.T) {
	family := "\U0001F468\u200D\U0001F469\u200D\U0001F467"
	if err := validateCommentText(family); err != nil {
		t.Fatalf("an emoji joined by zero-width joiners refused: %v", err)
	}
	for _, bidi := range []string{"\u202A", "\u202E", "\u2066", "\u2069"} {
		if err := validateCommentText("a" + bidi + "b"); err == nil {
			t.Errorf("text with %U accepted", []rune(bidi)[0])
		}
		if err := validateRelativeAnchor([]byte{1}, []byte{2}, 1, "a"+bidi+"b"); err == nil {
			t.Errorf("quote with %U accepted", []rune(bidi)[0])
		}
		id := "b" + bidi
		if err := validateBlockID(&id); err == nil {
			t.Errorf("block id with %U accepted", []rune(bidi)[0])
		}
	}
	for _, id := range []string{"", strings.Repeat("b", 129), "b\x00"} {
		if err := validateBlockID(&id); err == nil {
			t.Errorf("block id %.20q accepted", id)
		}
	}
	if id := strings.Repeat("b", 128); validateBlockID(&id) != nil {
		t.Error("a 128-character block id refused")
	}
}

func TestCommentRelativeAnchorBounds(t *testing.T) {
	if err := validateRelativeAnchor([]byte{1}, []byte{2}, 1, "quoted text"); err != nil {
		t.Fatalf("valid relative anchor was rejected: %v", err)
	}
	if err := validateRelativeAnchor([]byte{1}, nil, 1, ""); err == nil {
		t.Fatal("half of a relative range was accepted")
	}
	if err := validateRelativeAnchor([]byte{1}, []byte{2}, 0, ""); err == nil {
		t.Fatal("invalid anchor version was accepted")
	}
	if err := validateRelativeAnchor(make([]byte, maxRelativePositionBytes+1), []byte{2}, 1, ""); err == nil {
		t.Fatal("oversized relative position was accepted")
	}
}

func TestMaterialJSONEmbedsPlateEnvelope(t *testing.T) {
	content, err := materialdoc.FlashcardsDocument([]materialdoc.Card{
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
	first, err := materialdoc.FlashcardsDocument([]materialdoc.Card{
		{ID: "c_old", Front: "one", Back: "answer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := materialdoc.FlashcardsDocument([]materialdoc.Card{
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
