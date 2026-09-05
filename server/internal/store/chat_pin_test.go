package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

var (
	flashModelRef = models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}
	proModelRef   = models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-pro"}
	embedModelRef = models.Ref{ProviderSlug: "deepinfra", ModelSlug: "Qwen/Qwen3-Embedding-4B"}
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
	cfg, err := reg.ResolveUser(ctx, flashModelRef, models.SlotChat)
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := s.StartAssistantMessage(ctx, userID, conv.ID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if assistant.ProviderSlug != cfg.ProviderSlug || assistant.ModelSlug != cfg.ModelSlug || assistant.ModelVersion != cfg.Version {
		t.Fatalf("start dropped the pin: %#v", assistant)
	}
	if err := s.FinalizeAssistantMessage(ctx, assistant.ID, "hi", "complete", 1, nil, "", nil); err != nil {
		t.Fatal(err)
	}
	msgs, err := s.ListMessages(ctx, userID, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("messages: %#v", msgs)
	}
	if msgs[0].ProviderSlug != cfg.ProviderSlug || msgs[0].ModelSlug != cfg.ModelSlug || msgs[0].ModelVersion != cfg.Version {
		t.Fatalf("finalize dropped the pin: %#v", msgs[0])
	}
	if msgs[0].ModelDisplayName == "" {
		t.Fatal("expected display name on the assistant row")
	}
}

