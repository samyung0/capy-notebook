package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/embeddingpins"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

var providerSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var embeddingPinLookup = embeddingpins.Lookup

type ValidationError struct {
	Message   string
	Code      string
	ModelSlug string
	Slot      string
	Reason    string
}

func (e *ValidationError) Error() string { return e.Message }

type ConflictError struct{ Current RegistrySnapshot }

func (e *ConflictError) Error() string {
	return "the registry changed; reload and review the new version"
}

type RegistryStore struct {
	read  *pgxpool.Pool
	admin *AdminStore
}

func NewRegistryStore(read, write *pgxpool.Pool) *RegistryStore {
	return &RegistryStore{read: read, admin: NewAdminStore(write)}
}

func NewRegistryStoreWithAdmin(read *pgxpool.Pool, admin *AdminStore) *RegistryStore {
	return &RegistryStore{read: read, admin: admin}
}

func (s *RegistryStore) WriteConfigured() bool {
	return s != nil && s.admin != nil && s.admin.Configured()
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
		Slots:                    models.AllSlots(),
		Capabilities:             models.OperatorCapabilities(),
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
		SELECT version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params,
			slots, capabilities, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for,
			created_at, updated_at, created_by, updated_by
		FROM model_configs ORDER BY provider_slug, model_slug, version`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var c CatalogConfig
		if err := rows.Scan(&c.Version, &c.ProviderName, &c.ModelName,
			&c.ProviderSlug, &c.ModelSlug, &c.PlatformEnabled, &c.ByokEnabled,
			&c.ContextWindowTokens, &c.ThinkingLevels, &c.DefaultThinking, &c.Params, &c.Slots,
			&c.Capabilities, &c.MicrosPerInputToken, &c.MicrosPerCachedInputToken,
			&c.MicrosPerOutputToken, &c.Enabled, &c.IsDefaultFor,
			&c.CreatedAt, &c.UpdatedAt, &c.CreatedBy, &c.UpdatedBy); err != nil {
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
	catalog := models.MustEliteLLMProviders()
	for _, provider := range catalog.All() {
		out.ProviderCredentials = append(
			out.ProviderCredentials,
			ProviderCredentialAvailability{
				ProviderSlug: provider.Slug,
				Environment:  provider.PlatformEnv,
				Configured:   os.Getenv(provider.PlatformEnv) != "",
			},
		)
	}
	for index := range out.Configs {
		config := &out.Configs[index]
		if !contains(config.Slots, models.SlotRetrieval) {
			continue
		}
		config.EmbeddingDefaultEligible, config.EmbeddingValidationError, err =
			embeddingEligibility(ctx, q, *config)
		if err != nil {
			return out, err
		}
	}
	rows, err = q.Query(ctx, `
		SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version,
			COALESCE((SELECT (mc.params->>'dimensions')::int
				FROM model_configs mc
				WHERE mc.provider_slug = w.embedding_provider_slug
				  AND mc.model_slug = w.embedding_model_slug
				  AND mc.version = w.embedding_model_version), 0),
			count(*)
		FROM workspaces w
		GROUP BY embedding_provider_slug, embedding_model_slug, embedding_model_version
		ORDER BY embedding_provider_slug, embedding_model_slug, embedding_model_version`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item EmbeddingWorkspaceCount
		if err := rows.Scan(&item.ProviderSlug, &item.ModelSlug, &item.Version, &item.Dim, &item.Count); err != nil {
			return out, err
		}
		out.EmbeddingWorkspaceCounts = append(out.EmbeddingWorkspaceCounts, item)
	}
	return out, rows.Err()
}

func credentialEnv(provider string) string {
	return models.MustEliteLLMProviders().CredentialEnv(provider)
}

type compiledDraft struct {
	gridDraft
	Version    int
	Slots      []string
	DefaultFor []string
}

type CellTarget struct {
	Kind    string
	Model   models.Ref
	Version int
	DraftID string
}

type GridCell struct {
	Row       models.Ref
	Slot      string
	Target    CellTarget
	IsDefault bool
}

type gridDraft struct {
	ID                        string
	ProviderName              string
	ModelName                 string
	ProviderSlug              string
	ModelSlug                 string
	PlatformEnabled           bool
	ByokEnabled               bool
	ContextWindowTokens       int
	ThinkingLevels            []string
	DefaultThinking           string
	Params                    json.RawMessage
	Capabilities              []string
	MicrosPerInputToken       int64
	MicrosPerCachedInputToken int64
	MicrosPerOutputToken      int64
}

func (d gridDraft) Ref() models.Ref {
	return models.Ref{ProviderSlug: d.ProviderSlug, ModelSlug: d.ModelSlug}
}

type gridSaveRequest struct {
	ExpectedVersion       int64
	Cells                 []GridCell
	Drafts                []gridDraft
	EmbeddingAcknowledged bool
	ActorID               string
}

type RegistrySaveResult struct {
	Version       int64
	DisabledRows  int64
	RemappedUsers int64
	InsertedRows  int
	Notifications int
}

type existingTarget struct {
	models.Ref
	Version int
}

func activeToGrid(req RegistrySaveRequest, current RegistrySnapshot) (gridSaveRequest, error) {
	grid := gridSaveRequest{
		ExpectedVersion:       req.Revision,
		EmbeddingAcknowledged: req.AcknowledgeEmbeddingRetarget,
	}
	latest := make(map[models.Ref]CatalogConfig)
	for _, config := range current.Configs {
		ref := config.Ref()
		if config.Enabled && config.Version > latest[ref].Version {
			latest[ref] = config
		}
	}
	seenModels := make(map[models.Ref]bool)
	for _, draft := range req.Active {
		ref := models.Ref{ProviderSlug: draft.ProviderSlug, ModelSlug: draft.ModelSlug}
		if seenModels[ref] {
			return grid, validation("active provider/model identities must be unique")
		}
		seenModels[ref] = true
		if len(draft.Slots) == 0 {
			return grid, validation("active config %s needs at least one slot", ref)
		}
		slots, err := uniqueSlots(draft.Slots)
		if err != nil {
			return grid, err
		}
		defaults, err := uniqueSlots(draft.DefaultFor)
		if err != nil {
			return grid, err
		}
		for _, slot := range defaults {
			if !contains(slots, slot) {
				return grid, validation("default %s is not served by %s", slot, ref)
			}
		}
		capabilities, err := uniqueCapabilities(draft.Capabilities)
		if err != nil {
			return grid, err
		}
		internal := gridDraft{
			ID:           ref.String(),
			ProviderName: draft.ProviderName, ModelName: draft.ModelName,
			ProviderSlug: draft.ProviderSlug, ModelSlug: draft.ModelSlug,
			PlatformEnabled: draft.PlatformEnabled, ByokEnabled: draft.ByokEnabled,
			ContextWindowTokens: draft.ContextWindowTokens,
			ThinkingLevels:      append([]string(nil), draft.ThinkingLevels...),
			DefaultThinking:     draft.DefaultThinking,
			Params:              draft.Params, Capabilities: capabilities,
			MicrosPerInputToken:       draft.Rates.InputMicros,
			MicrosPerCachedInputToken: draft.Rates.CachedInputMicros,
			MicrosPerOutputToken:      draft.Rates.OutputMicros,
		}
		currentConfig, exists := latest[ref]
		if err := bindEliteLLMDraft(&internal, slots); err != nil {
			return grid, err
		}
		embedding := contains(slots, models.SlotRetrieval)
		if embedding {
			if !exists || !contains(currentConfig.Slots, models.SlotRetrieval) {
				return grid, validation("new embedding rows require a schema and code deploy")
			}
			if err := validateEmbeddingDraft(currentConfig, internal, slots); err != nil {
				return grid, err
			}
		} else {
			if err := validateDraft(internal); err != nil {
				return grid, err
			}
			if err := validateConfigForSlots(internal, slots); err != nil {
				return grid, err
			}
		}
		target := CellTarget{Kind: "draft", DraftID: internal.ID}
		if embedding || exists && configIdentityMatches(currentConfig, internal) {
			target = CellTarget{
				Kind: "existing", Model: currentConfig.Ref(),
				Version: currentConfig.Version,
			}
		} else {
			grid.Drafts = append(grid.Drafts, internal)
		}
		for _, slot := range slots {
			grid.Cells = append(grid.Cells, GridCell{
				Row: ref, Slot: slot, Target: target,
				IsDefault: contains(defaults, slot),
			})
		}
	}
	for _, config := range current.Configs {
		if config.Enabled && contains(config.Slots, models.SlotRetrieval) &&
			!seenModels[config.Ref()] {
			return grid, validation("embedding model %s must remain active", config.Ref())
		}
	}
	sort.Slice(grid.Cells, func(i, j int) bool {
		if grid.Cells[i].Row == grid.Cells[j].Row {
			return grid.Cells[i].Slot < grid.Cells[j].Slot
		}
		if grid.Cells[i].Row.ProviderSlug == grid.Cells[j].Row.ProviderSlug {
			return grid.Cells[i].Row.ModelSlug < grid.Cells[j].Row.ModelSlug
		}
		return grid.Cells[i].Row.ProviderSlug < grid.Cells[j].Row.ProviderSlug
	})
	return grid, nil
}

func uniqueSlots(values []string) ([]string, error) {
	seen := make(map[string]bool)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, known := models.ParseSlot(value); !known {
			return nil, validation("unknown slot %q", value)
		}
		if seen[value] {
			return nil, validation("duplicate slot %q", value)
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

// uniqueCapabilities accepts only operator-set capabilities. agentic_loop is
// derived from the certification file and is rejected here on purpose.
func uniqueCapabilities(values []string) ([]string, error) {
	seen := make(map[string]bool)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, known := models.ParseCapability(value); !known {
			return nil, validation("unknown capability %q", value)
		}
		if seen[value] {
			return nil, validation("duplicate capability %q", value)
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

func configIdentityMatches(current CatalogConfig, draft gridDraft) bool {
	return current.ProviderName == draft.ProviderName &&
		current.ModelName == draft.ModelName &&
		current.ProviderSlug == draft.ProviderSlug &&
		current.ModelSlug == draft.ModelSlug &&
		current.PlatformEnabled == draft.PlatformEnabled &&
		current.ByokEnabled == draft.ByokEnabled &&
		sameStringSet(current.ThinkingLevels, draft.ThinkingLevels) &&
		current.DefaultThinking == draft.DefaultThinking &&
		current.ContextWindowTokens == draft.ContextWindowTokens &&
		sameJSON(current.Params, draft.Params) &&
		sameStringSet(current.Capabilities, draft.Capabilities) &&
		current.MicrosPerInputToken == draft.MicrosPerInputToken &&
		current.MicrosPerCachedInputToken == draft.MicrosPerCachedInputToken &&
		current.MicrosPerOutputToken == draft.MicrosPerOutputToken
}

func validateEmbeddingDraft(
	current CatalogConfig,
	draft gridDraft,
	slots []string,
) error {
	if !sameStringSet(current.Slots, slots) ||
		current.ProviderName != draft.ProviderName ||
		current.ModelName != draft.ModelName ||
		current.ModelSlug != draft.ModelSlug ||
		current.PlatformEnabled != draft.PlatformEnabled ||
		current.ByokEnabled != draft.ByokEnabled ||
		!sameStringSet(current.ThinkingLevels, draft.ThinkingLevels) ||
		current.DefaultThinking != draft.DefaultThinking ||
		current.ContextWindowTokens != draft.ContextWindowTokens ||
		!sameJSON(current.Params, draft.Params) ||
		!sameStringSet(current.Capabilities, draft.Capabilities) ||
		current.MicrosPerInputToken != draft.MicrosPerInputToken ||
		current.MicrosPerCachedInputToken != draft.MicrosPerCachedInputToken ||
		current.MicrosPerOutputToken != draft.MicrosPerOutputToken {
		return validation("retrieval identity, params, capabilities, rates, and slots are immutable")
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
		if contains(config.IsDefaultFor, models.SlotRetrieval) {
			currentTarget = existingTarget{Ref: config.Ref(), Version: config.Version}
			break
		}
	}
	for _, cell := range req.Cells {
		if cell.Slot != models.SlotRetrieval || !cell.IsDefault {
			continue
		}
		return (cell.Target.Kind != "existing" && cell.Target.Kind != "catalog") ||
			cell.Target.Model != currentTarget.Ref ||
			cell.Target.Version != currentTarget.Version
	}
	return currentTarget != (existingTarget{})
}

func (s *RegistryStore) Save(
	ctx context.Context,
	principal Principal,
	req RegistrySaveRequest,
) (RegistrySnapshot, error) {
	if !principal.Has(PermWriteRegistry) {
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
	grid.ActorID = principal.UserID
	writer, err := s.admin.writer(ctx)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	tx, err := writer.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return RegistrySnapshot{}, err
	}
	defer tx.Rollback(ctx)
	result, err := s.saveTx(ctx, tx, grid)
	if err != nil {
		return RegistrySnapshot{}, err
	}
	if _, err := tx.Exec(ctx, `
		SELECT record_registry_audit($1, $2, $3, $4, $5, $6, $7)`,
		principal.UserID, req.Revision, result.Version,
		result.InsertedRows, result.DisabledRows, result.RemappedUsers,
		obs.TraceID(ctx),
	); err != nil {
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
	if strings.TrimSpace(req.ActorID) == "" {
		req.ActorID = "system"
	}
	writer, err := s.admin.writer(ctx)
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
	actorID := strings.TrimSpace(req.ActorID)
	if actorID == "" {
		actorID = "system"
	}
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
		_, err = tx.Exec(ctx, insertModelConfigSQL,
			drafts[i].Version, drafts[i].ProviderName, drafts[i].ModelName,
			drafts[i].ProviderSlug, drafts[i].ModelSlug,
			drafts[i].PlatformEnabled, drafts[i].ByokEnabled,
			drafts[i].ContextWindowTokens, orEmpty(drafts[i].ThinkingLevels), drafts[i].DefaultThinking,
			drafts[i].Params, drafts[i].Slots, orEmpty(drafts[i].Capabilities),
			drafts[i].MicrosPerInputToken, drafts[i].MicrosPerCachedInputToken,
			drafts[i].MicrosPerOutputToken, drafts[i].DefaultFor, actorID)
		if err != nil {
			return result, err
		}
		result.InsertedRows++
	}
	disabled, inserted, err := applyExistingTargets(
		ctx, tx, current, existing, defaults, actorID,
	)
	if err != nil {
		return result, err
	}
	result.DisabledRows += disabled
	result.InsertedRows += inserted
	remapped, err := remapPrefsToDefaults(ctx, tx)
	if err != nil {
		return result, err
	}
	result.RemappedUsers += remapped
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
		configs[existingTarget{Ref: c.Ref(), Version: c.Version}] = c
	}
	draftByID := make(map[string]gridDraft)
	for i := range req.Drafts {
		d := req.Drafts[i]
		capabilities, err := uniqueCapabilities(d.Capabilities)
		if err != nil {
			return nil, nil, nil, err
		}
		d.Capabilities = capabilities
		if err := bindEliteLLMDraft(&d, nil); err != nil {
			return nil, nil, nil, err
		}
		if err := validateDraft(d); err != nil {
			return nil, nil, nil, err
		}
		if _, exists := draftByID[d.ID]; exists {
			return nil, nil, nil, validation("duplicate draft id %q", d.ID)
		}
		draftByID[d.ID] = d
	}
	type draftUse struct {
		slots    []string
		defaults []string
	}
	draftUses := make(map[string]*draftUse)
	existing := make(map[existingTarget][]string)
	defaults := make(map[string]existingTarget)
	seenCells := make(map[string]bool)
	for _, cell := range req.Cells {
		if _, known := models.ParseSlot(cell.Slot); !known {
			return nil, nil, nil, validation("unknown slot %q", cell.Slot)
		}
		if cell.Row.Zero() {
			return nil, nil, nil, validation("row model is required")
		}
		cellID := cell.Row.ProviderSlug + "\x00" + cell.Row.ModelSlug + "\x00" + cell.Slot
		if seenCells[cellID] {
			return nil, nil, nil, validation("duplicate cell for %s/%s", cell.Row, cell.Slot)
		}
		seenCells[cellID] = true
		if cell.Target.Kind == "existing" || cell.Target.Kind == "catalog" {
			key := existingTarget{Ref: cell.Target.Model, Version: cell.Target.Version}
			c, ok := configs[key]
			if !ok || !c.Enabled {
				return nil, nil, nil, validation("unknown enabled target %s v%d", key.Ref, key.Version)
			}
			if cell.Row != key.Ref {
				return nil, nil, nil, validation("aliases are not supported: row model must equal target model")
			}
			if cell.Slot == models.SlotRetrieval && !contains(c.Slots, models.SlotRetrieval) {
				return nil, nil, nil, validation("new retrieval rows require a schema and code deploy")
			}
			if err := validateSlotAssignment(c.ProviderSlug, c.ModelSlug, c.Capabilities, cell.Slot); err != nil {
				return nil, nil, nil, err
			}
			existing[key] = appendUnique(existing[key], cell.Slot)
			if cell.IsDefault {
				if _, duplicate := defaults[cell.Slot]; duplicate {
					return nil, nil, nil, validation("slot %q has more than one default", cell.Slot)
				}
				defaults[cell.Slot] = key
			}
		} else if cell.Target.Kind == "draft" {
			d, ok := draftByID[cell.Target.DraftID]
			if !ok {
				return nil, nil, nil, validation("unknown draft %q", cell.Target.DraftID)
			}
			if cell.Row != d.Ref() {
				return nil, nil, nil, validation("aliases are not supported: row model must equal draft model")
			}
			if cell.Slot == models.SlotRetrieval {
				return nil, nil, nil, validation("new retrieval catalog rows require a schema migration and cannot be created here")
			}
			use := draftUses[d.ID]
			if use == nil {
				use = &draftUse{}
				draftUses[d.ID] = use
			}
			use.slots = appendUnique(use.slots, cell.Slot)
			if cell.IsDefault {
				if _, duplicate := defaults[cell.Slot]; duplicate {
					return nil, nil, nil, validation("slot %q has more than one default", cell.Slot)
				}
				use.defaults = appendUnique(use.defaults, cell.Slot)
				defaults[cell.Slot] = existingTarget{Ref: d.Ref(), Version: -1}
			}
		} else {
			return nil, nil, nil, validation("cell target kind must be existing or draft")
		}
	}
	requiredDefaults := make(map[string]bool)
	for _, config := range current.Configs {
		for _, slot := range config.IsDefaultFor {
			requiredDefaults[slot] = true
		}
	}
	for slot := range requiredDefaults {
		if _, ok := defaults[slot]; !ok {
			return nil, nil, nil, validation("slot %q needs exactly one default", slot)
		}
	}
	if err := enforceEmbeddingUnchanged(current, existing); err != nil {
		return nil, nil, nil, err
	}
	var drafts []compiledDraft
	for id, use := range draftUses {
		if len(use.slots) == 0 {
			continue
		}
		d := draftByID[id]
		sort.Strings(use.slots)
		sort.Strings(use.defaults)
		if use.defaults == nil {
			use.defaults = []string{}
		}
		if !d.PlatformEnabled && len(use.defaults) > 0 {
			return nil, nil, nil, validation("BYOK-only draft %q cannot be a default", d.ID)
		}
		if err := bindEliteLLMDraft(&d, use.slots); err != nil {
			return nil, nil, nil, err
		}
		if err := validateConfigForSlots(d, use.slots); err != nil {
			return nil, nil, nil, err
		}
		drafts = append(drafts, compiledDraft{gridDraft: d, Slots: use.slots, DefaultFor: use.defaults})
	}
	for target, slots := range existing {
		config := configs[target]
		sortedSlots := append([]string(nil), slots...)
		sort.Strings(sortedSlots)
		currentSlots := append([]string(nil), config.Slots...)
		sort.Strings(currentSlots)
		if strings.Join(sortedSlots, "\x00") == strings.Join(currentSlots, "\x00") {
			continue
		}
		var defaultFor []string
		for slot, defaultTarget := range defaults {
			if defaultTarget == target {
				defaultFor = append(defaultFor, slot)
			}
		}
		sort.Strings(defaultFor)
		if defaultFor == nil {
			defaultFor = []string{}
		}
		drafts = append(drafts, compiledDraft{
			gridDraft: gridDraft{
				ID:                        fmt.Sprintf("catalog:%s:%d", target.Ref, target.Version),
				ProviderName:              config.ProviderName,
				ModelName:                 config.ModelName,
				ProviderSlug:              config.ProviderSlug,
				ModelSlug:                 config.ModelSlug,
				PlatformEnabled:           config.PlatformEnabled,
				ByokEnabled:               config.ByokEnabled,
				ContextWindowTokens:       config.ContextWindowTokens,
				ThinkingLevels:            append([]string(nil), config.ThinkingLevels...),
				DefaultThinking:           config.DefaultThinking,
				Params:                    config.Params,
				Capabilities:              append([]string(nil), config.Capabilities...),
				MicrosPerInputToken:       config.MicrosPerInputToken,
				MicrosPerCachedInputToken: config.MicrosPerCachedInputToken,
				MicrosPerOutputToken:      config.MicrosPerOutputToken,
			},
			Slots:      sortedSlots,
			DefaultFor: defaultFor,
		})
		delete(existing, target)
	}
	sort.Slice(drafts, func(i, j int) bool { return drafts[i].ID < drafts[j].ID })
	return drafts, existing, defaults, nil
}

func validateEmbeddingPins(current RegistrySnapshot) error {
	for _, config := range current.Configs {
		if !config.Enabled || !contains(config.Slots, models.SlotRetrieval) {
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
	target, ok := defaults[models.SlotRetrieval]
	if !ok {
		return nil
	}
	var config *CatalogConfig
	for index := range current.Configs {
		candidate := &current.Configs[index]
		if candidate.Ref() == target.Ref &&
			candidate.Version == target.Version {
			config = candidate
			break
		}
	}
	if config == nil || !config.Enabled ||
		!contains(config.Slots, models.SlotRetrieval) {
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
			config.Ref(), config.Version,
		), nil
	}
	spec, allowed := embeddingPinLookup(models.Pin{
		Ref: models.Ref{ProviderSlug: config.ProviderSlug, ModelSlug: config.ModelSlug}, Version: config.Version,
	})
	if !allowed || spec.VectorTable != params.VectorTable ||
		spec.Dimensions != params.Dimensions {
		return false, fmt.Sprintf(
			"embedding default %s v%d is not in the server vector-table allowlist",
			config.Ref(), config.Version,
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
	if d.ID == "" {
		return validation("draft id is required")
	}
	if strings.TrimSpace(d.ProviderName) == "" || strings.TrimSpace(d.ModelName) == "" ||
		strings.TrimSpace(d.ModelSlug) == "" {
		return validation("draft %q needs provider name, model name, and model slug", d.ID)
	}
	if !providerSlugPattern.MatchString(d.ProviderSlug) {
		return validation("draft %q has an invalid provider slug", d.ID)
	}
	if !d.PlatformEnabled && !d.ByokEnabled {
		return validation("draft %q needs platform or BYOK enabled", d.ID)
	}
	if !d.PlatformEnabled &&
		(d.MicrosPerInputToken != 0 || d.MicrosPerCachedInputToken != 0 || d.MicrosPerOutputToken != 0) {
		return validation("BYOK-only draft %q must have zero platform credit rates", d.ID)
	}
	if d.PlatformEnabled &&
		(d.MicrosPerInputToken <= 0 || d.MicrosPerCachedInputToken <= 0 || d.MicrosPerOutputToken <= 0) {
		return validation("platform draft %q needs positive input, cached-input, and output rates", d.ID)
	}
	var params map[string]any
	if len(d.Params) == 0 || json.Unmarshal(d.Params, &params) != nil || params == nil {
		return validation("draft %q params must be a JSON object", d.ID)
	}
	return nil
}

func validateConfigForSlots(d gridDraft, slots []string) error {
	if err := models.ValidateThinking(slots, d.ThinkingLevels, d.DefaultThinking); err != nil {
		return validation("draft %q: %v", d.ID, err)
	}
	for _, slot := range slots {
		if models.IsLLMSlot(slot) && d.ContextWindowTokens <= 0 {
			return validation("draft %q needs a positive context window", d.ID)
		}
	}
	return nil
}

func enforceEmbeddingUnchanged(
	current RegistrySnapshot,
	existing map[existingTarget][]string,
) error {
	for _, c := range current.Configs {
		if !c.Enabled || !contains(c.Slots, models.SlotRetrieval) {
			continue
		}
		target := existingTarget{Ref: c.Ref(), Version: c.Version}
		slots := existing[target]
		if !contains(slots, models.SlotRetrieval) ||
			!sameStringSet(slots, c.Slots) {
			return validation("retrieval rows cannot be removed, disabled, or reassigned")
		}
	}
	return nil
}

func assignDraftVersion(ctx context.Context, tx pgx.Tx, draft *compiledDraft) error {
	return tx.QueryRow(ctx,
		`SELECT COALESCE(max(version), 0) + 1 FROM model_configs
		  WHERE provider_slug = $1 AND model_slug = $2`,
		draft.ProviderSlug, draft.ModelSlug).Scan(&draft.Version)
}

func applyExistingTargets(
	ctx context.Context,
	tx pgx.Tx,
	current RegistrySnapshot,
	targets map[existingTarget][]string,
	defaults map[string]existingTarget,
	actorID string,
) (int64, int, error) {
	var disabled int64
	inserted := 0
	for _, c := range current.Configs {
		if !c.Enabled {
			continue
		}
		key := existingTarget{Ref: c.Ref(), Version: c.Version}
		slots, selected := targets[key]
		if !selected {
			if contains(c.Slots, models.SlotRetrieval) {
				continue
			}
			tag, err := tx.Exec(ctx, `
				UPDATE model_configs
				SET enabled = false, is_default_for = '{}', updated_at = now(), updated_by = $4
				WHERE provider_slug = $1 AND model_slug = $2 AND version = $3 AND enabled`,
				c.ProviderSlug, c.ModelSlug, c.Version, actorID,
			)
			if err != nil {
				return disabled, inserted, err
			}
			disabled += tag.RowsAffected()
			continue
		}
		var defaultFor []string
		for slot, target := range defaults {
			if target == key {
				defaultFor = append(defaultFor, slot)
			}
		}
		sort.Strings(defaultFor)
		if defaultFor == nil {
			defaultFor = []string{}
		}
		if !sameStringSet(slots, c.Slots) {
			var nextVersion int
			if err := tx.QueryRow(ctx, `
				SELECT COALESCE(max(version), 0) + 1
				FROM model_configs WHERE provider_slug = $1 AND model_slug = $2`,
				c.ProviderSlug, c.ModelSlug).Scan(&nextVersion); err != nil {
				return disabled, inserted, err
			}
			if _, err := tx.Exec(ctx, insertModelConfigSQL,
				nextVersion, c.ProviderName, c.ModelName, c.ProviderSlug,
				c.ModelSlug, c.PlatformEnabled, c.ByokEnabled,
				c.ContextWindowTokens, orEmpty(c.ThinkingLevels), c.DefaultThinking,
				c.Params, slots, orEmpty(c.Capabilities),
				c.MicrosPerInputToken, c.MicrosPerCachedInputToken,
				c.MicrosPerOutputToken, defaultFor, actorID); err != nil {
				return disabled, inserted, err
			}
			inserted++
			tag, err := tx.Exec(ctx, `
				UPDATE model_configs
				SET enabled = false, is_default_for = '{}', updated_at = now(), updated_by = $4
				WHERE provider_slug = $1 AND model_slug = $2 AND version = $3 AND enabled`,
				c.ProviderSlug, c.ModelSlug, c.Version, actorID)
			if err != nil {
				return disabled, inserted, err
			}
			disabled += tag.RowsAffected()
			continue
		}
		if sameStringSet(defaultFor, c.IsDefaultFor) {
			if len(defaultFor) == 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `
				UPDATE model_configs
				SET is_default_for = $4
				WHERE provider_slug = $1 AND model_slug = $2 AND version = $3`,
				c.ProviderSlug, c.ModelSlug, c.Version, defaultFor); err != nil {
				return disabled, inserted, err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE model_configs
			SET is_default_for = $4, updated_at = now(), updated_by = $5
			WHERE provider_slug = $1 AND model_slug = $2 AND version = $3`,
			c.ProviderSlug, c.ModelSlug, c.Version, defaultFor, actorID); err != nil {
			return disabled, inserted, err
		}
	}
	return disabled, inserted, nil
}

