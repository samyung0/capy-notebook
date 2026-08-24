package ops

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	RoleViewer = "viewer"
	RoleAdmin  = "admin"
)

var ErrForbidden = errors.New("operator access denied")

type Principal struct {
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

var Surfaces = []string{"chat", "generate", "editor", "quiz", "ingest", "embedding", "vision"}

var userPreferenceColumns = map[string]string{
	"chat": "chat_model_key", "generate": "generate_model_key",
	"editor": "editor_model_key", "quiz": "quiz_model_key",
}

type Session struct {
	UserID string `json:"userId"`
	Email  string `json:"email,omitempty"`
	Name   string `json:"name,omitempty"`
	Role   string `json:"role"`
}

type UsagePoint struct {
	Day          string `json:"day"`
	Key          string `json:"key"`
	CreditMicros int64  `json:"creditMicros"`
}

type RankedUser struct {
	UserID       string `json:"userId"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	PlanTier     string `json:"planTier"`
	CreditMicros int64  `json:"creditMicros"`
}

type StorageUser struct {
	UserID    string `json:"userId"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	UsedBytes int64  `json:"usedBytes"`
}

type JobCounters struct {
	Queued    int64 `json:"queued"`
	Running   int64 `json:"running"`
	Failed24h int64 `json:"failed24h"`
}

type Overview struct {
	TodayCredits       int64         `json:"todayCredits"`
	MonthCredits       int64         `json:"monthCredits"`
	ByKind             []UsagePoint  `json:"byKind"`
	BySurface          []UsagePoint  `json:"bySurface"`
	TopUsers           []RankedUser  `json:"topUsers"`
	StorageTotal       int64         `json:"storageTotal"`
	TopStorage         []StorageUser `json:"topStorage"`
	SignupsToday       int64         `json:"signupsToday"`
	ActiveWorkspaces7d int64         `json:"activeWorkspaces7d"`
	Jobs               JobCounters   `json:"jobs"`
	RollupLastRunAt    *time.Time    `json:"rollupLastRunAt,omitempty"`
}

type ReservationRatio struct {
	Settled     int64   `json:"settled"`
	Released    int64   `json:"released"`
	ReleaseRate float64 `json:"releaseRate"`
}

type Health struct {
	ExpiredReservations int64            `json:"expiredReservations"`
	RollupLastRunAt     *time.Time       `json:"rollupLastRunAt"`
	RollupStale         bool             `json:"rollupStale"`
	StuckJobs           int64            `json:"stuckJobs"`
	EmailFailures24h    int64            `json:"emailFailures24h"`
	UsageMissing24h     int64            `json:"usageMissing24h"`
	ReservationRatio24h ReservationRatio `json:"reservationRatio24h"`
}

type UserSearchResult struct {
	UserID       string `json:"userId"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	PlanTier     string `json:"planTier"`
	AccountState string `json:"accountState"`
}

type CreditBalance struct {
	PeriodStart    string `json:"periodStart"`
	UsedMicros     int64  `json:"usedMicros"`
	ReservedMicros int64  `json:"reservedMicros"`
	LimitMicros    int64  `json:"limitMicros"`
}

type StorageBalance struct {
	UsedBytes     int64 `json:"usedBytes"`
	ReservedBytes int64 `json:"reservedBytes"`
	LimitBytes    int64 `json:"limitBytes"`
}

type UserWorkspace struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	FileCount      int64     `json:"fileCount"`
	LastActivityAt time.Time `json:"lastActivityAt"`
}

type UsageEvent struct {
	TraceID      string          `json:"traceId"`
	Kind         string          `json:"kind"`
	Surface      string          `json:"surface"`
	Provider     string          `json:"provider"`
	Model        string          `json:"model"`
	ModelKey     string          `json:"modelKey"`
	ModelVersion int             `json:"modelVersion"`
	InputTokens  int64           `json:"inputTokens"`
	OutputTokens int64           `json:"outputTokens"`
	Units        int64           `json:"units"`
	Unit         string          `json:"unit"`
	CreditMicros int64           `json:"creditMicros"`
	CreatedAt    time.Time       `json:"createdAt"`
	Metadata     json.RawMessage `json:"metadata"`
}

type UserDetail struct {
	UserID       string          `json:"userId"`
	Name         string          `json:"name"`
	Email        string          `json:"email"`
	PlanTier     string          `json:"planTier"`
	AccountState string          `json:"accountState"`
	Credits      CreditBalance   `json:"credits"`
	Storage      StorageBalance  `json:"storage"`
	UsageByKind  []UsagePoint    `json:"usageByKind"`
	Workspaces   []UserWorkspace `json:"workspaces"`
	RecentUsage  []UsageEvent    `json:"recentUsage"`
}

type CostRow struct {
	Key          string `json:"key"`
	Events       int64  `json:"events"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	Units        int64  `json:"units"`
	CreditMicros int64  `json:"creditMicros"`
}

type CatalogConfig struct {
	ModelKey                  string          `json:"modelKey"`
	Version                   int             `json:"version"`
	DisplayName               string          `json:"displayName"`
	ProviderSlug              string          `json:"providerSlug"`
	BaseURL                   string          `json:"baseUrl"`
	ProviderModelID           string          `json:"providerModelId"`
	AuthMode                  string          `json:"authMode"`
	ContextWindowTokens       int             `json:"contextWindowTokens"`
	Params                    json.RawMessage `json:"params"`
	Surfaces                  []string        `json:"surfaces"`
	MicrosPerInputToken       int64           `json:"microsPerInputToken"`
	MicrosPerCachedInputToken int64           `json:"microsPerCachedInputToken"`
	MicrosPerOutputToken      int64           `json:"microsPerOutputToken"`
	Enabled                   bool            `json:"enabled"`
	IsDefaultFor              []string        `json:"isDefaultFor"`
	CreatedAt                 time.Time       `json:"createdAt"`
	EmbeddingDefaultEligible  bool            `json:"embeddingDefaultEligible"`
	EmbeddingValidationError  string          `json:"embeddingValidationError"`
}

type ProviderCredentialAvailability struct {
	ProviderSlug string `json:"providerSlug"`
	Environment  string `json:"environment"`
	Configured   bool   `json:"configured"`
}

type EmbeddingWorkspaceCount struct {
	ModelKey string `json:"modelKey"`
	Version  int    `json:"version"`
	Dim      int    `json:"dim"`
	Count    int64  `json:"count"`
}

type RegistrySnapshot struct {
	Version                  int64                            `json:"revision"`
	Surfaces                 []string                         `json:"surfaces"`
	AliasesAllowed           bool                             `json:"aliasesAllowed"`
	Configs                  []CatalogConfig                  `json:"configs"`
	ProviderCredentials      []ProviderCredentialAvailability `json:"providerCredentials"`
	EmbeddingWorkspaceCounts []EmbeddingWorkspaceCount        `json:"embeddingWorkspaceCounts"`
}

type DraftConfig struct {
	ModelKey            string          `json:"modelKey"`
	DisplayName         string          `json:"displayName"`
	ProviderSlug        string          `json:"providerSlug"`
	BaseURL             string          `json:"baseUrl"`
	ProviderModelID     string          `json:"providerModelId"`
	AuthMode            string          `json:"authMode"`
	ContextWindowTokens int             `json:"contextWindowTokens"`
	Params              json.RawMessage `json:"params"`
	Surfaces            []string        `json:"surfaces"`
	DefaultFor          []string        `json:"defaultFor"`
	Rates               CreditRates     `json:"rates"`
}

type CreditRates struct {
	InputMicros       int64 `json:"inputMicros"`
	CachedInputMicros int64 `json:"cachedInputMicros"`
	OutputMicros      int64 `json:"outputMicros"`
}

type RegistryFallback struct {
	FromKey string `json:"fromKey"`
	Surface string `json:"surface"`
	ToKey   string `json:"toKey"`
}

type RegistrySaveRequest struct {
	Revision                     int64              `json:"revision"`
	Active                       []DraftConfig      `json:"active"`
	Fallbacks                    []RegistryFallback `json:"fallbacks"`
	AcknowledgeEmbeddingRetarget bool               `json:"acknowledgeEmbeddingRetarget"`
}