func TestConversationPromptLoadsEveryMessageAfterCheckpoint(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, "Long chat", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	conv, err := s.CreateConversation(ctx, userID, ws.ID, "history")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddUserMessage(ctx, userID, conv.ID, "checkpoint question"); err != nil {
		t.Fatal(err)
	}
	cfg, err := reg.ResolveUser(ctx, flashModelRef, models.SlotChat)
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := s.StartAssistantMessage(ctx, userID, conv.ID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.FinalizeAssistantMessage(ctx, assistant.ID, "checkpoint answer", "complete", 1, nil, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.PersistCheckpoint(ctx, conv.ID, ConversationCheckpoint{
		ThroughMessageID: assistant.ID,
		Summary:          "checkpoint memory",
		ProviderSlug:     cfg.ProviderSlug,
		ModelSlug:        cfg.ModelSlug,
		ModelVersion:     cfg.Version,
		EstimatedTokens:  10,
	}); err != nil {
		t.Fatal(err)
	}
	for i := range 205 {
		if _, err := s.AddUserMessage(ctx, userID, conv.ID, fmt.Sprintf("turn-%03d", i)); err != nil {
			t.Fatal(err)
		}
	}

	prompt, err := s.ConversationPrompt(ctx, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(prompt.History) != 205 {
		t.Fatalf("history length = %d, want 205", len(prompt.History))
	}
	if prompt.History[0].Content != "turn-000" || prompt.History[204].Content != "turn-204" {
		t.Fatalf("history was clipped or reordered: first=%q last=%q", prompt.History[0].Content, prompt.History[204].Content)
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
		"ingestProviderSlug", "ingestModelSlug", "ingestModelVersion",
		"captioningProviderSlug", "captioningModelSlug", "captioningModelVersion",
	} {
		if payload[key] == nil || payload[key] == "" || payload[key] == 0.0 {
			t.Fatalf("pin %s missing: %v", key, payload)
		}
	}
	// Embedding is the workspace's, not the job's. A per-job copy could only
	// duplicate the workspace row or contradict it.
	if _, ok := payload["embeddingModelSlug"]; ok {
		t.Fatalf("embedding pin does not belong on an ingest job: %v", payload)
	}
}

// The upload must fail rather than enqueue work nobody can be charged for: the
// worker settles against actorUserId, so a job without one runs a document parse,
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
		`UPDATE workspaces SET embedding_provider_slug=$2, embedding_model_slug=$3, embedding_model_version=7
		   WHERE id=$1`, src.ID, embedModelRef.ProviderSlug, embedModelRef.ModelSlug); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneWorkspace(ctx, userID, src.ID)
	if err != nil {
		t.Fatal(err)
	}

	var providerSlug, modelSlug string
	var version int
	if err := s.pool.QueryRow(ctx,
		`SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version FROM workspaces WHERE id=$1`,
		clone.ID,
	).Scan(&providerSlug, &modelSlug, &version); err != nil {
		t.Fatal(err)
	}
	if (models.Ref{ProviderSlug: providerSlug, ModelSlug: modelSlug}) != embedModelRef || version != 7 {
		t.Fatalf("clone did not inherit the source pin: %s/%s v%d", providerSlug, modelSlug, version)
	}
}

func TestCreateWorkspacePinsLiveEmbeddingDefault(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)

	first, err := s.CreateWorkspace(ctx, userID, "First", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	var providerSlug, modelSlug string
	var version int
	if err := s.pool.QueryRow(ctx,
		`SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version FROM workspaces WHERE id=$1`,
		first.ID,
	).Scan(&providerSlug, &modelSlug, &version); err != nil {
		t.Fatal(err)
	}
	if (models.Ref{ProviderSlug: providerSlug, ModelSlug: modelSlug}) != embedModelRef || version != 1 {
		t.Fatalf("first workspace: %s/%s v%d", providerSlug, modelSlug, version)
	}

	altRef := models.Ref{ProviderSlug: "embedtest", ModelSlug: "alt-embed-" + first.ID}
	altPin := models.Pin{Ref: altRef, Version: 1}
	originalVectorTableForPin := vectorTableForPin
	vectorTableForPin = func(pin models.Pin) (string, error) {
		if pin == altPin {
			return "rag_chunk_vectors_2560", nil
		}
		return originalVectorTableForPin(pin)
	}
	t.Cleanup(func() { vectorTableForPin = originalVectorTableForPin })

	if _, err := s.pool.Exec(ctx, `
		UPDATE model_configs SET is_default_for='{}'
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedModelRef.ProviderSlug, embedModelRef.ModelSlug); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, slots,
			micros_per_input_token, micros_per_output_token,
			micros_per_cached_input_token, enabled, is_default_for
		) VALUES (1, 'Alt', 'Embed', $1, $2,
			true, false, 0, ARRAY[]::text[], '',
			'{"dimensions": 2560, "vector_table": "rag_chunk_vectors_2560"}'::jsonb,
			ARRAY['retrieval'], 99, 99, 0, true, ARRAY['retrieval'])`, altRef.ProviderSlug, altRef.ModelSlug); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE model_registry_state SET version = version + 1 WHERE id = true`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		deleteEmbeddingRow(t, s, altRef)
		if _, err := s.pool.Exec(context.Background(), `
			UPDATE model_configs SET is_default_for=ARRAY['retrieval']
			 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`,
			embedModelRef.ProviderSlug, embedModelRef.ModelSlug); err != nil {
			t.Errorf("restore the seeded embedding default: %v", err)
		}
		if _, err := s.pool.Exec(context.Background(), `
			UPDATE model_registry_state SET version = version + 1 WHERE id = true`); err != nil {
			t.Errorf("bump the registry version: %v", err)
		}
	})

	fresh, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(fresh)

	second, err := s.CreateWorkspace(ctx, userID, "Second", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version FROM workspaces WHERE id=$1`,
		second.ID,
	).Scan(&providerSlug, &modelSlug, &version); err != nil {
		t.Fatal(err)
	}
	if (models.Ref{ProviderSlug: providerSlug, ModelSlug: modelSlug}) != altRef || version != 1 {
		t.Fatalf("newWorkspaceEmbedding skipped the live default: %s/%s v%d", providerSlug, modelSlug, version)
	}

	oldRates, err := s.EmbeddingRates(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if oldRates.Model != embedModelRef || oldRates.MicrosPerInputToken != 50 {
		t.Fatalf("old workspace rates followed the new default: %#v", oldRates)
	}
	newRates, err := s.EmbeddingRates(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if newRates.Model != altRef || newRates.MicrosPerInputToken != 99 {
		t.Fatalf("new workspace rates: %#v", newRates)
	}
}

func TestEmbeddingRatesFailsWhenPinCannotResolve(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, "Broken pin", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.EmbeddingRates(ctx, ""); !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("empty workspace: %v", err)
	}

	if _, err := s.pool.Exec(ctx,
		`UPDATE workspaces SET embedding_provider_slug='ghost', embedding_model_slug='ghost-embed', embedding_model_version=1
		   WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EmbeddingRates(ctx, ws.ID); !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("unknown pin: %v", err)
	}
}

func TestSetModelPrefsRejectsEmpty(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	empty := models.Ref{}
	for _, slot := range []string{"chat", "generate", "editor", "quiz"} {
		var chat, generate, editor, quiz *models.Ref
		switch slot {
		case "chat":
			chat = &empty
		case "generate":
			generate = &empty
		case "editor":
			editor = &empty
		case "quiz":
			quiz = &empty
		}
		if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{
			ChatModel: chat, GenerateModel: generate, EditorModel: editor, QuizModel: quiz,
		}); !errors.Is(err, ErrModelRefRequired) {
			t.Fatalf("%s: got %v", slot, err)
		}
	}
}

func TestSetModelPrefsRevalidatesAfterWaitingForUserLock(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ref := models.Ref{ProviderSlug: "deepseek", ModelSlug: "prefs-race-" + uid("m")}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, slots,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		)
		SELECT 1, $2, $2, $1, $2,
		       platform_enabled, byok_enabled, context_window_tokens,
		       thinking_levels, default_thinking, params, ARRAY['chat']::text[],
		       micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
		       true, ARRAY[]::text[]
		  FROM model_configs
		 WHERE provider_slug=$3 AND model_slug=$4 AND version=1`, ref.ProviderSlug, ref.ModelSlug, proModelRef.ProviderSlug, proModelRef.ModelSlug); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	})

	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID); err != nil {
		t.Fatal(err)
	}

	result := make(chan error, 1)
	go func() {
		result <- s.SetModelPrefs(ctx, userID, ModelPrefsPatch{ChatModel: &ref})
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				 WHERE wait_event_type='Lock'
				   AND query LIKE '%deleted_at, deletion_requested_at%FOR UPDATE%'
			)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("preference update did not wait for the user lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE model_configs SET enabled=false WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale model preference: got %v", err)
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
	if me.ChatModel.Zero() || me.GenerateModel.Zero() || me.EditorModel.Zero() || me.QuizModel.Zero() {
		t.Fatalf("prefs empty: %#v", me)
	}
}

