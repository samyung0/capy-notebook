package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/embeddingpins"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

func openRegistryTestTx(t *testing.T) (*RegistryStore, pgx.Tx) {
	t.Helper()
	dsn := integrationDSN(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	return NewRegistryStore(pool, pool), tx
}

func gridRequest(snapshot RegistrySnapshot) gridSaveRequest {
	type cellKey struct {
		model models.Ref
		slot  string
	}
	live := map[cellKey]CatalogConfig{}
	for _, config := range snapshot.Configs {
		if !config.Enabled {
			continue
		}
		for _, slot := range config.Slots {
			key := cellKey{model: config.Ref(), slot: slot}
			current, ok := live[key]
			if !ok || config.Version > current.Version {
				live[key] = config
			}
		}
	}
	request := gridSaveRequest{ExpectedVersion: snapshot.Version}
	for key, config := range live {
		request.Cells = append(request.Cells, GridCell{
			Row:  key.model,
			Slot: key.slot,
			Target: CellTarget{
				Kind:    "catalog",
				Model:   config.Ref(),
				Version: config.Version,
			},
			IsDefault: contains(config.IsDefaultFor, key.slot),
		})
	}
	sort.Slice(request.Cells, func(i, j int) bool {
		if request.Cells[i].Row == request.Cells[j].Row {
			return request.Cells[i].Slot < request.Cells[j].Slot
		}
		return request.Cells[i].Row.String() < request.Cells[j].Row.String()
	})
	return request
}

func draftFromConfig(id string, config CatalogConfig) gridDraft {
	return gridDraft{
		ID:                        id,
		ProviderName:              config.ProviderName,
		ModelName:                 config.ModelName,
		ProviderSlug:              config.ProviderSlug,
		ModelSlug:                 config.ModelSlug,
		PlatformEnabled:           config.PlatformEnabled,
		ByokEnabled:               config.ByokEnabled,
		ContextWindowTokens:       config.ContextWindowTokens,
		ThinkingLevels:            append([]string(nil), config.ThinkingLevels...),
		DefaultThinking:           config.DefaultThinking,
		Params:                    append(json.RawMessage(nil), config.Params...),
		Capabilities:              append([]string(nil), config.Capabilities...),
		MicrosPerInputToken:       config.MicrosPerInputToken,
		MicrosPerCachedInputToken: config.MicrosPerCachedInputToken,
		MicrosPerOutputToken:      config.MicrosPerOutputToken,
	}
}

func configByRef(t *testing.T, snapshot RegistrySnapshot, ref models.Ref) CatalogConfig {
	t.Helper()
	var found CatalogConfig
	for _, config := range snapshot.Configs {
		if config.Ref() == ref && config.Enabled && config.Version > found.Version {
			found = config
		}
	}
	if found.Ref().Zero() {
		t.Fatalf("enabled config %q not found", ref)
	}
	return found
}

func TestRegistrySaveInsertsVersionAndDisablesOldWithoutChangingPreferences(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	request.ActorID = "ops-user"
	current := configByRef(t, snapshot, models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"})
	draft := draftFromConfig("edited-flash", current)
	draft.ModelName = "Flash edited"
	request.Drafts = []gridDraft{draft}
	for index := range request.Cells {
		if request.Cells[index].Target.Model == current.Ref() &&
			request.Cells[index].Target.Version == current.Version {
			request.Cells[index].Target = CellTarget{
				Kind:    "draft",
				DraftID: draft.ID,
			}
		}
	}
	var beforePreferences [8]string
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug
		 FROM users WHERE id='u_1'`,
	).Scan(
		&beforePreferences[0], &beforePreferences[1], &beforePreferences[2], &beforePreferences[3],
		&beforePreferences[4], &beforePreferences[5], &beforePreferences[6], &beforePreferences[7],
	); err != nil {
		t.Fatal(err)
	}
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.InsertedRows != 1 || result.DisabledRows < 1 || result.Version != snapshot.Version+1 {
		t.Fatalf("unexpected save result: %+v", result)
	}
	var oldEnabled bool
	var oldSlots []string
	if err := tx.QueryRow(ctx, `
		SELECT enabled, slots FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`,
		current.ProviderSlug, current.ModelSlug, current.Version,
	).Scan(&oldEnabled, &oldSlots); err != nil {
		t.Fatal(err)
	}
	if oldEnabled {
		t.Fatal("old immutable version remained enabled")
	}
	if !sameStringSet(oldSlots, current.Slots) {
		t.Fatalf("old version was mutated: got %v want %v", oldSlots, current.Slots)
	}
	var newVersion int
	if err := tx.QueryRow(ctx, `
		SELECT max(version) FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND enabled`, current.ProviderSlug, current.ModelSlug,
	).Scan(&newVersion); err != nil {
		t.Fatal(err)
	}
	if newVersion <= current.Version {
		t.Fatalf("new version was not inserted: %d", newVersion)
	}
	var createdBy, updatedBy, oldUpdatedBy string
	if err := tx.QueryRow(ctx, `
		SELECT created_by, updated_by FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`,
		current.ProviderSlug, current.ModelSlug, newVersion,
	).Scan(&createdBy, &updatedBy); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT updated_by FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`,
		current.ProviderSlug, current.ModelSlug, current.Version,
	).Scan(&oldUpdatedBy); err != nil {
		t.Fatal(err)
	}
	if createdBy != "ops-user" || updatedBy != "ops-user" || oldUpdatedBy != "ops-user" {
		t.Fatalf("audit actors = new %q/%q old %q", createdBy, updatedBy, oldUpdatedBy)
	}
	for _, slot := range snapshot.Slots {
		var defaults int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM model_configs
			WHERE enabled AND $1 = ANY(is_default_for)`, slot,
		).Scan(&defaults); err != nil {
			t.Fatal(err)
		}
		if defaults != 1 {
			t.Fatalf("slot %s has %d defaults after Save", slot, defaults)
		}
	}
	var afterPreferences [8]string
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug
		 FROM users WHERE id='u_1'`,
	).Scan(
		&afterPreferences[0], &afterPreferences[1], &afterPreferences[2], &afterPreferences[3],
		&afterPreferences[4], &afterPreferences[5], &afterPreferences[6], &afterPreferences[7],
	); err != nil {
		t.Fatal(err)
	}
	if afterPreferences != beforePreferences {
		t.Fatalf(
			"same-key version edit changed preferences: %q -> %q",
			beforePreferences, afterPreferences,
		)
	}
}

func TestRegistrySavePreservesAuditFieldsOnUnchangedRows(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	unchanged := configByRef(t, snapshot, models.Ref{
		ProviderSlug: "deepseek",
		ModelSlug:    "deepseek-v4-flash-vision-exp",
	})
	var beforeUpdatedAt time.Time
	var beforeUpdatedBy string
	if err := tx.QueryRow(ctx, `
		SELECT updated_at, updated_by FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`,
		unchanged.ProviderSlug, unchanged.ModelSlug, unchanged.Version,
	).Scan(&beforeUpdatedAt, &beforeUpdatedBy); err != nil {
		t.Fatal(err)
	}

	request := gridRequest(snapshot)
	request.ActorID = "unrelated-operator"
	if _, err := registry.saveTx(ctx, tx, request); err != nil {
		t.Fatal(err)
	}

	var afterUpdatedAt time.Time
	var afterUpdatedBy string
	if err := tx.QueryRow(ctx, `
		SELECT updated_at, updated_by FROM model_configs
		WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`,
		unchanged.ProviderSlug, unchanged.ModelSlug, unchanged.Version,
	).Scan(&afterUpdatedAt, &afterUpdatedBy); err != nil {
		t.Fatal(err)
	}
	if !afterUpdatedAt.Equal(beforeUpdatedAt) || afterUpdatedBy != beforeUpdatedBy {
		t.Fatalf(
			"unchanged audit fields = %s/%q, want %s/%q",
			afterUpdatedAt, afterUpdatedBy, beforeUpdatedAt, beforeUpdatedBy,
		)
	}
}

func TestRegistrySaveRemapsRemovedPrefToDefault(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	proRef := models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-pro"}
	filtered := request.Cells[:0]
	for _, cell := range request.Cells {
		if cell.Row == proRef && cell.Slot == "chat" {
			continue
		}
		filtered = append(filtered, cell)
	}
	request.Cells = filtered
	userID := "ops_registry_" + time.Now().UTC().Format("150405000000")
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, name, email, chat_model_provider_slug, chat_model_slug)
		VALUES ($1, 'Ops Registry Test', $2, $3, $4)`,
		userID, userID+"@example.test", proRef.ProviderSlug, proRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemappedUsers != 1 {
		t.Fatalf("unexpected remap result: %+v", result)
	}
	var preference models.Ref
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_provider_slug, chat_model_slug FROM users WHERE id=$1`, userID,
	).Scan(&preference.ProviderSlug, &preference.ModelSlug); err != nil {
		t.Fatal(err)
	}
	if preference != (models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}) {
		t.Fatalf("preference was not remapped: %q", preference)
	}
	var emails int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM email_outbox WHERE user_id=$1`, userID,
	).Scan(&emails); err != nil {
		t.Fatal(err)
	}
	if emails != 0 {
		t.Fatalf("remap must not send mail, got %d", emails)
	}
}

func TestRegistrySaveRevalidatesExistingRowsAgainstSlotRequirements(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	suffix := time.Now().UTC().Format("150405000000")
	ref := models.Ref{ProviderSlug: "deepseek", ModelSlug: "uncertified-" + suffix}
	// An enabled chat row whose exact slug has no agentic-loop certificate can
	// only exist if the certificate was revoked after the row was written.
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params,
			slots, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			1, 'Stale', 'Chat', $1, $2,
			true, false, 100000,
			ARRAY['instant']::text[], 'instant', '{}'::jsonb,
			ARRAY['chat'], 1, 1, 1, true, '{}'
		)`, ref.ProviderSlug, ref.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	// Submitting the grid unchanged keeps the row on chat via an existing
	// target, which is the path a stale row would use to bypass the gate.
	_, err = registry.saveTx(ctx, tx, gridRequest(snapshot))
	var coded *ValidationError
	if !errors.As(err, &coded) || coded.Code != "agentic_loop_not_certified" ||
		coded.Slot != models.SlotChat || coded.ModelSlug != ref.ModelSlug {
		t.Fatalf("unchanged save with an uncertified chat row = %#v", err)
	}
}

