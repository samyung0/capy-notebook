package ops

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/evonotes/server/internal/models"
)

const (
	RoleViewer = "viewer"
	RoleAdmin  = "admin"

	PermReadAll               = "read_all"
	PermExecuteReconciliation = "execute_reconciliation_job"
	PermWriteRegistry         = "write_registry"
)

var ErrForbidden = errors.New("operator access denied")

type Principal struct {
	UserID      string   `json:"userId"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
}

func (p Principal) Has(permission string) bool {
	for _, item := range p.Permissions {
		if item == permission {
			return true
		}
	}
	return false
}

type preferenceColumns struct {
	Provider string
	Model    string
}

var userPreferenceColumns = map[string]preferenceColumns{
	models.SurfaceChat:     {"chat_model_provider_slug", "chat_model_slug"},
	models.SurfaceGenerate: {"generate_model_provider_slug", "generate_model_slug"},
	models.SurfaceEditor:   {"editor_model_provider_slug", "editor_model_slug"},
	models.SurfaceQuiz:     {"quiz_model_provider_slug", "quiz_model_slug"},
}

type Session struct {
	UserID      string   `json:"userId"`
	Email       string   `json:"email,omitempty"`
	Name        string   `json:"name,omitempty"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
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

type ParserHostSample struct {
	SampledAt         time.Time `json:"sampledAt"`
	HostID            string    `json:"hostId"`
	ActiveJobs        int64     `json:"activeJobs"`
	QueuedJobs        int64     `json:"queuedJobs"`
	CPUPercent        float64   `json:"cpuPercent"`
	Load1             float64   `json:"load1"`
	MemoryUsedBytes   int64     `json:"memoryUsedBytes"`
	MemoryTotalBytes  int64     `json:"memoryTotalBytes"`
	SwapUsedBytes     int64     `json:"swapUsedBytes"`
	ParserMemoryBytes int64     `json:"parserMemoryBytes"`
	ParserPSSBytes    int64     `json:"parserPssBytes"`
	NetworkRXBytes    int64     `json:"networkRxBytes"`
	NetworkTXBytes    int64     `json:"networkTxBytes"`
}

type ParserAttemptSummary struct {
	Attempts                  int64   `json:"attempts"`
	Pages                     int64   `json:"pages"`
	OCRPages                  int64   `json:"ocrPages"`
	CPUMilliseconds           int64   `json:"cpuMilliseconds"`
	ElapsedMilliseconds       int64   `json:"elapsedMilliseconds"`
	QueueMilliseconds         int64   `json:"queueMilliseconds"`
	DownloadMilliseconds      int64   `json:"downloadMilliseconds"`
	UploadMilliseconds        int64   `json:"uploadMilliseconds"`
	PeakWorkerRSSBytes        int64   `json:"peakWorkerRssBytes"`
	PeakWorkerPSSBytes        int64   `json:"peakWorkerPssBytes"`
	IOReadBytes               int64   `json:"ioReadBytes"`
	IOWriteBytes              int64   `json:"ioWriteBytes"`
	AverageAttributedCPUCores float64 `json:"averageAttributedCpuCores"`
}

type ParserMetrics struct {
	Hours    int                  `json:"hours"`
	Attempts ParserAttemptSummary `json:"attempts"`
	Samples  []ParserHostSample   `json:"samples"`
	DataAsOf time.Time            `json:"dataAsOf"`
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
	DataAsOf           time.Time     `json:"dataAsOf"`
}

type ReservationRatio struct {
	Settled     int64   `json:"settled"`
	Released    int64   `json:"released"`
	ReleaseRate float64 `json:"releaseRate"`
}

type Health struct {
	ExpiredReservations         int64                    `json:"expiredReservations"`
	StuckJobs                   int64                    `json:"stuckJobs"`
	EmailFailures24h            int64                    `json:"emailFailures24h"`
	TurnsMissingApplied24h      int64                    `json:"turnsMissingApplied24h"`
	AppliedWithoutUsage24h      int64                    `json:"appliedWithoutUsage24h"`
	ProviderUsageWithoutCall24h int64                    `json:"providerUsageWithoutCall24h"`
	StaleOpenCalls              int64                    `json:"staleOpenCalls"`
	ReservationRatio24h         ReservationRatio         `json:"reservationRatio24h"`
	ActiveTurns                 []TurnLifecycle          `json:"activeTurns"`
	StaleTurns                  []TurnLifecycle          `json:"staleTurns"`
	FailedTurns                 []TurnLifecycle          `json:"failedTurns"`
	AbandonedCalls              []ProviderCallDiagnostic `json:"abandonedCalls"`
	DataAsOf                    time.Time                `json:"dataAsOf"`
}

type TurnLifecycle struct {
	MessageID            string     `json:"messageId"`
	UserID               string     `json:"userId"`
	Status               string     `json:"status"`
	TraceID              string     `json:"traceId"`
	StartedAt            time.Time  `json:"startedAt"`
	ReservationID        string     `json:"reservationId"`
	ReservationStatus    string     `json:"reservationStatus"`
	Surface              string     `json:"surface"`
	ReservationExpiresAt *time.Time `json:"reservationExpiresAt"`
	AppliedCalls         int64      `json:"appliedCalls"`
	OpenCalls            int64      `json:"openCalls"`
	AbandonedCalls       int64      `json:"abandonedCalls"`
	LatestCallPurpose    string     `json:"latestCallPurpose"`
	LatestCallStatus     string     `json:"latestCallStatus"`
	LatestCallOpenedAt   *time.Time `json:"latestCallOpenedAt"`
}

type ProviderCallDiagnostic struct {
	CallID                    string    `json:"callId"`
	ReservationID             string    `json:"reservationId"`
	UserID                    string    `json:"userId"`
	TraceID                   string    `json:"traceId"`
	TurnStatus                string    `json:"turnStatus"`
	ReservationStatus         string    `json:"reservationStatus"`
	Surface                   string    `json:"surface"`
	Purpose                   string    `json:"purpose"`
	Thinking                  string    `json:"thinking"`
	ContextSystemTokens       int64     `json:"contextSystemTokens"`
	ContextToolTokens         int64     `json:"contextToolTokens"`
	ContextConversationTokens int64     `json:"contextConversationTokens"`
	ContextTotalTokens        int64     `json:"contextTotalTokens"`
	ContextWindowTokens       int64     `json:"contextWindowTokens"`
	ContextCountingMethod     string    `json:"contextCountingMethod"`
	ContextCountingVersion    int       `json:"contextCountingVersion"`
	OpenedAt                  time.Time `json:"openedAt"`
}

type ReconciliationRun struct {
	ID              int64      `json:"id"`
	JobType         string     `json:"jobType"`
	Trigger         string     `json:"trigger"`
	Status          string     `json:"status"`
	RequestedByID   string     `json:"requestedById"`
	RequestedByName string     `json:"requestedByName"`
	RequestedAt     time.Time  `json:"requestedAt"`
	StartedAt       *time.Time `json:"startedAt"`
	FinishedAt      *time.Time `json:"finishedAt"`
	ScannedCount    int64      `json:"scannedCount"`
	RepairedCount   int64      `json:"repairedCount"`
	ErrorCount      int64      `json:"errorCount"`
	Error           string     `json:"error"`
}

type ReconciliationReport struct {
	ID          int64           `json:"id"`
	RunID       int64           `json:"runId"`
	EventType   string          `json:"eventType"`
	SubjectType string          `json:"subjectType"`
	SubjectID   string          `json:"subjectId"`
	ActorUserID string          `json:"actorUserId"`
	Metadata    json.RawMessage `json:"metadata"`
	CreatedAt   time.Time       `json:"createdAt"`
}

type ReconciliationStatus struct {
	Runs     []ReconciliationRun    `json:"runs"`
	Reports  []ReconciliationReport `json:"reports"`
	DataAsOf time.Time              `json:"dataAsOf"`
}

type ReconciliationRequest struct {
	RunID         int64     `json:"runId"`
	AlreadyQueued bool      `json:"alreadyQueued"`
	RequestedAt   time.Time `json:"requestedAt"`
}

type ResourceCreditRate struct {
	ResourceKey         string    `json:"resourceKey"`
	Version             int       `json:"version"`
	Unit                string    `json:"unit"`
	CreditMicrosPerUnit int64     `json:"creditMicrosPerUnit"`
	Active              bool      `json:"active"`
	CreatedAt           time.Time `json:"createdAt"`
}

type SaveResourceCreditRateRequest struct {
	CreditMicrosPerUnit int64 `json:"creditMicrosPerUnit"`
}

type OperatorAuditEvent struct {
	ID          int64           `json:"id"`
	OccurredAt  time.Time       `json:"occurredAt"`
	ActorUserID string          `json:"actorUserId"`
	ActorRole   string          `json:"actorRole"`
	Action      string          `json:"action"`
	TargetType  string          `json:"targetType"`
	TargetID    string          `json:"targetId"`
	Outcome     string          `json:"outcome"`
	TraceID     string          `json:"traceId"`
	Metadata    json.RawMessage `json:"metadata"`
}

type OperatorAuditPage struct {
	Events       []OperatorAuditEvent `json:"events"`
	NextBeforeID *int64               `json:"nextBeforeId,omitempty"`
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
	TraceID                   string    `json:"traceId"`
	Kind                      string    `json:"kind"`
	Surface                   string    `json:"surface"`
	Provider                  string    `json:"provider"`
	Model                     string    `json:"model"`
	Thinking                  string    `json:"thinking"`
	CatalogProviderSlug       string    `json:"catalogProviderSlug"`
	CatalogModelSlug          string    `json:"catalogModelSlug"`
	ModelVersion              int       `json:"modelVersion"`
	InputTokens               int64     `json:"inputTokens"`
	CachedReadTokens          int64     `json:"cachedReadTokens"`
	CacheWriteTokens          int64     `json:"cacheWriteTokens"`
	OutputTokens              int64     `json:"outputTokens"`
	ReasoningTokens           int64     `json:"reasoningTokens"`
	ParsePages                int64     `json:"parsePages"`
	ParseOCRPages             int64     `json:"parseOcrPages"`
	ParseCPUMilliseconds      int64     `json:"parseCpuMilliseconds"`
	ParseElapsedMilliseconds  int64     `json:"parseElapsedMilliseconds"`
	CreditMicros              int64     `json:"creditMicros"`
	CreatedAt                 time.Time `json:"createdAt"`
	ProviderCallID            string    `json:"providerCallId"`
	ProviderCallStatus        string    `json:"providerCallStatus"`
	Purpose                   string    `json:"purpose"`
	PaidBy                    string    `json:"paidBy"`
	CacheAnomaly              string    `json:"cacheAnomaly"`
	ContextSystemTokens       int64     `json:"contextSystemTokens"`
	ContextToolTokens         int64     `json:"contextToolTokens"`
	ContextConversationTokens int64     `json:"contextConversationTokens"`
	ContextTotalTokens        int64     `json:"contextTotalTokens"`
	ContextWindowTokens       int64     `json:"contextWindowTokens"`
	ContextCountingMethod     string    `json:"contextCountingMethod"`
	ContextCountingVersion    int       `json:"contextCountingVersion"`
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
	DataAsOf     time.Time       `json:"dataAsOf"`
}

type CostRow struct {
	Key                       string `json:"key"`
	Observed                  string `json:"observed"`
	Events                    int64  `json:"events"`
	InputTokens               int64  `json:"inputTokens"`
	CachedReadTokens          int64  `json:"cachedReadTokens"`
	CacheWriteTokens          int64  `json:"cacheWriteTokens"`
	OutputTokens              int64  `json:"outputTokens"`
	ReasoningTokens           int64  `json:"reasoningTokens"`
	ParsePages                int64  `json:"parsePages"`
	ParseOCRPages             int64  `json:"parseOcrPages"`
	ParseCPUMilliseconds      int64  `json:"parseCpuMilliseconds"`
	ParseElapsedMilliseconds  int64  `json:"parseElapsedMilliseconds"`
	CreditMicros              int64  `json:"creditMicros"`
	ContextSystemTokens       int64  `json:"contextSystemTokens"`
	ContextToolTokens         int64  `json:"contextToolTokens"`
	ContextConversationTokens int64  `json:"contextConversationTokens"`
	ContextTotalTokens        int64  `json:"contextTotalTokens"`
}

type CostReport struct {
	From           string         `json:"from"`
	To             string         `json:"to"`
	Bucket         string         `json:"bucket"`
	DataAsOf       time.Time      `json:"dataAsOf"`
	Rows           []CostRow      `json:"rows"`
	ContextSummary ContextSummary `json:"contextSummary"`
}

type ContextSummary struct {
	Calls                 int64   `json:"calls"`
	SystemTokens          int64   `json:"systemTokens"`
	ToolTokens            int64   `json:"toolTokens"`
	ConversationTokens    int64   `json:"conversationTokens"`
	TotalTokens           int64   `json:"totalTokens"`
	WindowTokens          int64   `json:"windowTokens"`
	P50WindowUtilization  float64 `json:"p50WindowUtilization"`
	P95WindowUtilization  float64 `json:"p95WindowUtilization"`
	MaxWindowUtilization  float64 `json:"maxWindowUtilization"`
	CallsAtLeast80Percent int64   `json:"callsAtLeast80Percent"`
	CallsAtLeast90Percent int64   `json:"callsAtLeast90Percent"`
	CallsAtLeast95Percent int64   `json:"callsAtLeast95Percent"`
}

type CatalogConfig struct {
	Version                   int             `json:"version"`
	ProviderName              string          `json:"providerName"`
	ModelName                 string          `json:"modelName"`
	ProviderSlug              string          `json:"providerSlug"`
	ModelSlug                 string          `json:"modelSlug"`
	PlatformEnabled           bool            `json:"platformEnabled"`
	ByokEnabled               bool            `json:"byokEnabled"`
	ContextWindowTokens       int             `json:"contextWindowTokens"`
	ThinkingLevels            []string        `json:"thinkingLevels"`
	DefaultThinking           string          `json:"defaultThinking"`
	Params                    json.RawMessage `json:"params"`
	Surfaces                  []string        `json:"surfaces"`
	MicrosPerInputToken       int64           `json:"microsPerInputToken"`
	MicrosPerCachedInputToken int64           `json:"microsPerCachedInputToken"`
	MicrosPerOutputToken      int64           `json:"microsPerOutputToken"`
	Enabled                   bool            `json:"enabled"`
	IsDefaultFor              []string        `json:"isDefaultFor"`
	CreatedAt                 time.Time       `json:"createdAt"`
	UpdatedAt                 time.Time       `json:"updatedAt"`
	CreatedBy                 string          `json:"createdBy"`
	UpdatedBy                 string          `json:"updatedBy"`
	EmbeddingDefaultEligible  bool            `json:"embeddingDefaultEligible"`
	EmbeddingValidationError  string          `json:"embeddingValidationError"`
}

func (c CatalogConfig) Ref() models.Ref {
	return models.Ref{ProviderSlug: c.ProviderSlug, ModelSlug: c.ModelSlug}
}

type ProviderCredentialAvailability struct {
	ProviderSlug string `json:"providerSlug"`
	Environment  string `json:"environment"`
	Configured   bool   `json:"configured"`
}

type EmbeddingWorkspaceCount struct {
	ProviderSlug string `json:"providerSlug"`
	ModelSlug    string `json:"modelSlug"`
	Version      int    `json:"version"`
	Dim          int    `json:"dim"`
	Count        int64  `json:"count"`
}

type RegistrySnapshot struct {
	Version                  int64                            `json:"revision"`
	Surfaces                 []models.Surface                 `json:"surfaces"`
	AliasesAllowed           bool                             `json:"aliasesAllowed"`
	Configs                  []CatalogConfig                  `json:"configs"`
	ProviderCredentials      []ProviderCredentialAvailability `json:"providerCredentials"`
	EmbeddingWorkspaceCounts []EmbeddingWorkspaceCount        `json:"embeddingWorkspaceCounts"`
}

type DraftConfig struct {
	ProviderName        string          `json:"providerName"`
	ModelName           string          `json:"modelName"`
	ProviderSlug        string          `json:"providerSlug"`
	ModelSlug           string          `json:"modelSlug"`
	PlatformEnabled     bool            `json:"platformEnabled"`
	ByokEnabled         bool            `json:"byokEnabled"`
	ContextWindowTokens int             `json:"contextWindowTokens"`
	ThinkingLevels      []string        `json:"thinkingLevels"`
	DefaultThinking     string          `json:"defaultThinking"`
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

type RegistrySaveRequest struct {
	Revision                     int64         `json:"revision"`
	Active                       []DraftConfig `json:"active"`
	AcknowledgeEmbeddingRetarget bool          `json:"acknowledgeEmbeddingRetarget"`
}

type EliteLLMProviderPage struct {
	Providers []EliteLLMProvider `json:"providers"`
}

type EliteLLMProvider struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Modes       []string `json:"modes"`
	BYOK        bool     `json:"byok"`
	PlatformEnv string   `json:"platformEnv"`
	Thinking    []string `json:"thinking"`
}
