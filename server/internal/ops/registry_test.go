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

	"github.com/evonotes/server/internal/embeddingpins"
	"github.com/evonotes/server/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
		key     string
		surface string
	}
	live := map[cellKey]CatalogConfig{}
	for _, config := range snapshot.Configs {
		if !config.Enabled {
			continue
		}
		for _, surface := range config.Surfaces {
			key := cellKey{key: config.ModelKey, surface: surface}
			current, ok := live[key]
			if !ok || config.Version > current.Version {
				live[key] = config
			}
		}
	}
	request := gridSaveRequest{ExpectedVersion: snapshot.Version}
	for key, config := range live {
		request.Cells = append(request.Cells, GridCell{
			RowKey:  key.key,
			Surface: key.surface,
			Target: CellTarget{
				Kind:     "catalog",
				ModelKey: config.ModelKey,
				Version:  config.Version,
			},
			IsDefault: contains(config.IsDefaultFor, key.surface),
		})
	}
	sort.Slice(request.Cells, func(i, j int) bool {
		if request.Cells[i].RowKey == request.Cells[j].RowKey {
			return request.Cells[i].Surface < request.Cells[j].Surface
		}
		return request.Cells[i].RowKey < request.Cells[j].RowKey
	})
	return request
}

func draftFromConfig(id string, config CatalogConfig) gridDraft {
	return gridDraft{
		ID:                        id,
		ModelKey:                  config.ModelKey,
		DisplayName:               config.DisplayName,
		ProviderSlug:              config.ProviderSlug,
		BaseURL:                   config.BaseURL,
		ProviderModelID:           config.ProviderModelID,
		AuthMode:                  config.AuthMode,
		ContextWindowTokens:       config.ContextWindowTokens,
		Params:                    append(json.RawMessage(nil), config.Params...),
		MicrosPerInputToken:       config.MicrosPerInputToken,
		MicrosPerCachedInputToken: config.MicrosPerCachedInputToken,
		MicrosPerOutputToken:      config.MicrosPerOutputToken,
	}
}