func TestRegistrySaveRemapsEveryUserPreferenceAndDisablesRetiredRows(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	suffix := time.Now().UTC().Format("150405000000")
	retiredRef := models.Ref{ProviderSlug: "deepseek", ModelSlug: "retired-" + suffix}
	userID := "ops_all_prefs_" + suffix
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params,
			slots, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			1, 'Retired', 'Model', $1, $2,
			true, false, 100000,
			ARRAY['instant']::text[], 'instant', '{}'::jsonb,
			ARRAY['chat','generate','editor','quiz'], 1, 1, 1, true, '{}'
		)`, retiredRef.ProviderSlug, retiredRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (
			id, name, email,
			chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug
		) VALUES ($1, 'All Prefs', $2, $3, $4, $3, $4, $3, $4, $3, $4)`,
		userID, userID+"@example.test", retiredRef.ProviderSlug, retiredRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	filtered := request.Cells[:0]
	for _, cell := range request.Cells {
		if cell.Row == retiredRef {
			continue
		}
		filtered = append(filtered, cell)
	}
	request.Cells = filtered
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemappedUsers != 4 || result.DisabledRows < 1 {
		t.Fatalf("unexpected all-slot remap result: %+v", result)
	}
	var preferences [4]models.Ref
	if err := tx.QueryRow(ctx, `
		SELECT chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug
		FROM users WHERE id=$1`, userID,
	).Scan(
		&preferences[0].ProviderSlug, &preferences[0].ModelSlug,
		&preferences[1].ProviderSlug, &preferences[1].ModelSlug,
		&preferences[2].ProviderSlug, &preferences[2].ModelSlug,
		&preferences[3].ProviderSlug, &preferences[3].ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	for index, preference := range preferences {
		if preference != (models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}) {
			t.Fatalf("preference %d = %q, want flash", index, preference)
		}
	}
	var enabled bool
	if err := tx.QueryRow(ctx,
		`SELECT enabled FROM model_configs WHERE provider_slug=$1 AND model_slug=$2`, retiredRef.ProviderSlug, retiredRef.ModelSlug,
	).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("retired model row remained enabled")
	}
	var emailCount int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM email_outbox WHERE user_id=$1`, userID,
	).Scan(&emailCount); err != nil {
		t.Fatal(err)
	}
	if emailCount != 0 {
		t.Fatalf("remap must not send mail, got %d", emailCount)
	}
}

func TestRegistrySaveRejectsStaleVersionWithCurrentSnapshot(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	request.ExpectedVersion--
	_, err = registry.saveTx(ctx, tx, request)
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected registry conflict, got %v", err)
	}
	if conflict.Current.Version != snapshot.Version {
		t.Fatalf(
			"conflict snapshot version = %d, want %d",
			conflict.Current.Version,
			snapshot.Version,
		)
	}
}

func TestRegistryCompileRefusesMissingDefaultAliasAndEmbeddingRewrite(t *testing.T) {
	snapshot := RegistrySnapshot{
		Version: 1,
		Slots:   models.AllSlots(),
		Configs: []CatalogConfig{{
			ProviderSlug: "embedtest", ModelSlug: "embed-model",
			Version: 1, Enabled: true, Slots: []string{"retrieval"}, IsDefaultFor: []string{"retrieval"},
			Capabilities: []string{models.CapabilityEmbedding},
		}},
	}
	request := gridRequest(snapshot)
	request.Cells[0].Row = models.Ref{ProviderSlug: "embedtest", ModelSlug: "alias"}
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected alias validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Cells = nil
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected default validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Cells[0].Slot = "captioning"
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected embedding immutability validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Drafts = []gridDraft{{
		ID:              "new-embedding",
		ProviderName:    "New",
		ModelName:       "Embedding",
		ProviderSlug:    "deepinfra",
		ModelSlug:       "qwen/qwen3-embedding-8b",
		PlatformEnabled: true,
		Params: json.RawMessage(
			`{"dimensions":2560,"vector_table":"rag_chunk_vectors_new"}`,
		),
		MicrosPerInputToken: 1,
	}}
	request.Cells[0].Target = CellTarget{
		Kind: "draft", DraftID: "new-embedding",
	}
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected embedding draft refusal, got %v", err)
	}
}

func TestActiveDraftRejectsEmbeddingHopChange(t *testing.T) {
	t.Parallel()
	current := CatalogConfig{
		Version: 1, ProviderName: "Qwen", ModelName: "Embed",
		ProviderSlug:        "deepinfra",
		ModelSlug:           models.SeededHopEmbedSlug,
		PlatformEnabled:     true,
		ContextWindowTokens: 8192,
		Params: json.RawMessage(
			`{"dimensions":2560,"vector_table":"rag_chunk_vectors_2560"}`,
		),
		Slots:               []string{models.SlotRetrieval},
		Capabilities:        []string{models.CapabilityEmbedding},
		MicrosPerInputToken: 50, Enabled: true,
		IsDefaultFor: []string{models.SlotRetrieval},
	}
	request := RegistrySaveRequest{
		Revision: 7,
		Active: []DraftConfig{{
			ProviderSlug: current.ProviderSlug, ProviderName: current.ProviderName,
			ModelName: current.ModelName,
			ModelSlug: "deepseek-v4-flash", PlatformEnabled: current.PlatformEnabled,
			ContextWindowTokens: current.ContextWindowTokens, Params: current.Params,
			Slots: current.Slots, Capabilities: current.Capabilities, DefaultFor: current.IsDefaultFor,
			Rates: CreditRates{InputMicros: current.MicrosPerInputToken},
		}},
	}
	_, err := activeToGrid(request, RegistrySnapshot{
		Version: 7, Configs: []CatalogConfig{current},
	})
	if !IsValidation(err) {
		t.Fatalf("embedding hop change = %v, want validation", err)
	}
}

func TestEmbeddingDefaultEligibilityRefusesInvalidPinsAndTables(t *testing.T) {
	_, tx := openRegistryTestTx(t)
	ctx := context.Background()
	base := CatalogConfig{
		ProviderSlug: "deepinfra", ModelSlug: models.SeededHopEmbedSlug,
		Version: 1, Enabled: true,
		Slots:        []string{models.SlotRetrieval},
		Capabilities: []string{models.CapabilityEmbedding},
		Params: json.RawMessage(
			`{"dimensions":2560,"vector_table":"rag_chunk_vectors_2560"}`,
		),
	}
	eligible, reason, err := embeddingEligibility(ctx, tx, base)
	if err != nil || !eligible || reason != "" {
		t.Fatalf("seeded embedding eligibility = %v, %q, %v", eligible, reason, err)
	}

	missingTableParam := base
	missingTableParam.Params = json.RawMessage(`{"dimensions":2560}`)
	eligible, reason, err = embeddingEligibility(ctx, tx, missingTableParam)
	if err != nil || eligible || !containsText(reason, "params.vector_table") {
		t.Fatalf("missing vector_table eligibility = %v, %q, %v", eligible, reason, err)
	}

	notAllowed := base
	notAllowed.ProviderSlug = "other"
	eligible, reason, err = embeddingEligibility(ctx, tx, notAllowed)
	if err != nil || eligible || !containsText(reason, "allowlist") {
		t.Fatalf("non-allowlisted eligibility = %v, %q, %v", eligible, reason, err)
	}

	missingTablePin := models.Pin{Ref: models.Ref{ProviderSlug: "embedtest", ModelSlug: "missing-table"}, Version: 1}
	originalLookup := embeddingPinLookup
	embeddingPinLookup = func(pin models.Pin) (embeddingpins.Spec, bool) {
		if pin == missingTablePin {
			return embeddingpins.Spec{
				VectorTable: "rag_chunk_vectors_missing_ops",
				Dimensions:  2560,
			}, true
		}
		return originalLookup(pin)
	}
	t.Cleanup(func() { embeddingPinLookup = originalLookup })
	missingTable := base
	missingTable.ProviderSlug = missingTablePin.ProviderSlug
	missingTable.ModelSlug = missingTablePin.ModelSlug
	missingTable.Params = json.RawMessage(
		`{"dimensions":2560,"vector_table":"rag_chunk_vectors_missing_ops"}`,
	)
	eligible, reason, err = embeddingEligibility(ctx, tx, missingTable)
	if err != nil || eligible || !containsText(reason, "does not exist") {
		t.Fatalf("missing table eligibility = %v, %q, %v", eligible, reason, err)
	}
}

func TestRegistrySaveMovesEmbeddingDefaultOnlyToPreShippedAllowedRow(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	suffix := time.Now().UTC().Format("150405000000")
	modelRef := models.Ref{ProviderSlug: "embedtest", ModelSlug: "ops-embed-" + suffix}
	table := "rag_chunk_vectors_ops_" + suffix
	pin := models.Pin{Ref: modelRef, Version: 1}
	originalLookup := embeddingPinLookup
	embeddingPinLookup = func(candidate models.Pin) (embeddingpins.Spec, bool) {
		if candidate == pin {
			return embeddingpins.Spec{VectorTable: table, Dimensions: 2560}, true
		}
		return originalLookup(candidate)
	}
	t.Cleanup(func() { embeddingPinLookup = originalLookup })
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`CREATE TABLE %s (chunk_id text PRIMARY KEY)`,
		pgx.Identifier{table}.Sanitize(),
	)); err != nil {
		t.Fatal(err)
	}
	params := fmt.Sprintf(
		`{"dimensions":2560,"vector_table":%q}`, table,
	)
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, slots, capabilities,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			1, 'Ops', 'Embed', $1, $2,
			true, false, 0, ARRAY[]::text[], '', $3::jsonb, ARRAY['retrieval'], ARRAY['embedding'],
			50, 0, 0, true, ARRAY[]::text[]
		)`, modelRef.ProviderSlug, modelRef.ModelSlug, params,
	); err != nil {
		t.Fatal(err)
	}
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	for index := range request.Cells {
		cell := &request.Cells[index]
		if cell.Slot != models.SlotRetrieval {
			continue
		}
		cell.IsDefault = cell.Row == modelRef
	}
	if _, err := registry.saveTx(ctx, tx, request); !IsValidation(err) {
		t.Fatalf("embedding retarget without acknowledgement = %v", err)
	}
	request.EmbeddingAcknowledged = true
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.InsertedRows != 0 {
		t.Fatalf("embedding default move inserted %d rows", result.InsertedRows)
	}
	rows, err := tx.Query(ctx, `
		SELECT provider_slug, model_slug, enabled, is_default_for, params
		FROM model_configs
		WHERE (provider_slug=$1 AND model_slug=$2)
		   OR (provider_slug=$3 AND model_slug=$4)
		ORDER BY provider_slug, model_slug`,
		"deepinfra", models.SeededHopEmbedSlug, modelRef.ProviderSlug, modelRef.ModelSlug)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[models.Ref]CatalogConfig{}
	for rows.Next() {
		var config CatalogConfig
		if err := rows.Scan(
			&config.ProviderSlug, &config.ModelSlug, &config.Enabled,
			&config.IsDefaultFor, &config.Params,
		); err != nil {
			t.Fatal(err)
		}
		seen[config.Ref()] = config
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	old := seen[models.Ref{ProviderSlug: "deepinfra", ModelSlug: models.SeededHopEmbedSlug}]
	moved := seen[modelRef]
	if !old.Enabled || !moved.Enabled {
		t.Fatalf("embedding rows were disabled: old=%v new=%v", old.Enabled, moved.Enabled)
	}
	if contains(old.IsDefaultFor, models.SlotRetrieval) ||
		!contains(moved.IsDefaultFor, models.SlotRetrieval) {
		t.Fatalf("embedding defaults not moved: old=%v new=%v",
			old.IsDefaultFor, moved.IsDefaultFor)
	}
	if moved.Ref() != modelRef ||
		!sameJSONTest(moved.Params, json.RawMessage(params)) {
		t.Fatalf("embedding identity was rewritten: %+v", moved)
	}
}