const insertModelConfigSQL = `
	INSERT INTO model_configs (
		version, provider_name, model_name, provider_slug, model_slug,
		platform_enabled, byok_enabled, context_window_tokens,
		thinking_levels, default_thinking, params,
		slots, capabilities, micros_per_input_token,
		micros_per_cached_input_token, micros_per_output_token,
		enabled, is_default_for, created_by, updated_by
	) VALUES (
		$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18,$18
	)`

func remapPrefsToDefaults(ctx context.Context, tx pgx.Tx) (int64, error) {
	var remapped int64
	for slot, columns := range userPreferenceColumns {
		var defaultRef models.Ref
		err := tx.QueryRow(ctx, `
			SELECT provider_slug, model_slug FROM model_configs
			 WHERE enabled AND $1 = ANY(is_default_for)
			 ORDER BY version DESC LIMIT 1`, slot).Scan(&defaultRef.ProviderSlug, &defaultRef.ModelSlug)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return remapped, validation("slot %q needs exactly one default", slot)
			}
			return remapped, err
		}
		browserGuard := ""
		if slot == models.SlotQuiz {
			browserGuard = fmt.Sprintf("AND u.%s <> 'browser'", columns.Provider)
		}
		tag, err := tx.Exec(ctx, fmt.Sprintf(`
			UPDATE users u SET %s = $1, %s = $2, updated_at = now()
			 WHERE (u.%s, u.%s) IS DISTINCT FROM ($1, $2)
			   %s
			   AND NOT EXISTS (
			     SELECT 1 FROM model_configs c
			      WHERE c.provider_slug = u.%s
			        AND c.model_slug = u.%s
			        AND c.enabled
			        AND $3 = ANY(c.slots)
			        AND (
			          c.platform_enabled
			          OR (
			            c.byok_enabled
			            AND EXISTS (
			              SELECT 1 FROM user_llm_credentials k
			               WHERE k.user_id = u.id
			                 AND k.provider_slug = c.provider_slug
			            )
			          )
			        )
			   )`, columns.Provider, columns.Model,
			columns.Provider, columns.Model, browserGuard,
			columns.Provider, columns.Model),
			defaultRef.ProviderSlug, defaultRef.ModelSlug, slot)
		if err != nil {
			return remapped, err
		}
		remapped += tag.RowsAffected()
	}
	return remapped, nil
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// orEmpty keeps a nil list from reaching Postgres as NULL on a NOT NULL array.
func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
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