func configByKey(t *testing.T, snapshot RegistrySnapshot, key string) CatalogConfig {
	t.Helper()
	var found CatalogConfig
	for _, config := range snapshot.Configs {
		if config.ModelKey == key && config.Enabled && config.Version > found.Version {
			found = config
		}
	}
	if found.ModelKey == "" {
		t.Fatalf("enabled config %q not found", key)
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
	current := configByKey(t, snapshot, "deepseek-flash")
	draft := draftFromConfig("edited-flash", current)
	draft.BaseURL = "https://ops-test.invalid/v1"
	request.Drafts = []gridDraft{draft}
	for index := range request.Cells {
		if request.Cells[index].Target.ModelKey == current.ModelKey &&
			request.Cells[index].Target.Version == current.Version {
			request.Cells[index].Target = CellTarget{
				Kind:    "draft",
				DraftID: draft.ID,
			}
		}
	}
	var beforePreferences [4]string
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_key, generate_model_key, editor_model_key, quiz_model_key
		 FROM users WHERE id='u_1'`,
	).Scan(
		&beforePreferences[0], &beforePreferences[1],
		&beforePreferences[2], &beforePreferences[3],
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
	var oldSurfaces []string
	if err := tx.QueryRow(ctx, `
		SELECT enabled, surfaces FROM model_configs
		WHERE model_key=$1 AND version=$2`,
		current.ModelKey, current.Version,
	).Scan(&oldEnabled, &oldSurfaces); err != nil {
		t.Fatal(err)
	}
	if oldEnabled {
		t.Fatal("old immutable version remained enabled")
	}
	if !sameStringSet(oldSurfaces, current.Surfaces) {
		t.Fatalf("old version was mutated: got %v want %v", oldSurfaces, current.Surfaces)
	}
	var newVersion int
	if err := tx.QueryRow(ctx, `
		SELECT max(version) FROM model_configs
		WHERE model_key=$1 AND enabled`, current.ModelKey,
	).Scan(&newVersion); err != nil {
		t.Fatal(err)
	}
	if newVersion <= current.Version {
		t.Fatalf("new version was not inserted: %d", newVersion)
	}
	for _, surface := range snapshot.Surfaces {
		var defaults int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM model_configs
			WHERE enabled AND $1 = ANY(is_default_for)`, surface,
		).Scan(&defaults); err != nil {
			t.Fatal(err)
		}
		if defaults != 1 {
			t.Fatalf("surface %s has %d defaults after Save", surface, defaults)
		}
	}
	var afterPreferences [4]string
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_key, generate_model_key, editor_model_key, quiz_model_key
		 FROM users WHERE id='u_1'`,
	).Scan(
		&afterPreferences[0], &afterPreferences[1],
		&afterPreferences[2], &afterPreferences[3],
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

func TestRegistrySaveRequiresFallbackThenRemapsAndNotifies(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	snapshot, err := snapshotFrom(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	request := gridRequest(snapshot)
	filtered := request.Cells[:0]
	for _, cell := range request.Cells {
		if cell.RowKey == "deepseek-pro" && cell.Surface == "chat" {
			continue
		}
		filtered = append(filtered, cell)
	}
	request.Cells = filtered
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected missing fallback validation, got %v", err)
	}
	request.Deprecations = []DeprecationFallback{{
		ModelKey:    "deepseek-pro",
		Surface:     "chat",
		FallbackKey: "deepseek-flash",
	}}
	userID := "ops_registry_" + time.Now().UTC().Format("150405000000")
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, name, email, chat_model_key)
		VALUES ($1, 'Ops Registry Test', $2, 'deepseek-pro')`,
		userID, userID+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemappedUsers != 1 || result.Notifications != 1 {
		t.Fatalf("unexpected deprecation result: %+v", result)
	}
	var preference string
	if err := tx.QueryRow(ctx,
		`SELECT chat_model_key FROM users WHERE id=$1`, userID,
	).Scan(&preference); err != nil {
		t.Fatal(err)
	}
	if preference != "deepseek-flash" {
		t.Fatalf("preference was not remapped: %q", preference)
	}
	var template, idempotencyKey string
	var payload json.RawMessage
	if err := tx.QueryRow(ctx, `
		SELECT template, idempotency_key, payload
		FROM email_outbox WHERE user_id=$1`,
		userID,
	).Scan(&template, &idempotencyKey, &payload); err != nil {
		t.Fatal(err)
	}
	if template != "model-deprecated" {
		t.Fatalf("wrong email template: %q", template)
	}
	expectedKey := "model-deprecated:deepseek-pro:deepseek-flash:" + userID
	if idempotencyKey != expectedKey {
		t.Fatalf("idempotency key = %q, want %q", idempotencyKey, expectedKey)
	}
	var data map[string]string
	if err := json.Unmarshal(payload, &data); err != nil {
		t.Fatal(err)
	}
	for key, expected := range map[string]string{
		"code":     "model_deprecated",
		"fromKey":  "deepseek-pro",
		"fromName": "DeepSeek Pro",
		"toKey":    "deepseek-flash",
		"toName":   "DeepSeek Flash",
	} {
		if data[key] != expected {
			t.Fatalf("notification data %s = %q, want %q", key, data[key], expected)
		}
	}
}

