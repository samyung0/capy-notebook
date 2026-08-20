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

func TestIngestJobPayloadPinsActorAndModels(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)

	raw, err := s.ingestJobPayload(ctx, "u_actor", map[string]any{
		"fileId": "f_1", "workspaceId": "ws_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["actorUserId"] != "u_actor" {
		t.Fatalf("actor missing: %v", payload)
	}
	for _, key := range []string{
		"ingestModelKey", "ingestModelVersion",
		"visionModelKey", "visionModelVersion",
	} {
		if payload[key] == nil || payload[key] == "" || payload[key] == 0.0 {
			t.Fatalf("pin %s missing: %v", key, payload)
		}
	}
	// Embedding is the workspace's, not the job's. A per-job copy could only
	// duplicate the workspace row or contradict it.
	if _, ok := payload["embeddingModelKey"]; ok {
		t.Fatalf("embedding pin does not belong on an ingest job: %v", payload)
	}
}

// The upload must fail rather than enqueue work nobody can be charged for: the
// worker settles against actorUserId, so a job without one runs a GPU parse,
// captions and embeddings for free.
func TestIngestJobPayloadRefusesWithoutActor(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)

	if _, err := s.ingestJobPayload(ctx, "", map[string]any{
		"fileId": "f_1", "workspaceId": "ws_1",
	}); !errors.Is(err, ErrIngestUnpinnable) {
		t.Fatalf("expected ErrIngestUnpinnable, got %v", err)
	}
}

// Same reasoning for the models: without pins the worker would run on whatever
// its own current defaults are and settle at those rates.
func TestIngestJobPayloadRefusesWithoutRegistry(t *testing.T) {
	s := openAccessTestStore(t)
	if _, err := s.ingestJobPayload(context.Background(), "u_actor", map[string]any{
		"fileId": "f_1", "workspaceId": "ws_1",
	}); !errors.Is(err, ErrIngestUnpinnable) {
		t.Fatalf("expected ErrIngestUnpinnable, got %v", err)
	}
}

// A workspace is bound to one vector space for life, and cloning copies vectors
// verbatim, so the clone has to inherit the source's pin instead of picking up
// whatever the registry default has moved to.
func TestCloneInheritsSourceEmbeddingPin(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	src, err := s.CreateWorkspace(ctx, userID, "Source", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE workspaces SET embedding_model_key='qwen-embed', embedding_model_version=7
		   WHERE id=$1`, src.ID); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneWorkspace(ctx, userID, src.ID)
	if err != nil {
		t.Fatal(err)
	}

	var key string
	var version int
	if err := s.pool.QueryRow(ctx,
		`SELECT embedding_model_key, embedding_model_version FROM workspaces WHERE id=$1`,
		clone.ID,
	).Scan(&key, &version); err != nil {
		t.Fatal(err)
	}
	if key != "qwen-embed" || version != 7 {
		t.Fatalf("clone did not inherit the source pin: %s v%d", key, version)
	}
}

func TestSetModelPrefsRejectsEmpty(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	empty := ""
	for _, surface := range []string{"chat", "generate", "editor", "quiz"} {
		var chat, generate, editor, quiz *string
		switch surface {
		case "chat":
			chat = &empty
		case "generate":
			generate = &empty
		case "editor":
			editor = &empty
		case "quiz":
			quiz = &empty
		}
		if err := s.SetModelPrefs(ctx, userID, chat, generate, editor, quiz); !errors.Is(err, ErrModelKeyRequired) {
			t.Fatalf("%s: got %v", surface, err)
		}
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
	if me.ChatModelKey == "" || me.GenerateModelKey == "" || me.EditorModelKey == "" || me.QuizModelKey == "" {
		t.Fatalf("prefs empty: %#v", me)
	}
}

func TestSetModelPrefsAcceptsBrowserQuizKey(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	key := "browser:ternary-1.7b"
	if err := s.SetModelPrefs(ctx, userID, nil, nil, nil, &key); err != nil {
		t.Fatal(err)
	}
	me, err := s.Me(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if me.QuizModelKey != key {
		t.Fatalf("quiz pref = %q", me.QuizModelKey)
	}
	if err := s.SetModelPrefs(ctx, userID, &key, nil, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("browser key on chat: %v", err)
	}
}