func listEliteLLMProviders() EliteLLMProviderPage {
	catalog := models.MustEliteLLMProviders()
	out := EliteLLMProviderPage{Providers: []EliteLLMProvider{}}
	for _, provider := range catalog.All() {
		out.Providers = append(out.Providers, EliteLLMProvider{
			Slug:        provider.Slug,
			Name:        provider.Name,
			BYOK:        provider.BYOK,
			PlatformEnv: provider.PlatformEnv,
			Thinking:    append([]string(nil), provider.Thinking...),
		})
	}
	return out
}

func validation(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

func codedValidation(code, message, modelSlug, slot, reason string) error {
	return &ValidationError{
		Code:      code,
		Message:   message,
		ModelSlug: modelSlug,
		Slot:      slot,
		Reason:    reason,
	}
}

func bindEliteLLMDraft(draft *gridDraft, slots []string) error {
	catalog, err := models.LoadEliteLLMProviders()
	if err != nil {
		return err
	}
	slug := strings.TrimSpace(draft.ProviderSlug)
	modelSlug := strings.TrimSpace(draft.ModelSlug)
	if slug == "" || modelSlug == "" {
		return codedValidation(
			"unknown_provider",
			"provider and model slug are required",
			modelSlug, "", "provider or model slug is empty",
		)
	}
	if slug != draft.ProviderSlug || modelSlug != draft.ModelSlug {
		return validation("provider and model slugs must not have leading or trailing whitespace")
	}
	if !catalog.Known(slug) {
		return codedValidation(
			"unknown_provider",
			fmt.Sprintf("provider %q is not handled by elitellm", slug),
			modelSlug, "", "provider is not in elitellm_providers.json",
		)
	}
	if allowed, reason := catalog.AllowsModel(slug, modelSlug); !allowed {
		return codedValidation("hop_not_allowed", reason, modelSlug, "", reason)
	}
	if allowed, reason := catalog.AllowsThinking(slug, draft.ThinkingLevels); !allowed {
		return codedValidation("invalid_thinking", reason, modelSlug, "", reason)
	}
	if draft.PlatformEnabled {
		if ok, reason := catalog.PlatformEnvConfigured(slug); !ok {
			return codedValidation(
				"missing_platform_env",
				fmt.Sprintf("platform path for %s requires %s", slug, catalog.CredentialEnv(slug)),
				modelSlug, "", reason,
			)
		}
	}
	if spec, ok := catalog.Lookup(slug); ok && !spec.BYOK && draft.ByokEnabled {
		return codedValidation(
			"byok_not_supported",
			fmt.Sprintf("%s does not support BYOK", slug),
			modelSlug, "", "provider byok is false",
		)
	}
	for _, slot := range slots {
		if err := validateSlotAssignment(slug, modelSlug, draft.Capabilities, slot); err != nil {
			return err
		}
	}
	return nil
}

// validateSlotAssignment is the single gate for putting a row into a slot:
// the slot must exist and the row must carry every capability the slot
// requires. It runs for drafts and for existing rows alike so a stale row
// cannot keep a slot it no longer qualifies for.
func validateSlotAssignment(providerSlug, modelSlug string, capabilities []string, slot string) error {
	parsedSlot, known := models.ParseSlot(slot)
	if !known {
		return codedValidation(
			"unsupported_slot",
			fmt.Sprintf("slot %q is unknown", slot),
			modelSlug, slot, "slot is not registered",
		)
	}
	certified := models.AgenticLoopCertified(providerSlug, modelSlug)
	missing, ok := models.MissingCapability(parsedSlot, capabilities, certified)
	if !ok {
		return nil
	}
	if missing == models.CapabilityAgenticLoop {
		return codedValidation(
			"agentic_loop_not_certified",
			fmt.Sprintf("%s is not certified for the %s agentic loop", modelSlug, slot),
			modelSlug, slot, "two-turn streaming replay cassette is missing",
		)
	}
	return codedValidation(
		"capability_missing",
		fmt.Sprintf("%s lacks the %s capability required by the %s slot", modelSlug, missing, slot),
		modelSlug, slot, fmt.Sprintf("row capabilities omit %s", missing),
	)
}

func IsValidation(err error) bool {
	var target *ValidationError
	return errors.As(err, &target)
}

func IsConflict(err error) bool {
	var target *ConflictError
	return errors.As(err, &target)
}