func TestRegistrySaveRemapsEveryUserPreferenceAndDisablesRetiredRows(t *testing.T) {
	registry, tx := openRegistryTestTx(t)
	ctx := context.Background()
	suffix := time.Now().UTC().Format("150405000000")
	modelKey := "retired-" + suffix
	userID := "ops_all_prefs_" + suffix
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params,
			surfaces, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			$1, 1, 'Retired Model', 'deepseek', 'https://example.test',
			'retired-model', 'platform', 100000,
			'{"reasoning":{"canDisable":true,"efforts":["low"],"defaultMode":"off","defaultEffort":"low"}}',
			ARRAY['chat','generate','editor','quiz'], 1, 1, 1, true, '{}'
		)`, modelKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (
			id, name, email, chat_model_key, generate_model_key,
			editor_model_key, quiz_model_key
		) VALUES ($2, 'All Prefs', $3, $1, $1, $1, $1)`,
		modelKey, userID, userID+"@example.test",
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
		if cell.RowKey == modelKey {
			request.Deprecations = append(request.Deprecations, DeprecationFallback{
				ModelKey: modelKey, Surface: cell.Surface,
				FallbackKey: "deepseek-flash",
			})
			continue
		}
		filtered = append(filtered, cell)
	}
	request.Cells = filtered
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemappedUsers != 4 || result.Notifications != 1 ||
		result.DisabledRows < 1 {
		t.Fatalf("unexpected all-surface deprecation result: %+v", result)
	}
	var preferences [4]string
	if err := tx.QueryRow(ctx, `
		SELECT chat_model_key, generate_model_key, editor_model_key, quiz_model_key
		FROM users WHERE id=$1`, userID,
	).Scan(
		&preferences[0], &preferences[1], &preferences[2], &preferences[3],
	); err != nil {
		t.Fatal(err)
	}
	for index, preference := range preferences {
		if preference != "deepseek-flash" {
			t.Fatalf("preference %d = %q, want deepseek-flash", index, preference)
		}
	}
	var enabled bool
	if err := tx.QueryRow(ctx,
		`SELECT enabled FROM model_configs WHERE model_key=$1`, modelKey,
	).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("retired model row remained enabled")
	}
	var emailCount int
	var idempotencyKey string
	if err := tx.QueryRow(ctx, `
		SELECT count(*), min(idempotency_key)
		FROM email_outbox WHERE user_id=$1`, userID,
	).Scan(&emailCount, &idempotencyKey); err != nil {
		t.Fatal(err)
	}
	if emailCount != 1 {
		t.Fatalf("deprecation email count = %d, want idempotent 1", emailCount)
	}
	expectedKey := fmt.Sprintf(
		"model-deprecated:%s:deepseek-flash:%s", modelKey, userID,
	)
	if idempotencyKey != expectedKey {
		t.Fatalf("idempotency key = %q, want %q", idempotencyKey, expectedKey)
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
		Version:  1,
		Surfaces: append([]string(nil), Surfaces...),
		Configs: []CatalogConfig{{
			ModelKey:     "embed-model",
			Version:      1,
			Enabled:      true,
			Surfaces:     []string{"embedding"},
			IsDefaultFor: []string{"embedding"},
		}},
	}
	request := gridRequest(snapshot)
	request.Cells[0].RowKey = "alias-key"
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected alias validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Cells = nil
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected default validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Cells[0].Surface = "vision"
	if _, _, _, err := compileGrid(request, snapshot); !IsValidation(err) {
		t.Fatalf("expected embedding immutability validation, got %v", err)
	}
	request = gridRequest(snapshot)
	request.Drafts = []gridDraft{{
		ID: "new-embedding", ModelKey: "new-embedding",
		DisplayName: "New Embedding", ProviderSlug: "openrouter",
		BaseURL: "https://example.test", ProviderModelID: "new-embedding",
		AuthMode: "platform", Params: json.RawMessage(
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

func TestActiveDraftCompilesEmbeddingEndpointMoveInPlace(t *testing.T) {
	t.Parallel()
	current := CatalogConfig{
		ModelKey: "qwen-embed", Version: 1, DisplayName: "Qwen Embed",
		ProviderSlug: "openrouter", BaseURL: "https://old.example/v1",
		ProviderModelID: "qwen/qwen3-embedding-4b", AuthMode: "platform",
		ContextWindowTokens: 8192,
		Params: json.RawMessage(
			`{"dimensions":2560,"vector_table":"rag_chunk_vectors_2560"}`,
		),
		Surfaces:            []string{models.SurfaceEmbedding},
		MicrosPerInputToken: 50, Enabled: true,
		IsDefaultFor: []string{models.SurfaceEmbedding},
	}
	request := RegistrySaveRequest{
		Revision: 7,
		Active: []DraftConfig{{
			ModelKey: current.ModelKey, DisplayName: current.DisplayName,
			ProviderSlug: "moved-provider", BaseURL: "https://new.example/v1",
			ProviderModelID: current.ProviderModelID, AuthMode: current.AuthMode,
			ContextWindowTokens: current.ContextWindowTokens, Params: current.Params,
			Surfaces: current.Surfaces, DefaultFor: current.IsDefaultFor,
			Rates: CreditRates{InputMicros: current.MicrosPerInputToken},
		}},
	}
	grid, err := activeToGrid(request, RegistrySnapshot{
		Version: 7, Configs: []CatalogConfig{current},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(grid.Drafts) != 0 || len(grid.EmbeddingUpdates) != 1 {
		t.Fatalf("embedding endpoint compiled as immutable draft: %+v", grid)
	}
	if len(grid.Cells) != 1 || grid.Cells[0].Target.Kind != "existing" {
		t.Fatalf("embedding cell target = %+v, want existing row", grid.Cells)
	}
}

func TestEmbeddingDefaultEligibilityRefusesInvalidPinsAndTables(t *testing.T) {
	_, tx := openRegistryTestTx(t)
	ctx := context.Background()
	base := CatalogConfig{
		ModelKey: "qwen-embed", Version: 1, Enabled: true,
		Surfaces: []string{models.SurfaceEmbedding},
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
	notAllowed.ModelKey = "not-allowed"
	eligible, reason, err = embeddingEligibility(ctx, tx, notAllowed)
	if err != nil || eligible || !containsText(reason, "allowlist") {
		t.Fatalf("non-allowlisted eligibility = %v, %q, %v", eligible, reason, err)
	}

	missingTablePin := models.Pin{Key: "missing-table", Version: 1}
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
	missingTable.ModelKey = missingTablePin.Key
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
	modelKey := "ops-embed-" + suffix
	table := "rag_chunk_vectors_ops_" + suffix
	pin := models.Pin{Key: modelKey, Version: 1}
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
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			$1, 1, 'Ops Embed', 'openrouter', 'https://example.test',
			'ops-embed-provider', 'platform', $2::jsonb, ARRAY['embedding'],
			50, 0, 0, true, ARRAY[]::text[]
		)`, modelKey, params,
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
		if cell.Surface != models.SurfaceEmbedding {
			continue
		}
		cell.IsDefault = cell.RowKey == modelKey
	}
	if _, err := registry.saveTx(ctx, tx, request); !IsValidation(err) {
		t.Fatalf("embedding retarget without acknowledgement = %v", err)
	}
	request.EmbeddingAcknowledged = true
	request.EmbeddingUpdates = []EmbeddingEndpointUpdate{{
		ModelKey: modelKey, Version: 1,
		ProviderSlug: "openrouter-moved", BaseURL: "https://moved.example/v1",
	}}
	result, err := registry.saveTx(ctx, tx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.InsertedRows != 0 {
		t.Fatalf("embedding default move inserted %d rows", result.InsertedRows)
	}
	rows, err := tx.Query(ctx, `
		SELECT model_key, enabled, is_default_for, provider_slug, base_url,
			provider_model_id, params
		FROM model_configs
		WHERE model_key IN ('qwen-embed', $1)
		ORDER BY model_key`, modelKey)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]CatalogConfig{}
	for rows.Next() {
		var config CatalogConfig
		if err := rows.Scan(
			&config.ModelKey, &config.Enabled, &config.IsDefaultFor,
			&config.ProviderSlug, &config.BaseURL, &config.ProviderModelID,
			&config.Params,
		); err != nil {
			t.Fatal(err)
		}
		seen[config.ModelKey] = config
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	old := seen["qwen-embed"]
	moved := seen[modelKey]
	if !old.Enabled || !moved.Enabled {
		t.Fatalf("embedding rows were disabled: old=%v new=%v", old.Enabled, moved.Enabled)
	}
	if contains(old.IsDefaultFor, models.SurfaceEmbedding) ||
		!contains(moved.IsDefaultFor, models.SurfaceEmbedding) {
		t.Fatalf("embedding defaults not moved: old=%v new=%v",
			old.IsDefaultFor, moved.IsDefaultFor)
	}
	if moved.ProviderSlug != "openrouter-moved" ||
		moved.BaseURL != "https://moved.example/v1" {
		t.Fatalf("endpoint update not applied: %+v", moved)
	}
	if moved.ProviderModelID != "ops-embed-provider" ||
		!sameJSONTest(moved.Params, json.RawMessage(params)) {
		t.Fatalf("embedding identity was rewritten: %+v", moved)
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
