package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
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
		"/api/materials/{id}/revisions:",
		"/api/materials/{id}/discussions:",
		"/api/materials/{id}/collaboration-token:",
		"/api/discussions/{id}/comments:",
		"/internal/collaboration/materials/{id}/projection:",
		"/api/source-upload-policy:",
		"expectedRevision:",
		"parentCommentId:",
		"anchorStart:",
		"anchorEnd:",
		"eventType:",
		"eventMetadata:",
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
		"operation:",
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
	editor := apimodel.FromWorkspaceAccess(
		store.Workspace{ID: "ws_1"}, store.RoleEditor, store.AccountActive)
	if editor.IsOwner || editor.Role == nil || *editor.Role != store.RoleEditor ||
		!editor.Capabilities.CanEdit || !editor.Capabilities.CanComment {
		t.Fatalf("editor access metadata is incorrect: %#v", editor)
	}

	public := apimodel.FromWorkspaceAccess(store.Workspace{ID: "ws_2"}, "", "")
	if public.IsOwner || public.Role != nil || !public.Capabilities.CanView ||
		public.Capabilities.CanEdit || public.Capabilities.CanComment {
		t.Fatalf("public viewer access metadata is incorrect: %#v", public)
	}
}
