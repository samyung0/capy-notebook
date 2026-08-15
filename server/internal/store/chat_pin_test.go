package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/evonotes/server/internal/models"
)

func TestAssistantMessagePinsTheResolvedChatModel(t *testing.T) {
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

	conv, err := s.CreateConversation(ctx, userID, ws.ID, "rest")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := reg.ResolveUser(ctx, "deepseek-flash", models.SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := s.StartAssistantMessage(ctx, conv.ID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if assistant.ModelKey != cfg.Key || assistant.ModelVersion != cfg.Version {
		t.Fatalf("start dropped the pin: %#v", assistant)
	}
	if err := s.FinalizeAssistantMessage(ctx, assistant.ID, "hi", "complete", 1, nil, ""); err != nil {
		t.Fatal(err)
	}
	msgs, err := s.ListMessages(ctx, userID, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("messages: %#v", msgs)
	}
	if msgs[0].ModelKey != cfg.Key || msgs[0].ModelVersion != cfg.Version {
		t.Fatalf("finalize dropped the pin: %#v", msgs[0])
	}
	if msgs[0].ModelDisplayName == "" {
		t.Fatal("expected display name on the assistant row")
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

func TestSetModelPrefsRejectsEmpty(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	empty := ""
	if err := s.SetModelPrefs(ctx, userID, &empty, nil); !errors.Is(err, ErrModelKeyRequired) {
		t.Fatalf("got %v", err)
	}
}

func TestUpsertUserPopulatesRegistryDefaults(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	id := "u_prefs_" + uid("t")
	created, err := s.UpsertUserFromClerk(ctx, id, "Pref User", id+"@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("expected insert")
	}
	t.Cleanup(func() {
		_, _ = s.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	})
	me, err := s.Me(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if me.ChatModelKey == "" || me.GenerateModelKey == "" {
		t.Fatalf("prefs empty: %#v", me)
	}
}
