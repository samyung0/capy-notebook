package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestCollaborationContractsAreRegistered(t *testing.T) {
	spec, err := SpecYAML()
	if err != nil {
		t.Fatal(err)
	}
	text := string(spec)
	for _, expected := range []string{
		"/api/workspaces/{id}/members:",
		"/api/workspaces/{id}/invites:",
		"/api/workspace-invites/{token}/accept:",
		"/api/materials/{id}/discussions:",
		"/api/materials/{id}/collaboration-token:",
		"/api/discussions/{id}/comments:",
		"/internal/collaboration/materials/{id}/projection:",
		"/api/source-upload-policy:",
		"anchorStart:",
		"anchorEnd:",
		"shareRole:",
		"identifier:",
		"schemaVersion:",
		"capabilities:",
		"contentBytes:",
		"allowNoExtension:",
		"parseModes:",
		"AssignableRole:",
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("OpenAPI contract missing %q", expected)
		}
	}
	for _, forbidden := range []string{
		"/api/workspaces/{id}/invite-candidates:",
		"/api/workspaces/{id}/invites/{inviteId}:",
		"CreatedWorkspaceInvite",
		"WorkspaceInviteCandidate",
		"originalFragment:",
		"proposedFragment:",
		"finalizedContent:",
		"expectedBaseRevision:",
		// "operation:" is no longer forbidden: ResourceEffect.operation is the
		// agent-tool result contract, unrelated to the removed suggestion flow.
		"previewBefore:",
		"previewAfter:",
		"suggestionIds:",
		"plateSuggestionId:",
		"hasPendingSuggestions:",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("OpenAPI contract still exposes %q", forbidden)
		}
	}
}
func TestMaterialResponseIncludesDecodedContent(t *testing.T) {
	raw, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := apimodel.FromMaterial(store.Material{
		ID: "mat_1", Kind: "note", Content: raw,
		ScopeChapters: []string{}, ScopeFileNames: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(material)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	content, ok := body["content"].(map[string]any)
	if !ok || content["schemaVersion"] != float64(1) {
		t.Fatalf("material response omitted decoded content: %s", encoded)
	}
	contentBytes, ok := body["contentBytes"].(float64)
	if !ok || int(contentBytes) != len(raw) {
		t.Fatalf("material response contentBytes = %v, want %d: %s", body["contentBytes"], len(raw), encoded)
	}
}

func TestMaterialUpdateResultDoesNotEchoContent(t *testing.T) {
	encoded, err := json.Marshal(apimodel.MaterialUpdateResult{
		ID: "mat_1", Revision: 2, ContentBytes: 123,
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if _, exists := body["content"]; exists {
		t.Fatalf("update acknowledgement echoed document content: %s", encoded)
	}
	if body["id"] != "mat_1" || body["revision"] != float64(2) ||
		body["contentBytes"] != float64(123) {
		t.Fatalf("unexpected update acknowledgement: %s", encoded)
	}
}
func TestInviteCreateRequestUsesPrivateIdentifier(t *testing.T) {
	encoded, err := json.Marshal(apimodel.CreateWorkspaceInviteReq{
		Identifier: "person@example.com",
		Role:       store.AssignableViewer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"identifier":"person@example.com"`) ||
		strings.Contains(string(encoded), `"userId"`) {
		t.Fatalf("invite request contract is not identifier-only: %s", encoded)
	}
}

func TestWorkspaceAccessMetadataDistinguishesEditorsAndPublicViewers(t *testing.T) {
	active := store.AccountStatus{State: store.AccountActive}
	editor := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, store.RoleEditor, store.RoleEditor, active, false)
	if editor.IsOwner || editor.Role == nil || *editor.Role != store.RoleEditor ||
		!editor.Capabilities.CanEdit {
		t.Fatalf("editor access metadata is incorrect: %#v", editor)
	}

	// A share-role editor holds content controls without a membership role.
	shared := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, "", store.RoleEditor, active, false)
	if shared.IsOwner || shared.Role != nil || !shared.Capabilities.CanEdit ||
		shared.Capabilities.CanManageMembers {
		t.Fatalf("share editor access metadata is incorrect: %#v", shared)
	}

	public := apimodel.FromWorkspaceAccess(store.Workspace{ID: "ws_2"}, "", "", store.AccountStatus{}, false)
	if public.IsOwner || public.Role != nil || !public.Capabilities.CanView ||
		public.Capabilities.CanEdit {
		t.Fatalf("public viewer access metadata is incorrect: %#v", public)
	}

	// Frozen is read-only both ways: the requester's own account, and the
	// owner's for every member.
	frozenActor := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, store.RoleEditor, store.RoleEditor, active, true)
	frozenOwner := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, store.RoleEditor, store.RoleEditor,
		store.AccountStatus{State: store.AccountOverQuotaFrozen}, false)
	grace := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, store.RoleEditor, store.RoleEditor,
		store.AccountStatus{State: store.AccountOverQuotaGrace}, false)
	if frozenActor.Capabilities.CanEdit || frozenActor.CanClone ||
		frozenOwner.Capabilities.CanEdit || !frozenOwner.CanClone ||
		!grace.Capabilities.CanEdit {
		t.Fatalf("frozen capabilities: actor %#v owner %#v grace %#v",
			frozenActor.Capabilities, frozenOwner.Capabilities, grace.Capabilities)
	}
}

func TestCheckCommentLengthCountsTextAndBlockBreaks(t *testing.T) {
	para := func(text string) map[string]any {
		return map[string]any{"type": "p", "children": []any{map[string]any{"text": text}}}
	}
	if err := checkCommentLength([]map[string]any{para(strings.Repeat("光", 3000))}); err != nil {
		t.Fatalf("3,000 runes refused: %v", err)
	}
	// Two paragraphs of 1,500 plus the newline between them is 3,001.
	if checkCommentLength([]map[string]any{para(strings.Repeat("a", 1500)), para(strings.Repeat("a", 1500))}) == nil {
		t.Fatal("3,001 characters accepted")
	}
}