func TestAccountModelPrefsRequiresRegistry(t *testing.T) {
	s := openAccessTestStore(t)
	_, _, _, _, err := s.accountModelPrefs(context.Background())
	if !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("account prefs without registry: got %v", err)
	}
}

func TestSetModelPrefsAcceptsBrowserQuizRef(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ref := models.Ref{ProviderSlug: BrowserProviderSlug, ModelSlug: "ternary-1.7b"}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{QuizModel: &ref}); err != nil {
		t.Fatal(err)
	}
	me, err := s.Me(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if me.QuizModel != ref {
		t.Fatalf("quiz pref = %#v", me.QuizModel)
	}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{ChatModel: &ref}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("browser ref on chat: %v", err)
	}
}

func TestSetModelPrefsRejectsLockedUserKey(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ref := models.Ref{ProviderSlug: "openai", ModelSlug: "gpt-5.6-sol"}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{GenerateModel: &ref}); !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("locked byok: %v", err)
	}
}

func TestSetModelPrefsThinkingIsPerModel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	high := models.ThinkingHigh
	medium := "medium"

	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{
		ChatThinking: &high,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{
		ChatThinking: &medium,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invented thinking on deepseek: %v", err)
	}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{ChatModel: &proModelRef}); err != nil {
		t.Fatal(err)
	}
	prefs, err := s.UserLLMPrefs(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if got := prefs.Thinking(models.SlotChat); got != "" {
		t.Fatalf("pro inherited flash prefs: %s", got)
	}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{
		ChatThinking: &high,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetModelPrefs(ctx, userID, ModelPrefsPatch{ChatModel: &flashModelRef}); err != nil {
		t.Fatal(err)
	}
	prefs, err = s.UserLLMPrefs(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if got := prefs.Thinking(models.SlotChat); got != models.ThinkingHigh {
		t.Fatalf("flash prefs lost: %s", got)
	}
}

// deleteEmbeddingRow drops a retrieval row a test inserted. Every package in
// this module shares one database, so a row left behind is an unshipped
// embedding model for the packages that run next. protect_embedding_model_configs
// refuses plain deletes, hence the suppressed triggers.
func deleteEmbeddingRow(t *testing.T, s *Store, ref models.Ref) {
	t.Helper()
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Errorf("delete %s: %v", ref, err)
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
		t.Errorf("delete %s: %v", ref, err)
		return
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2`,
		ref.ProviderSlug, ref.ModelSlug); err != nil {
		t.Errorf("delete %s: %v", ref, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		t.Errorf("delete %s: %v", ref, err)
	}
}