func TestBindEliteLLMDraftRejectsMarketplaceHop(t *testing.T) {
	draft := gridDraft{
		ProviderSlug:    "deepinfra",
		ModelSlug:       "deepseek/deepseek-v4-flash",
		PlatformEnabled: true,
	}
	err := bindEliteLLMDraft(&draft, nil)
	if !IsValidation(err) {
		t.Fatalf("hop bind = %v, want validation", err)
	}
	var coded *ValidationError
	if !errors.As(err, &coded) || coded.Code != "hop_not_allowed" {
		t.Fatalf("hop bind = %#v", err)
	}
}

func TestBindEliteLLMDraftRejectsNonCanonicalSlugs(t *testing.T) {
	for _, draft := range []gridDraft{
		{ProviderSlug: " deepseek", ModelSlug: "deepseek-v4-pro"},
		{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-pro "},
	} {
		if err := bindEliteLLMDraft(&draft, nil); !IsValidation(err) {
			t.Fatalf("bind %q = %v, want validation", draft.Ref(), err)
		}
	}
}

func TestBindEliteLLMDraftAllowsFirstPartyAndSeededEmbed(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	t.Setenv("DEEPINFRA_API_KEY", "sk-test")
	flash := gridDraft{
		ProviderSlug:    "deepseek",
		ModelSlug:       "deepseek-v4-flash",
		PlatformEnabled: true,
		ByokEnabled:     true,
		ThinkingLevels:  []string{"instant", "low", "mid", "high", "max"},
		DefaultThinking: "instant",
	}
	if err := bindEliteLLMDraft(&flash, []string{models.SlotChat}); err != nil {
		t.Fatalf("flash bind: %v", err)
	}
	embed := gridDraft{
		ProviderSlug:    models.ProviderDeepInfra,
		ModelSlug:       models.SeededHopEmbedSlug,
		PlatformEnabled: true,
		Capabilities:    []string{models.CapabilityEmbedding},
	}
	if err := bindEliteLLMDraft(&embed, []string{models.SlotRetrieval}); err != nil {
		t.Fatalf("seeded embed bind: %v", err)
	}
}

func TestBindEliteLLMDraftAllowsOnlyPlatformRoutedGLM(t *testing.T) {
	t.Setenv("DEEPINFRA_API_KEY", "sk-test")
	glm := gridDraft{
		ProviderSlug:    "zai",
		ModelSlug:       "glm-5.3-flash",
		PlatformEnabled: true,
		ThinkingLevels:  []string{"low", "high", "max"},
		DefaultThinking: "max",
	}
	if err := bindEliteLLMDraft(&glm, nil); err != nil {
		t.Fatalf("routed GLM bind: %v", err)
	}
	glm.ByokEnabled = true
	if err := bindEliteLLMDraft(&glm, nil); !IsValidation(err) {
		t.Fatalf("routed GLM BYOK bind = %v, want validation", err)
	}
}

func TestBindEliteLLMDraftRequiresPlatformEnv(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "")
	draft := gridDraft{
		ProviderSlug:    "deepseek",
		ModelSlug:       "deepseek-v4-flash",
		PlatformEnabled: true,
		ThinkingLevels:  []string{"instant"},
		DefaultThinking: "instant",
	}
	err := bindEliteLLMDraft(&draft, nil)
	var coded *ValidationError
	if !errors.As(err, &coded) || coded.Code != "missing_platform_env" {
		t.Fatalf("missing env bind = %#v", err)
	}
}

