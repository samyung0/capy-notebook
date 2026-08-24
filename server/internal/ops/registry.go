package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/evonotes/server/internal/embeddingpins"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var modelKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
var providerSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var embeddingPinLookup = embeddingpins.Lookup

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

type ConflictError struct{ Current RegistrySnapshot }

func (e *ConflictError) Error() string {
	return "the registry changed; reload and review the new version"
}

type RegistryStore struct {
	read     *pgxpool.Pool
	write    *pgxpool.Pool
	writeDSN string
	writeMu  sync.Mutex
}

func NewRegistryStore(read, write *pgxpool.Pool) *RegistryStore {
	return &RegistryStore{read: read, write: write}
}

func NewLazyRegistryStore(read *pgxpool.Pool, writeDSN string) *RegistryStore {
	return &RegistryStore{read: read, writeDSN: strings.TrimSpace(writeDSN)}
}

func (s *RegistryStore) WriteConfigured() bool {
	return s != nil && (s.write != nil || s.writeDSN != "")
}

func (s *RegistryStore) writer(ctx context.Context) (*pgxpool.Pool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.write != nil {
		return s.write, nil
	}
	if s.writeDSN == "" {
		return nil, errors.New("registry writer is not configured")
	}
	config, err := pgxpool.ParseConfig(s.writeDSN)
	if err != nil {
		return nil, errors.New("registry writer configuration is invalid")
	}
	config.MaxConns = 2
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open registry writer: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping registry writer: %w", err)
	}
	if err := ValidateDatabaseRole(ctx, pool, RegistryDatabaseRole); err != nil {
		pool.Close()
		return nil, fmt.Errorf("validate registry writer role: %w", err)
	}
	s.write = pool
	return pool, nil
}

func (s *RegistryStore) Close() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.write != nil && s.writeDSN != "" {
		s.write.Close()
		s.write = nil
	}
}

