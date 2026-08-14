package store

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/evonotes/server/internal/models"
)

func TestCreateConversationPinsTheResolvedChatModel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, "Pin", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}

	rest, err := s.CreateConversation(ctx, userID, ws.ID, "rest")
	if err != nil {
		t.Fatal(err)
	}
	stream, err := s.CreateConversation(ctx, userID, ws.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if rest.ModelKey == "" || rest.ModelVersion <= 0 {
		t.Fatalf("REST conversation unpinned: %#v", rest)
	}
	if rest.ModelKey != stream.ModelKey || rest.ModelVersion != stream.ModelVersion {
		t.Fatalf("REST pin %s v%d != stream pin %s v%d",
			rest.ModelKey, rest.ModelVersion, stream.ModelKey, stream.ModelVersion)
	}

	loaded, err := s.GetConversation(ctx, userID, rest.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ModelKey != rest.ModelKey || loaded.ModelVersion != rest.ModelVersion {
		t.Fatalf("GetConversation dropped the pin: %#v", loaded)
	}
}

func TestIngestJobPayloadPinsActorAndFrozenModels(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)

	raw := s.ingestJobPayload(ctx, "u_actor", map[string]any{
		"fileId": "f_1", "workspaceId": "ws_1",
	})
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["actorUserId"] != "u_actor" {
		t.Fatalf("actor missing: %v", payload)
	}
	for _, key := range []string{
		"ingestModelKey", "ingestModelVersion",
		"embeddingModelKey", "embeddingModelVersion",
		"visionModelKey", "visionModelVersion",
	} {
		if payload[key] == nil || payload[key] == "" || payload[key] == 0.0 {
			t.Fatalf("pin %s missing: %v", key, payload)
		}
	}
}
