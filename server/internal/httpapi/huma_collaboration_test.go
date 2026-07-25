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
		"/api/materials/{id}/suggestion-commits:",
		"/api/materials/{id}/suggestions/review:",
		"/api/material-suggestions/{id}:",
		"/api/materials/{id}/discussions:",
		"/api/discussions/{id}/comments:",
		"/api/source-upload-policy:",
		"expectedRevision:",
		"suggestionIds:",
		"plateSuggestionId:",
		"commitRevision:",
		"resolutionRevision:",
		"parentCommentId:",
		"hasPendingSuggestions:",
		"eventType:",
		"eventMetadata:",
		"shareRole:",
		"identifier:",
		"schemaVersion:",
		"capabilities:",
		"contentBytes:",
		"allowNoExtension:",
		"parseModes:",
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
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("OpenAPI contract still exposes %q", forbidden)
		}
	}
}

func TestSharedMaterialPatchAllowList(t *testing.T) {
	content := materialdoc.Empty()
	revision := int64(3)
	if !sharedMaterialPatchAllowed(apimodel.UpdateMaterialReq{
		Content: &content, ExpectedRevision: &revision,
	}) {
		t.Fatal("content-only optimistic patch should be allowed")
	}
	title := "renamed"
	chapter := "ch_1"
	scope := []string{"ch_1"}
	privacy := store.PrivacyPublic
	for name, body := range map[string]apimodel.UpdateMaterialReq{
		"missing content":  {ExpectedRevision: &revision},
		"missing revision": {Content: &content},
		"title":            {Content: &content, ExpectedRevision: &revision, Title: &title},
		"chapter":          {Content: &content, ExpectedRevision: &revision, ChapterID: &chapter},
		"scope":            {Content: &content, ExpectedRevision: &revision, ScopeChapters: &scope},
		"privacy":          {Content: &content, ExpectedRevision: &revision, Privacy: &privacy},
	} {
		t.Run(name, func(t *testing.T) {
			if sharedMaterialPatchAllowed(body) {
				t.Fatalf("shared editor patch unexpectedly allowed: %#v", body)
			}
		})
	}
}

func TestMaterialResponseIncludesDecodedContent(t *testing.T) {
	raw, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(apimodel.FromMaterial(store.Material{
		ID: "mat_1", Kind: "note", Content: raw,
		ScopeChapters: []string{}, ScopeFileIDs: []string{},
	}))
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

func TestMaterialRefExposesPendingSuggestions(t *testing.T) {
	encoded, err := json.Marshal(apimodel.MaterialRef{
		ID: "mat_1", Type: "note", Title: "Pending",
		HasPendingSuggestions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if body["hasPendingSuggestions"] != true {
		t.Fatalf("material ref omitted pending state: %s", encoded)
	}
}

func TestInviteCreateRequestUsesPrivateIdentifier(t *testing.T) {
	encoded, err := json.Marshal(apimodel.CreateWorkspaceInviteReq{
		Identifier: "person@example.com",
		Role:       store.RoleViewer,
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
	editor := apimodel.FromWorkspaceAccess(store.Workspace{ID: "ws_1"}, store.RoleEditor)
	if editor.IsOwner || editor.Role == nil || *editor.Role != store.RoleEditor ||
		!editor.Capabilities.CanEdit || !editor.Capabilities.CanComment {
		t.Fatalf("editor access metadata is incorrect: %#v", editor)
	}

	public := apimodel.FromWorkspaceAccess(store.Workspace{ID: "ws_2"}, "")
	if public.IsOwner || public.Role != nil || !public.Capabilities.CanView ||
		public.Capabilities.CanEdit || public.Capabilities.CanComment {
		t.Fatalf("public viewer access metadata is incorrect: %#v", public)
	}
}