func (s *RegistryStore) Snapshot(ctx context.Context) (RegistrySnapshot, error) {
	return snapshotFrom(ctx, s.read)
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func snapshotFrom(ctx context.Context, q querier) (RegistrySnapshot, error) {
	out := RegistrySnapshot{
		Surfaces:                 append([]string(nil), Surfaces...),
		AliasesAllowed:           false,
		Configs:                  []CatalogConfig{},
		ProviderCredentials:      []ProviderCredentialAvailability{},
		EmbeddingWorkspaceCounts: []EmbeddingWorkspaceCount{},
	}
	if err := q.QueryRow(ctx,
		`SELECT version FROM model_registry_state WHERE id = true`).Scan(&out.Version); err != nil {
		return out, err
	}
	rows, err := q.Query(ctx, `
		SELECT model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params,
			surfaces, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for, created_at
		FROM model_configs ORDER BY model_key, version`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var c CatalogConfig
		if err := rows.Scan(&c.ModelKey, &c.Version, &c.DisplayName,
			&c.ProviderSlug, &c.BaseURL, &c.ProviderModelID, &c.AuthMode,
			&c.ContextWindowTokens, &c.Params, &c.Surfaces,
			&c.MicrosPerInputToken, &c.MicrosPerCachedInputToken,
			&c.MicrosPerOutputToken, &c.Enabled, &c.IsDefaultFor,
			&c.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Configs = append(out.Configs, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	providerSlugs := make(map[string]bool)
	for _, config := range out.Configs {
		providerSlugs[config.ProviderSlug] = true
	}
	sortedProviderSlugs := make([]string, 0, len(providerSlugs))
	for providerSlug := range providerSlugs {
		sortedProviderSlugs = append(sortedProviderSlugs, providerSlug)
	}
	sort.Strings(sortedProviderSlugs)
	for _, providerSlug := range sortedProviderSlugs {
		environment := credentialEnv(providerSlug)
		out.ProviderCredentials = append(
			out.ProviderCredentials,
			ProviderCredentialAvailability{
				ProviderSlug: providerSlug,
				Environment:  environment,
				Configured:   os.Getenv(environment) != "",
			},
		)
	}
	for index := range out.Configs {
		config := &out.Configs[index]
		if !contains(config.Surfaces, models.SurfaceEmbedding) {
			continue
		}
		config.EmbeddingDefaultEligible, config.EmbeddingValidationError, err =
			embeddingEligibility(ctx, q, *config)
		if err != nil {
			return out, err
		}
	}
	rows, err = q.Query(ctx, `
		SELECT embedding_model_key, embedding_model_version,
			COALESCE((SELECT (mc.params->>'dimensions')::int
				FROM model_configs mc
				WHERE mc.model_key = w.embedding_model_key
				  AND mc.version = w.embedding_model_version), 0),
			count(*)
		FROM workspaces w
		GROUP BY embedding_model_key, embedding_model_version
		ORDER BY embedding_model_key, embedding_model_version`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item EmbeddingWorkspaceCount
		if err := rows.Scan(&item.ModelKey, &item.Version, &item.Dim, &item.Count); err != nil {
			return out, err
		}
		out.EmbeddingWorkspaceCounts = append(out.EmbeddingWorkspaceCounts, item)
	}
	return out, rows.Err()
}

func credentialEnv(provider string) string {
	replacer := strings.NewReplacer("-", "_", ".", "_")
	return strings.ToUpper(replacer.Replace(provider)) + "_API_KEY"
}

type compiledDraft struct {
	gridDraft
	Version    int
	Surfaces   []string
	DefaultFor []string
}

type CellTarget struct {
	Kind     string
	ModelKey string
	Version  int
	DraftID  string
}

type GridCell struct {
	RowKey    string
	Surface   string
	Target    CellTarget
	IsDefault bool
}

type gridDraft struct {
	ID                        string
	ModelKey                  string
	DisplayName               string
	ProviderSlug              string
	BaseURL                   string
	ProviderModelID           string
	AuthMode                  string
	ContextWindowTokens       int
	Params                    json.RawMessage
	MicrosPerInputToken       int64
	MicrosPerCachedInputToken int64
	MicrosPerOutputToken      int64
}

type DeprecationFallback struct {
	ModelKey    string
	Surface     string
	FallbackKey string
}

type EmbeddingEndpointUpdate struct {
	ModelKey     string
	Version      int
	ProviderSlug string
	BaseURL      string
}

type gridSaveRequest struct {
	ExpectedVersion       int64
	Cells                 []GridCell
	Drafts                []gridDraft
	Deprecations          []DeprecationFallback
	EmbeddingUpdates      []EmbeddingEndpointUpdate
	EmbeddingAcknowledged bool
}

type RegistrySaveResult struct {
	Version       int64
	DisabledRows  int64
	RemappedUsers int64
	InsertedRows  int
	Notifications int
}

type existingTarget struct {
	ModelKey string
	Version  int
}

func activeToGrid(req RegistrySaveRequest, current RegistrySnapshot) (gridSaveRequest, error) {
	grid := gridSaveRequest{
		ExpectedVersion:       req.Revision,
		EmbeddingAcknowledged: req.AcknowledgeEmbeddingRetarget,
	}
	latest := make(map[string]CatalogConfig)
	for _, config := range current.Configs {
		if config.Enabled && config.Version > latest[config.ModelKey].Version {
			latest[config.ModelKey] = config
		}
	}
	seenKeys := make(map[string]bool)
	for _, draft := range req.Active {
		if seenKeys[draft.ModelKey] {
			return grid, validation("active model keys must be unique")
		}
		seenKeys[draft.ModelKey] = true
		internal := gridDraft{
			ID: draft.ModelKey, ModelKey: draft.ModelKey,
			DisplayName: draft.DisplayName, ProviderSlug: draft.ProviderSlug,
			BaseURL: draft.BaseURL, ProviderModelID: draft.ProviderModelID,
			AuthMode: draft.AuthMode, ContextWindowTokens: draft.ContextWindowTokens,
			Params: draft.Params, MicrosPerInputToken: draft.Rates.InputMicros,
			MicrosPerCachedInputToken: draft.Rates.CachedInputMicros,
			MicrosPerOutputToken:      draft.Rates.OutputMicros,
		}
		if len(draft.Surfaces) == 0 {
			return grid, validation("active config %q needs at least one surface", draft.ModelKey)
		}
		surfaces, err := uniqueSurfaces(draft.Surfaces)
		if err != nil {
			return grid, err
		}
		defaults, err := uniqueSurfaces(draft.DefaultFor)
		if err != nil {
			return grid, err
		}
		for _, surface := range defaults {
			if !contains(surfaces, surface) {
				return grid, validation("default %s is not served by %s", surface, draft.ModelKey)
			}
		}
		currentConfig, exists := latest[draft.ModelKey]
		embedding := contains(surfaces, models.SurfaceEmbedding)
		if embedding {
			if !exists || !contains(currentConfig.Surfaces, models.SurfaceEmbedding) {
				return grid, validation("new embedding rows require a schema and code deploy")
			}
			if err := validateEmbeddingDraft(currentConfig, internal, surfaces); err != nil {
				return grid, err
			}
			if currentConfig.ProviderSlug != draft.ProviderSlug ||
				currentConfig.BaseURL != draft.BaseURL {
				grid.EmbeddingUpdates = append(grid.EmbeddingUpdates, EmbeddingEndpointUpdate{
					ModelKey: draft.ModelKey, Version: currentConfig.Version,
					ProviderSlug: draft.ProviderSlug, BaseURL: draft.BaseURL,
				})
			}
		} else {
			if err := validateDraft(internal); err != nil {
				return grid, err
			}
			if err := validateConfigForSurfaces(internal, surfaces); err != nil {
				return grid, err
			}
		}
		target := CellTarget{Kind: "draft", DraftID: internal.ID}
		if embedding || exists && configIdentityMatches(currentConfig, internal) {
			target = CellTarget{
				Kind: "existing", ModelKey: currentConfig.ModelKey,
				Version: currentConfig.Version,
			}
		} else {
			grid.Drafts = append(grid.Drafts, internal)
		}
		for _, surface := range surfaces {
			grid.Cells = append(grid.Cells, GridCell{
				RowKey: draft.ModelKey, Surface: surface, Target: target,
				IsDefault: contains(defaults, surface),
			})
		}
	}
	for _, config := range current.Configs {
		if config.Enabled && contains(config.Surfaces, models.SurfaceEmbedding) &&
			!seenKeys[config.ModelKey] {
			return grid, validation("embedding key %s must remain active", config.ModelKey)
		}
	}
	for _, fallback := range req.Fallbacks {
		grid.Deprecations = append(grid.Deprecations, DeprecationFallback{
			ModelKey: fallback.FromKey, Surface: fallback.Surface,
			FallbackKey: fallback.ToKey,
		})
	}
	sort.Slice(grid.Cells, func(i, j int) bool {
		if grid.Cells[i].RowKey == grid.Cells[j].RowKey {
			return grid.Cells[i].Surface < grid.Cells[j].Surface
		}
		return grid.Cells[i].RowKey < grid.Cells[j].RowKey
	})
	sort.Slice(grid.Deprecations, func(i, j int) bool {
		left := grid.Deprecations[i]
		right := grid.Deprecations[j]
		if left.ModelKey != right.ModelKey {
			return left.ModelKey < right.ModelKey
		}
		if left.Surface != right.Surface {
			return left.Surface < right.Surface
		}
		return left.FallbackKey < right.FallbackKey
	})
	return grid, nil
}

func uniqueSurfaces(values []string) ([]string, error) {
	seen := make(map[string]bool)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if !contains(Surfaces, value) {
			return nil, validation("unknown surface %q", value)
		}
		if seen[value] {
			return nil, validation("duplicate surface %q", value)
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

func configIdentityMatches(current CatalogConfig, draft gridDraft) bool {
	return current.ModelKey == draft.ModelKey &&
		current.DisplayName == draft.DisplayName &&
		current.ProviderSlug == draft.ProviderSlug &&
		current.BaseURL == draft.BaseURL &&
		current.ProviderModelID == draft.ProviderModelID &&
		current.AuthMode == draft.AuthMode &&
		current.ContextWindowTokens == draft.ContextWindowTokens &&
		sameJSON(current.Params, draft.Params) &&
		current.MicrosPerInputToken == draft.MicrosPerInputToken &&
		current.MicrosPerCachedInputToken == draft.MicrosPerCachedInputToken &&
		current.MicrosPerOutputToken == draft.MicrosPerOutputToken
}

func validateEmbeddingDraft(
	current CatalogConfig,
	draft gridDraft,
	surfaces []string,
) error {
	if !sameStringSet(current.Surfaces, surfaces) ||
		current.DisplayName != draft.DisplayName ||
		current.ProviderModelID != draft.ProviderModelID ||
		current.AuthMode != draft.AuthMode ||
		current.ContextWindowTokens != draft.ContextWindowTokens ||
		!sameJSON(current.Params, draft.Params) ||
		current.MicrosPerInputToken != draft.MicrosPerInputToken ||
		current.MicrosPerCachedInputToken != draft.MicrosPerCachedInputToken ||
		current.MicrosPerOutputToken != draft.MicrosPerOutputToken {
		return validation("embedding identity, params, rates, and surfaces are immutable")
	}
	if !providerSlugPattern.MatchString(draft.ProviderSlug) {
		return validation("embedding provider slug is invalid")
	}
	parsed, err := url.Parse(draft.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return validation("embedding base URL must be an absolute HTTPS URL")
	}
	return nil
}

func sameJSON(left, right json.RawMessage) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil &&
		json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
}

func embeddingDefaultChanged(req gridSaveRequest, current RegistrySnapshot) bool {
	var currentTarget existingTarget
	for _, config := range current.Configs {
		if contains(config.IsDefaultFor, "embedding") {
			currentTarget = existingTarget{ModelKey: config.ModelKey, Version: config.Version}
			break
		}
	}
	for _, cell := range req.Cells {
		if cell.Surface != "embedding" || !cell.IsDefault {
			continue
		}
		return (cell.Target.Kind != "existing" && cell.Target.Kind != "catalog") ||
			cell.Target.ModelKey != currentTarget.ModelKey ||
			cell.Target.Version != currentTarget.Version
	}
	return currentTarget != (existingTarget{})
}

func (s *RegistryStore) Save(
	ctx context.Context,
	principal Principal,
	req RegistrySaveRequest,
) (RegistrySnapshot, error) {
	if principal.Role != RoleAdmin {
		return RegistrySnapshot{}, ErrForbidden
	}
	current, err := s.Snapshot(ctx)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	grid, err := activeToGrid(req, current)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	writer, err := s.writer(ctx)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	tx, err := writer.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return RegistrySnapshot{}, err
	}
	defer tx.Rollback(ctx)
	_, err = s.saveTx(ctx, tx, grid)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RegistrySnapshot{}, err
	}
	return snapshotFrom(ctx, writer)
}

func (s *RegistryStore) saveGrid(
	ctx context.Context,
	req gridSaveRequest,
) (RegistrySaveResult, error) {
	writer, err := s.writer(ctx)
	if err != nil {
		return RegistrySaveResult{}, err
	}
	tx, err := writer.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return RegistrySaveResult{}, err
	}
	defer tx.Rollback(ctx)
	result, err := s.saveTx(ctx, tx, req)
	if err != nil {
		return result, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (s *RegistryStore) saveTx(
	ctx context.Context,
	tx pgx.Tx,
	req gridSaveRequest,
) (RegistrySaveResult, error) {
	var version int64
	if err := tx.QueryRow(ctx, `
		SELECT version FROM model_registry_state WHERE id = true FOR UPDATE`).
		Scan(&version); err != nil {
		return RegistrySaveResult{}, err
	}
	if version != req.ExpectedVersion {
		current, snapErr := snapshotFrom(ctx, tx)
		if snapErr != nil {
			return RegistrySaveResult{}, snapErr
		}
		return RegistrySaveResult{}, &ConflictError{Current: current}
	}
	if _, err := tx.Exec(ctx,
		`LOCK TABLE model_configs IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return RegistrySaveResult{}, err
	}
	current, err := snapshotFrom(ctx, tx)
	if err != nil {
		return RegistrySaveResult{}, err
	}
	if err := validateEmbeddingPins(current); err != nil {
		return RegistrySaveResult{}, err
	}
	if embeddingDefaultChanged(req, current) && !req.EmbeddingAcknowledged {
		return RegistrySaveResult{}, validation(
			"confirm the embedding immutability warning before changing its default",
		)
	}
	drafts, existing, defaults, err := compileGrid(req, current)
	if err != nil {
		return RegistrySaveResult{}, err
	}
	if err := validateEmbeddingDefault(ctx, tx, current, defaults); err != nil {
		return RegistrySaveResult{}, err
	}
	if err := applyEmbeddingUpdates(ctx, tx, current, req.EmbeddingUpdates); err != nil {
		return RegistrySaveResult{}, err
	}
	result := RegistrySaveResult{}
	if _, err := tx.Exec(ctx, `
		UPDATE model_configs
		SET is_default_for = '{}'
		WHERE cardinality(is_default_for) > 0`); err != nil {
		return result, err
	}
	for i := range drafts {
		if err := assignDraftVersion(ctx, tx, &drafts[i]); err != nil {
			return result, err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO model_configs (
				model_key, version, display_name, provider_slug, base_url,
				provider_model_id, auth_mode, context_window_tokens, params,
				surfaces, micros_per_input_token, micros_per_cached_input_token,
				micros_per_output_token, enabled, is_default_for
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14)`,
			drafts[i].ModelKey, drafts[i].Version, drafts[i].DisplayName,
			drafts[i].ProviderSlug, drafts[i].BaseURL,
			drafts[i].ProviderModelID, drafts[i].AuthMode,
			drafts[i].ContextWindowTokens, drafts[i].Params,
			drafts[i].Surfaces, drafts[i].MicrosPerInputToken,
			drafts[i].MicrosPerCachedInputToken,
			drafts[i].MicrosPerOutputToken, drafts[i].DefaultFor)
		if err != nil {
			return result, err
		}
		result.InsertedRows++
	}
	remapped, notifications, err := applyDeprecations(ctx, tx, req.Deprecations)
	if err != nil {
		return result, err
	}
	result.RemappedUsers += remapped
	result.Notifications += notifications
	disabled, inserted, err := applyExistingTargets(
		ctx, tx, current, existing, defaults,
	)
	if err != nil {
		return result, err
	}
	result.DisabledRows += disabled
	result.InsertedRows += inserted
	result.Version = version + 1
	if _, err := tx.Exec(ctx, `
		UPDATE model_registry_state
		SET version = $1, updated_at = now() WHERE id = true`, result.Version); err != nil {
		return result, err
	}
	return result, nil
}

func compileGrid(
	req gridSaveRequest,
	current RegistrySnapshot,
) ([]compiledDraft, map[existingTarget][]string, map[string]existingTarget, error) {
	configs := make(map[existingTarget]CatalogConfig)
	for _, c := range current.Configs {
		configs[existingTarget{c.ModelKey, c.Version}] = c
	}
	draftByID := make(map[string]gridDraft)
	for _, d := range req.Drafts {
		if err := validateDraft(d); err != nil {
			return nil, nil, nil, err
		}
		if _, exists := draftByID[d.ID]; exists {
			return nil, nil, nil, validation("duplicate draft id %q", d.ID)
		}
		draftByID[d.ID] = d
	}
	type draftUse struct {
		surfaces []string
		defaults []string
	}
	draftUses := make(map[string]*draftUse)
	existing := make(map[existingTarget][]string)
	defaults := make(map[string]existingTarget)
	seenCells := make(map[string]bool)
	for _, cell := range req.Cells {
		if !contains(Surfaces, cell.Surface) {
			return nil, nil, nil, validation("unknown surface %q", cell.Surface)
		}
		if cell.RowKey == "" {
			return nil, nil, nil, validation("row key is required")
		}
		cellID := cell.RowKey + "\x00" + cell.Surface
		if seenCells[cellID] {
			return nil, nil, nil, validation("duplicate cell for %s/%s", cell.RowKey, cell.Surface)
		}
		seenCells[cellID] = true
		if cell.Target.Kind == "existing" || cell.Target.Kind == "catalog" {
			key := existingTarget{cell.Target.ModelKey, cell.Target.Version}
			c, ok := configs[key]
			if !ok || !c.Enabled {
				return nil, nil, nil, validation("unknown enabled target %s v%d", key.ModelKey, key.Version)
			}
			if cell.RowKey != key.ModelKey {
				return nil, nil, nil, validation("aliases are not supported: row key must equal model key")
			}
			existing[key] = appendUnique(existing[key], cell.Surface)
			if cell.IsDefault {
				if _, duplicate := defaults[cell.Surface]; duplicate {
					return nil, nil, nil, validation("surface %q has more than one default", cell.Surface)
				}
				defaults[cell.Surface] = key
			}
		} else if cell.Target.Kind == "draft" {
			d, ok := draftByID[cell.Target.DraftID]
			if !ok {
				return nil, nil, nil, validation("unknown draft %q", cell.Target.DraftID)
			}
			if cell.RowKey != d.ModelKey {
				return nil, nil, nil, validation("aliases are not supported: row key must equal model key")
			}
			if cell.Surface == "embedding" {
				return nil, nil, nil, validation("new embedding catalog rows require a schema migration and cannot be created here")
			}
			use := draftUses[d.ID]
			if use == nil {
				use = &draftUse{}
				draftUses[d.ID] = use
			}
			use.surfaces = appendUnique(use.surfaces, cell.Surface)
			if cell.IsDefault {
				if _, duplicate := defaults[cell.Surface]; duplicate {
					return nil, nil, nil, validation("surface %q has more than one default", cell.Surface)
				}
				use.defaults = appendUnique(use.defaults, cell.Surface)
				defaults[cell.Surface] = existingTarget{ModelKey: d.ModelKey, Version: -1}
			}
		} else {
			return nil, nil, nil, validation("cell target kind must be existing or draft")
		}
	}
	requiredDefaults := make(map[string]bool)
	for _, config := range current.Configs {
		for _, surface := range config.IsDefaultFor {
			requiredDefaults[surface] = true
		}
	}
	for surface := range requiredDefaults {
		if _, ok := defaults[surface]; !ok {
			return nil, nil, nil, validation("surface %q needs exactly one default", surface)
		}
	}
	if err := enforceEmbeddingUnchanged(current, existing); err != nil {
		return nil, nil, nil, err
	}
	desiredCells := make(map[string]bool)
	for _, cell := range req.Cells {
		desiredCells[cell.RowKey+"\x00"+cell.Surface] = true
	}
	requiredDeprecations := make(map[string]bool)
	for _, config := range current.Configs {
		if !config.Enabled {
			continue
		}
		for _, surface := range config.Surfaces {
			if _, userFacing := userPreferenceColumns[surface]; !userFacing {
				continue
			}
			key := config.ModelKey + "\x00" + surface
			if !desiredCells[key] {
				requiredDeprecations[key] = true
			}
		}
	}
	seenDeprecations := make(map[string]bool)
	for _, deprecation := range req.Deprecations {
		key := deprecation.ModelKey + "\x00" + deprecation.Surface
		if seenDeprecations[key] {
			return nil, nil, nil, validation(
				"duplicate deprecation for %s/%s",
				deprecation.ModelKey,
				deprecation.Surface,
			)
		}
		seenDeprecations[key] = true
		if !requiredDeprecations[key] {
			return nil, nil, nil, validation(
				"%s/%s is not being retired",
				deprecation.ModelKey,
				deprecation.Surface,
			)
		}
		if deprecation.FallbackKey == deprecation.ModelKey ||
			!desiredCells[deprecation.FallbackKey+"\x00"+deprecation.Surface] {
			return nil, nil, nil, validation(
				"fallback %s must serve %s in the saved grid",
				deprecation.FallbackKey,
				deprecation.Surface,
			)
		}
	}
	for key := range requiredDeprecations {
		if !seenDeprecations[key] {
			parts := strings.Split(key, "\x00")
			return nil, nil, nil, validation(
				"retiring %s from %s requires a fallback",
				parts[0],
				parts[1],
			)
		}
	}
	var drafts []compiledDraft
	for id, use := range draftUses {
		if len(use.surfaces) == 0 {
			continue
		}
		d := draftByID[id]
		sort.Strings(use.surfaces)
		sort.Strings(use.defaults)
		if use.defaults == nil {
			use.defaults = []string{}
		}
		if d.AuthMode == "user_key" && len(use.defaults) > 0 {
			return nil, nil, nil, validation("user-key draft %q cannot be a default", d.ID)
		}
		if err := validateConfigForSurfaces(d, use.surfaces); err != nil {
			return nil, nil, nil, err
		}
		drafts = append(drafts, compiledDraft{gridDraft: d, Surfaces: use.surfaces, DefaultFor: use.defaults})
	}
	for target, surfaces := range existing {
		config := configs[target]
		sortedSurfaces := append([]string(nil), surfaces...)
		sort.Strings(sortedSurfaces)
		currentSurfaces := append([]string(nil), config.Surfaces...)
		sort.Strings(currentSurfaces)
		if strings.Join(sortedSurfaces, "\x00") == strings.Join(currentSurfaces, "\x00") {
			continue
		}
		var defaultFor []string
		for surface, defaultTarget := range defaults {
			if defaultTarget == target {
				defaultFor = append(defaultFor, surface)
			}
		}
		sort.Strings(defaultFor)
		if defaultFor == nil {
			defaultFor = []string{}
		}
		drafts = append(drafts, compiledDraft{
			gridDraft: gridDraft{
				ID:                        fmt.Sprintf("catalog:%s:%d", target.ModelKey, target.Version),
				ModelKey:                  config.ModelKey,
				DisplayName:               config.DisplayName,
				ProviderSlug:              config.ProviderSlug,
				BaseURL:                   config.BaseURL,
				ProviderModelID:           config.ProviderModelID,
				AuthMode:                  config.AuthMode,
				ContextWindowTokens:       config.ContextWindowTokens,
				Params:                    config.Params,
				MicrosPerInputToken:       config.MicrosPerInputToken,
				MicrosPerCachedInputToken: config.MicrosPerCachedInputToken,
				MicrosPerOutputToken:      config.MicrosPerOutputToken,
			},
			Surfaces:   sortedSurfaces,
			DefaultFor: defaultFor,
		})
		delete(existing, target)
	}
	sort.Slice(drafts, func(i, j int) bool { return drafts[i].ID < drafts[j].ID })
	return drafts, existing, defaults, nil
}

func validateEmbeddingPins(current RegistrySnapshot) error {
	for _, config := range current.Configs {
		if !config.Enabled || !contains(config.Surfaces, models.SurfaceEmbedding) {
			continue
		}
		if !config.EmbeddingDefaultEligible {
			return validation("%s", config.EmbeddingValidationError)
		}
	}
	return nil
}

func validateEmbeddingDefault(
	ctx context.Context,
	tx pgx.Tx,
	current RegistrySnapshot,
	defaults map[string]existingTarget,
) error {
	target, ok := defaults[models.SurfaceEmbedding]
	if !ok {
		return nil
	}
	var config *CatalogConfig
	for index := range current.Configs {
		candidate := &current.Configs[index]
		if candidate.ModelKey == target.ModelKey &&
			candidate.Version == target.Version {
			config = candidate
			break
		}
	}
	if config == nil || !config.Enabled ||
		!contains(config.Surfaces, models.SurfaceEmbedding) {
		return validation("embedding default must target an enabled pre-shipped row")
	}
	eligible, reason, err := embeddingEligibility(ctx, tx, *config)
	if err != nil {
		return err
	}
	if !eligible {
		return validation("%s", reason)
	}
	return nil
}

func embeddingEligibility(
	ctx context.Context,
	q querier,
	config CatalogConfig,
) (bool, string, error) {
	var params struct {
		Dimensions  int    `json:"dimensions"`
		VectorTable string `json:"vector_table"`
	}
	if err := json.Unmarshal(config.Params, &params); err != nil ||
		params.VectorTable == "" {
		return false, fmt.Sprintf(
			"embedding default %s v%d needs params.vector_table",
			config.ModelKey, config.Version,
		), nil
	}
	spec, allowed := embeddingPinLookup(models.Pin{
		Key: config.ModelKey, Version: config.Version,
	})
	if !allowed || spec.VectorTable != params.VectorTable ||
		spec.Dimensions != params.Dimensions {
		return false, fmt.Sprintf(
			"embedding default %s v%d is not in the server vector-table allowlist",
			config.ModelKey, config.Version,
		), nil
	}
	var tableExists bool
	if err := q.QueryRow(ctx,
		`SELECT to_regclass($1) IS NOT NULL`, params.VectorTable,
	).Scan(&tableExists); err != nil {
		return false, "", err
	}
	if !tableExists {
		return false, fmt.Sprintf(
			"embedding vector table %q does not exist", params.VectorTable,
		), nil
	}
	return true, "", nil
}

func validateDraft(d gridDraft) error {
	if d.ID == "" || !modelKeyPattern.MatchString(d.ModelKey) {
		return validation("draft id and model key are required; model keys use lowercase letters, numbers, and hyphens")
	}
	if strings.TrimSpace(d.DisplayName) == "" || strings.TrimSpace(d.ProviderModelID) == "" {
		return validation("draft %q needs display name and provider model id", d.ID)
	}
	if !providerSlugPattern.MatchString(d.ProviderSlug) {
		return validation("draft %q has an invalid provider slug", d.ID)
	}
	if d.AuthMode != "platform" && d.AuthMode != "user_key" && d.AuthMode != "platform_or_user" {
		return validation("draft %q has an invalid auth mode", d.ID)
	}
	if d.AuthMode == "user_key" &&
		(d.MicrosPerInputToken != 0 || d.MicrosPerCachedInputToken != 0 || d.MicrosPerOutputToken != 0) {
		return validation("user-key draft %q must have zero platform credit rates", d.ID)
	}
	if d.AuthMode != "user_key" &&
		(d.MicrosPerInputToken <= 0 || d.MicrosPerCachedInputToken <= 0 || d.MicrosPerOutputToken <= 0) {
		return validation("platform draft %q needs positive input, cached-input, and output rates", d.ID)
	}
	parsed, err := url.Parse(d.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return validation("draft %q base URL must be an absolute HTTPS URL", d.ID)
	}
	var params map[string]any
	if len(d.Params) == 0 || json.Unmarshal(d.Params, &params) != nil || params == nil {
		return validation("draft %q params must be a JSON object", d.ID)
	}
	return nil
}

func validateConfigForSurfaces(d gridDraft, surfaces []string) error {
	var params map[string]any
	if err := json.Unmarshal(d.Params, &params); err != nil {
		return validation("draft %q params must be a JSON object", d.ID)
	}
	if err := models.ValidateCatalogReasoning(surfaces, params); err != nil {
		return validation("draft %q: %v", d.ID, err)
	}
	for _, surface := range surfaces {
		switch surface {
		case models.SurfaceChat, models.SurfaceGenerate, models.SurfaceEditor,
			models.SurfaceQuiz, models.SurfaceIngest:
			if d.ContextWindowTokens <= 0 {
				return validation("draft %q needs a positive context window", d.ID)
			}
		}
	}
	return nil
}

func enforceEmbeddingUnchanged(
	current RegistrySnapshot,
	existing map[existingTarget][]string,
) error {
	for _, c := range current.Configs {
		if !c.Enabled || !contains(c.Surfaces, "embedding") {
			continue
		}
		target := existingTarget{c.ModelKey, c.Version}
		surfaces := existing[target]
		if !contains(surfaces, "embedding") ||
			!sameStringSet(surfaces, c.Surfaces) {
			return validation("embedding rows cannot be removed, disabled, or reassigned")
		}
	}
	return nil
}

func assignDraftVersion(ctx context.Context, tx pgx.Tx, draft *compiledDraft) error {
	return tx.QueryRow(ctx,
		`SELECT COALESCE(max(version), 0) + 1 FROM model_configs WHERE model_key = $1`,
		draft.ModelKey).Scan(&draft.Version)
}

func applyEmbeddingUpdates(
	ctx context.Context,
	tx pgx.Tx,
	current RegistrySnapshot,
	updates []EmbeddingEndpointUpdate,
) error {
	configs := make(map[existingTarget]CatalogConfig)
	for _, config := range current.Configs {
		configs[existingTarget{ModelKey: config.ModelKey, Version: config.Version}] = config
	}
	seen := make(map[existingTarget]bool)
	for _, update := range updates {
		target := existingTarget{ModelKey: update.ModelKey, Version: update.Version}
		config, ok := configs[target]
		if !ok || !config.Enabled || !contains(config.Surfaces, "embedding") {
			return validation("embedding endpoint target %s v%d is not enabled", update.ModelKey, update.Version)
		}
		if seen[target] {
			return validation("duplicate embedding endpoint update for %s v%d", update.ModelKey, update.Version)
		}
		seen[target] = true
		if !providerSlugPattern.MatchString(update.ProviderSlug) {
			return validation("embedding endpoint provider slug is invalid")
		}
		parsed, err := url.Parse(update.BaseURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return validation("embedding endpoint base URL must be absolute HTTPS")
		}
		if _, err := tx.Exec(ctx, `
			UPDATE model_configs
			SET provider_slug = $3, base_url = $4
			WHERE model_key = $1 AND version = $2`,
			update.ModelKey,
			update.Version,
			update.ProviderSlug,
			update.BaseURL,
		); err != nil {
			return err
		}
	}
	return nil
}

func applyExistingTargets(
	ctx context.Context,
	tx pgx.Tx,
	current RegistrySnapshot,
	targets map[existingTarget][]string,
	defaults map[string]existingTarget,
) (int64, int, error) {
	var disabled int64
	inserted := 0
	for _, c := range current.Configs {
		if !c.Enabled {
			continue
		}
		key := existingTarget{c.ModelKey, c.Version}
		surfaces, selected := targets[key]
		if !selected {
			if contains(c.Surfaces, "embedding") {
				continue
			}
			tag, err := tx.Exec(ctx, `
				UPDATE model_configs SET enabled = false, is_default_for = '{}'
				WHERE model_key = $1 AND version = $2 AND enabled`,
				c.ModelKey,
				c.Version,
			)
			if err != nil {
				return disabled, inserted, err
			}
			disabled += tag.RowsAffected()
			continue
		}
		var defaultFor []string
		for surface, target := range defaults {
			if target == key {
				defaultFor = append(defaultFor, surface)
			}
		}
		sort.Strings(defaultFor)
		if defaultFor == nil {
			defaultFor = []string{}
		}
		if !sameStringSet(surfaces, c.Surfaces) {
			var nextVersion int
			if err := tx.QueryRow(ctx, `
				SELECT COALESCE(max(version), 0) + 1
				FROM model_configs WHERE model_key = $1`,
				c.ModelKey).Scan(&nextVersion); err != nil {
				return disabled, inserted, err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO model_configs (
					model_key, version, display_name, provider_slug, base_url,
					provider_model_id, auth_mode, context_window_tokens, params,
					surfaces, micros_per_input_token,
					micros_per_cached_input_token, micros_per_output_token,
					enabled, is_default_for
				) VALUES (
					$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14
				)`,
				c.ModelKey, nextVersion, c.DisplayName, c.ProviderSlug,
				c.BaseURL, c.ProviderModelID, c.AuthMode,
				c.ContextWindowTokens, c.Params, surfaces,
				c.MicrosPerInputToken, c.MicrosPerCachedInputToken,
				c.MicrosPerOutputToken, defaultFor); err != nil {
				return disabled, inserted, err
			}
			inserted++
			tag, err := tx.Exec(ctx, `
				UPDATE model_configs
				SET enabled = false, is_default_for = '{}'
				WHERE model_key = $1 AND version = $2 AND enabled`,
				c.ModelKey, c.Version)
			if err != nil {
				return disabled, inserted, err
			}
			disabled += tag.RowsAffected()
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE model_configs
			SET is_default_for = $3
			WHERE model_key = $1 AND version = $2`,
			c.ModelKey, c.Version, defaultFor); err != nil {
			return disabled, inserted, err
		}
	}
	return disabled, inserted, nil
}

func applyDeprecations(
	ctx context.Context,
	tx pgx.Tx,
	deprecations []DeprecationFallback,
) (int64, int, error) {
	deprecations = append([]DeprecationFallback(nil), deprecations...)
	sort.Slice(deprecations, func(i, j int) bool {
		if deprecations[i].ModelKey != deprecations[j].ModelKey {
			return deprecations[i].ModelKey < deprecations[j].ModelKey
		}
		if deprecations[i].FallbackKey != deprecations[j].FallbackKey {
			return deprecations[i].FallbackKey < deprecations[j].FallbackKey
		}
		return deprecations[i].Surface < deprecations[j].Surface
	})
	type notice struct {
		userID, email, locale, fromKey, fromName, toKey, toName string
	}
	notices := make(map[string]notice)
	var remapped int64
	for _, dep := range deprecations {
		column, ok := userPreferenceColumns[dep.Surface]
		if !ok {
			return 0, 0, validation("surface %q has no user preference to remap", dep.Surface)
		}
		if dep.ModelKey == "" || dep.FallbackKey == "" || dep.ModelKey == dep.FallbackKey {
			return 0, 0, validation("deprecation needs distinct model and fallback keys")
		}
		var fromName, toName string
		if err := tx.QueryRow(ctx, `
			SELECT display_name FROM model_configs
			WHERE model_key=$1 ORDER BY version DESC LIMIT 1`,
			dep.ModelKey).Scan(&fromName); err != nil {
			return 0, 0, err
		}
		if err := tx.QueryRow(ctx, `
			SELECT display_name FROM model_configs
			WHERE model_key=$1 AND enabled AND $2=ANY(surfaces)
			ORDER BY version DESC LIMIT 1`,
			dep.FallbackKey, dep.Surface).Scan(&toName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, 0, validation(
					"fallback %q is not enabled for %s",
					dep.FallbackKey, dep.Surface,
				)
			}
			return 0, 0, err
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(`
			UPDATE users SET %s=$2, updated_at=now()
			WHERE %s=$1
			RETURNING id, COALESCE(email,''), locale`, column, column),
			dep.ModelKey, dep.FallbackKey)
		if err != nil {
			return 0, 0, err
		}
		for rows.Next() {
			var item notice
			if err := rows.Scan(&item.userID, &item.email, &item.locale); err != nil {
				rows.Close()
				return 0, 0, err
			}
			item.fromKey, item.fromName = dep.ModelKey, fromName
			item.toKey, item.toName = dep.FallbackKey, toName
			if _, exists := notices[item.userID]; !exists {
				notices[item.userID] = item
			}
			remapped++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return 0, 0, err
		}
		rows.Close()
	}
	userIDs := make([]string, 0, len(notices))
	for userID := range notices {
		userIDs = append(userIDs, userID)
	}
	sort.Strings(userIDs)
	for _, userID := range userIDs {
		item := notices[userID]
		payload, err := json.Marshal(map[string]string{
			"code": "model_deprecated", "fromKey": item.fromKey,
			"fromName": item.fromName, "toKey": item.toKey, "toName": item.toName,
		})
		if err != nil {
			return 0, 0, err
		}
		if _, err := store.NotifyTx(ctx, tx, store.NotifyParams{
			UserID: item.userID, ToEmail: item.email, Locale: item.locale,
			Kind: store.NotifSystem, Data: payload, Href: "/settings?tab=llm",
			Template: "model-deprecated", Category: "billing",
			IdempotencyKey: fmt.Sprintf(
				"model-deprecated:%s:%s:%s",
				item.fromKey, item.toKey, item.userID,
			),
		}); err != nil {
			return 0, 0, err
		}
	}
	return remapped, len(userIDs), nil
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func appendUnique(values []string, value string) []string {
	if contains(values, value) {
		return values
	}
	return append(values, value)
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]int, len(left))
	for _, value := range left {
		seen[value]++
	}
	for _, value := range right {
		seen[value]--
		if seen[value] < 0 {
			return false
		}
	}
	return true
}

func validation(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

func IsValidation(err error) bool {
	var target *ValidationError
	return errors.As(err, &target)
}

func IsConflict(err error) bool {
	var target *ConflictError
	return errors.As(err, &target)
}