func TestBindEliteLLMDraftAppliesAgenticLoopSlotPolicy(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	draft := gridDraft{
		ProviderSlug:    "anthropic",
		ModelSlug:       "claude-not-certified",
		PlatformEnabled: true,
		ThinkingLevels:  []string{"high"},
		DefaultThinking: "high",
	}
	err := bindEliteLLMDraft(&draft, []string{models.SlotChat})
	var coded *ValidationError
	if !errors.As(err, &coded) || coded.Code != "agentic_loop_not_certified" {
		t.Fatalf("uncertified agentic-loop bind = %#v", err)
	}
	if err := bindEliteLLMDraft(&draft, []string{models.SlotChat}); err == nil {
		t.Fatal("already-on-chat re-save bypassed certification")
	}
	if err := bindEliteLLMDraft(&draft, []string{models.SlotGenerate}); err != nil {
		t.Fatalf("non-agentic slot required certification: %v", err)
	}
}

func TestBindEliteLLMDraftRequiresSlotCapabilities(t *testing.T) {
	t.Setenv("DEEPINFRA_API_KEY", "sk-test")
	draft := gridDraft{
		ProviderSlug:    "deepinfra",
		ModelSlug:       "Qwen/Qwen3-Embedding-4B",
		PlatformEnabled: true,
	}
	err := bindEliteLLMDraft(&draft, []string{models.SlotRetrieval})
	var coded *ValidationError
	if !errors.As(err, &coded) || coded.Code != "capability_missing" || coded.Slot != models.SlotRetrieval {
		t.Fatalf("retrieval without embedding capability = %#v", err)
	}
	draft.Capabilities = []string{models.CapabilityEmbedding}
	if err := bindEliteLLMDraft(&draft, []string{models.SlotRetrieval}); err != nil {
		t.Fatalf("embedding-capable row refused retrieval: %v", err)
	}
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	text := gridDraft{
		ProviderSlug:    "deepseek",
		ModelSlug:       "deepseek-v4-pro",
		PlatformEnabled: true,
		ThinkingLevels:  []string{"instant"},
		DefaultThinking: "instant",
	}
	err = bindEliteLLMDraft(&text, []string{models.SlotCaptioning})
	if !errors.As(err, &coded) || coded.Code != "capability_missing" {
		t.Fatalf("captioning without vision capability = %#v", err)
	}
	if _, err := uniqueCapabilities([]string{models.CapabilityAgenticLoop}); !IsValidation(err) {
		t.Fatalf("operator-set agentic_loop = %v, want validation", err)
	}
}

func containsText(value, part string) bool {
	return strings.Contains(value, part)
}

func sameJSONTest(left, right json.RawMessage) bool {
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil ||
		json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	return reflect.DeepEqual(leftValue, rightValue)
}
