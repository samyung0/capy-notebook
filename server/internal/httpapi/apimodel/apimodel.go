// Package apimodel holds the HTTP request/response contracts for the gateway,
// kept separate from the persistence models in internal/store. huma reflects
// these types to generate the OpenAPI spec that the frontend consumes.
//
// Arrays that the frontend edits as dynamic rows (react-hook-form's
// useFieldArray rejects primitive arrays) are shaped as objects here — e.g.
// workspace tags are []Tag / []TagInput on the wire, backed by the catalog +
// entity_tags tables in the database.
package apimodel

import (
	"encoding/json"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Tag is the response shape for one tag on an entity: a stable catalog id plus
// its display value. Clients echo the id back on the next write so the backend
// reuses that catalog row (preserving its metadata) instead of recreating it.
// The object wrapping (vs a bare string) also lets react-hook-form's
// useFieldArray bind each row.
type Tag struct {
	ID    string `json:"id"`
	Value string `json:"value" minLength:"1" maxLength:"50"`
}

// TagInput is one tag on an incoming write. A non-null ID reuses that existing
// catalog tag; a null/absent ID asks the backend to find-or-create a tag from
// Value.
type TagInput struct {
	ID    *string `json:"id,omitempty"`
	Value string  `json:"value" minLength:"1" maxLength:"50"`
}

// WrapTags turns the DB tag shape into the wire response shape.
func WrapTags(ts []store.Tag) []Tag {
	out := make([]Tag, len(ts))
	for i, t := range ts {
		out[i] = Tag{ID: t.ID, Value: t.Value}
	}
	return out
}

// ToTagRefs turns the incoming wire tags into store refs for a write.
func ToTagRefs(vs []TagInput) []store.TagRef {
	out := make([]store.TagRef, len(vs))
	for i, v := range vs {
		out[i] = store.TagRef{ID: v.ID, Value: v.Value}
	}
	return out
}

/* ------------------------------------------------------------------ responses

   Pass-through contracts: the stored model already has the exact wire shape, so
   we alias it. This keeps every API contract referenced from one package while
   avoiding pointless copy structs. */

type (
	User               = store.User
	Chapter            = store.Chapter
	File               = store.File
	Attempt            = store.Attempt
	FlashcardSet       = store.FlashcardSet
	Flashcard          = store.Flashcard
	Label              = store.Label
	Event              = store.Event
	Task               = store.Task
	Notification       = store.Notification
	NotificationPage   = store.NotificationPage
	NotificationPrefs  = store.NotificationPrefs
	Canvas             = store.Canvas
	SearchResult       = store.SearchResult
	WorkspaceStats     = store.WorkspaceStats
	BillingInfo        = store.BillingInfo
	IngestSlots        = store.IngestSlots
	UsageReport        = store.UsageReport
	IntegrationsStatus = store.IntegrationsStatus
	Conversation       = store.Conversation
	Message            = store.Message
	Citation           = store.Citation
	Region             = store.Region
	MaterialRef        = store.MaterialRef
)

type ModelThinking struct {
	Levels  []string `json:"levels" nullable:"false"`
	Default string   `json:"default"`
}

type ModelOption struct {
	ProviderName string         `json:"providerName"`
	ModelName    string         `json:"modelName"`
	ModelSlug    string         `json:"modelSlug"`
	IsDefault    bool           `json:"isDefault"`
	Available    bool           `json:"available"`
	UsesUserKey  bool           `json:"usesUserKey"`
	ProviderSlug string         `json:"providerSlug"`
	Thinking     *ModelThinking `json:"thinking,omitempty"`
}

type ModelsResponse struct {
	Models           []ModelOption `json:"models" nullable:"false"`
	SelectedModel    models.Ref    `json:"selectedModel"`
	DefaultModel     models.Ref    `json:"defaultModel"`
	SelectedThinking string        `json:"selectedThinking"`
}

// SetModelPrefsReq patches one or more slot preferences. Omitted fields are
// left as they are, so a picker on one slot cannot reset another.
type SetModelPrefsReq struct {
	ChatModel        *models.Ref `json:"chatModel,omitempty"`
	GenerateModel    *models.Ref `json:"generateModel,omitempty"`
	EditorModel      *models.Ref `json:"editorModel,omitempty"`
	QuizModel        *models.Ref `json:"quizModel,omitempty"`
	ChatThinking     *string     `json:"chatThinking,omitempty"`
	GenerateThinking *string     `json:"generateThinking,omitempty"`
	QuizThinking     *string     `json:"quizThinking,omitempty"`
}

type LLMCredential struct {
	ProviderSlug string `json:"providerSlug"`
	Last4        string `json:"last4"`
}

type LLMCredentialProvider struct {
	ProviderSlug string   `json:"providerSlug"`
	Eligible     bool     `json:"eligible"`
	Reason       string   `json:"reason,omitempty"`
	Unlocks      []string `json:"unlocks" nullable:"false"`
	Last4        string   `json:"last4,omitempty"`
}

type LLMCredentialsResponse struct {
	Credentials []LLMCredential         `json:"credentials" nullable:"false"`
	Providers   []LLMCredentialProvider `json:"providers" nullable:"false"`
}

type UpsertLLMCredentialReq struct {
	ProviderSlug string `json:"providerSlug"`
	APIKey       string `json:"apiKey"`
}

// QuizGradeReq is one open-answer marking request. The gateway builds the
// judge prompt server-side; the client only sends the question fields.
type QuizGradeReq struct {
	Hints       []string `json:"hints" nullable:"false"`
	ModelAnswer string   `json:"modelAnswer"`
	Prompt      string   `json:"prompt"`
	Rubrics     []string `json:"rubrics" nullable:"false"`
	UserAnswer  string   `json:"userAnswer"`
	WorkspaceID string   `json:"workspaceId,omitempty"`
}

type QuizGradeResp struct {
	Award  float64 `json:"award"`
	Reason string  `json:"reason"`
}

// SourceUploadPolicy describes the server-owned file allowlist and parser
// limits consumed by the upload dialog.
type SourceUploadKindPolicy struct {
	Kind       store.FileKind `json:"kind"`
	Extensions []string       `json:"extensions" nullable:"false"`
	Text       bool           `json:"text"`
}

type SourceUploadParseModePolicy struct {
	Mode       string   `json:"mode" enum:"fast,none"`
	Extensions []string `json:"extensions" nullable:"false"`
	MaxBytes   int64    `json:"maxBytes"`
	MaxPages   int      `json:"maxPages,omitempty"`
	// Whether this mode extracts figures, and therefore whether offering the
	// image-captioning switch alongside it makes sense.
	SupportsFigures bool `json:"supportsFigures"`
}

type SourceUploadPolicy struct {
	Kinds                        []SourceUploadKindPolicy      `json:"kinds" nullable:"false"`
	ParseModes                   []SourceUploadParseModePolicy `json:"parseModes" nullable:"false"`
	Accept                       string                        `json:"accept"`
	MaxBytes                     int64                         `json:"maxBytes"`
	AllowNoExtension             bool                          `json:"allowNoExtension"`
	AudioSecondCreditMicros      int64                         `json:"audioSecondCreditMicros"`
	AudioMaxDurationSeconds      int                           `json:"audioMaxDurationSeconds"`
	DigitalParsePageCreditMicros int64                         `json:"digitalParsePageCreditMicros"`
	OCRParsePageCreditMicros     int64                         `json:"ocrParsePageCreditMicros"`
}

type Material struct {
	ID             string                   `json:"id"`
	WorkspaceID    string                   `json:"workspaceId"`
	WorkspaceName  string                   `json:"workspaceName"`
	Kind           store.MaterialKind       `json:"kind"`
	Title          string                   `json:"title"`
	Content        materialdoc.Envelope     `json:"content"`
	ContentBytes   int                      `json:"contentBytes" doc:"UTF-8 byte length of persisted content JSON"`
	NodeCount      int                      `json:"nodeCount"`
	MaxDepth       int                      `json:"maxDepth"`
	ChapterID      *string                  `json:"chapterId"`
	Position       int64                    `json:"position"`
	ScopeChapters  []string                 `json:"scopeChapters" nullable:"false"`
	ScopeFileNames []string                 `json:"scopeFileNames" nullable:"false"`
	Privacy        store.Privacy            `json:"privacy"`
	Color          store.UserColor          `json:"color,omitempty"`
	CreatedAt      time.Time                `json:"createdAt"`
	UpdatedAt      time.Time                `json:"updatedAt"`
	Revision       int64                    `json:"revision"`
	IsOwner        bool                     `json:"isOwner"`
	Role           *store.WorkspaceRole     `json:"role,omitempty"`
	Capabilities   store.AccessCapabilities `json:"capabilities"`
}

// MaterialUpdateResult is the lightweight acknowledgement returned by
// PATCH /api/materials/{id}/metadata. The client already owns the content it sent, so
// echoing and decoding the complete document again only adds response bytes
// and main-thread JSON work for large notes.
type MaterialUpdateResult struct {
	ID           string    `json:"id"`
	Revision     int64     `json:"revision"`
	ContentBytes int       `json:"contentBytes" doc:"UTF-8 byte length of persisted content JSON"`
	NodeCount    int       `json:"nodeCount"`
	MaxDepth     int       `json:"maxDepth"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// FromMaterial fails rather than substituting an empty document. Serving a
// blank body for content that exists on disk reads as data loss and invites the
// user to type over a note they cannot see; an explicit error lets the client
// say so.
func FromMaterial(m store.Material) (Material, error) {
	content, err := materialdoc.Parse(m.Content)
	if err != nil {
		return Material{}, err
	}
	return Material{
		ID: m.ID, WorkspaceID: m.WorkspaceID, WorkspaceName: m.WorkspaceName,
		Kind: m.Kind, Title: m.Title, Content: content, ContentBytes: len(m.Content),
		NodeCount: m.NodeCount, MaxDepth: m.MaxDepth, ChapterID: m.ChapterID,
		Position:      m.Position,
		ScopeChapters: m.ScopeChapters, ScopeFileNames: m.ScopeFileNames,
		Privacy: m.Privacy, Color: m.Color, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt,
		Revision: m.Revision,
		IsOwner:  m.IsOwner, Role: m.Role, Capabilities: m.Capabilities,
	}, nil
}

type MaterialRevision struct {
	MaterialID     string                      `json:"materialId"`
	Revision       int64                       `json:"revision"`
	ParentRevision *int64                      `json:"parentRevision,omitempty"`
	EventType      store.MaterialRevisionEvent `json:"eventType"`
	Title          string                      `json:"title"`
	Content        materialdoc.Envelope        `json:"content"`
	EventMetadata  map[string]any              `json:"eventMetadata"`
	CreatedBy      *string                     `json:"createdBy,omitempty"`
	CreatedAt      time.Time                   `json:"createdAt"`
}

func FromMaterialRevision(r store.MaterialRevision) (MaterialRevision, error) {
	content, err := materialdoc.Parse(r.Content)
	if err != nil {
		return MaterialRevision{}, err
	}
	out := MaterialRevision{
		MaterialID: r.MaterialID, Revision: r.Revision, Title: r.Title,
		ParentRevision: r.ParentRevision, EventType: r.EventType, Content: content,
		EventMetadata: map[string]any{},
		CreatedBy:     r.CreatedBy, CreatedAt: r.CreatedAt,
	}
	_ = json.Unmarshal(r.EventMetadata, &out.EventMetadata)
	return out, nil
}

type (
	WorkspaceMember       = store.WorkspaceMember
	WorkspaceCollaborator = store.WorkspaceCollaborator
	Discussion            = store.Discussion
	Comment               = store.Comment
)

// Workspace is the response contract. Tags are object-wrapped for useFieldArray.
// IsOwner is request-scoped: false when a non-owner reads a link/public
// workspace (the client renders it read-only with a clone action).
type Workspace struct {
	AutoReparse    bool                     `json:"autoReparse"`
	AutoReindex    bool                     `json:"autoReindex"`
	Description    string                   `json:"description"`
	ID             string                   `json:"id"`
	Name           string                   `json:"name"`
	Color          store.UserColor          `json:"color"`
	Privacy        store.Privacy            `json:"privacy"`
	ShareRole      store.ShareRole          `json:"shareRole"`
	Tags           []Tag                    `json:"tags" nullable:"false"`
	ChapterCount   int                      `json:"chapterCount"`
	FileCount      int                      `json:"fileCount"`
	FilesLimit     int                      `json:"filesLimit"`
	CreatedAt      time.Time                `json:"createdAt"`
	LastAccessedAt time.Time                `json:"lastAccessedAt"`
	IsOwner        bool                     `json:"isOwner"`
	Role           *store.WorkspaceRole     `json:"role,omitempty"`
	Capabilities   store.AccessCapabilities `json:"capabilities"`
	// StorageOwnerState is the lifecycle state of the account charged for this
	// workspace's bytes, which is the owner and not necessarily the requester.
	// A member with a healthy account still cannot add content to an
	// over-quota owner's workspace, so the client needs the owner's state to
	// explain why writes are being refused.
	//
	// Omitted where the owner's limit cannot affect the requester — Explore
	// listings, where the only action is a clone charged to the cloner. Absent
	// therefore means "not applicable", not "healthy".
	StorageOwnerState *store.AccountState `json:"storageOwnerState,omitempty"`
	// StorageOwnerName names that account so a member sees whose limit is full
	// rather than an anonymous "the owner". Empty when the owner has no display
	// name; the client falls back to generic copy.
	StorageOwnerName string `json:"storageOwnerName"`
}

// FromWorkspace renders a workspace the requester owns. ownerState must be the
// resolved state of w.OwnerUserID (see api.workspaceOwnerStates) or empty to
// leave it unreported.
func FromWorkspace(w store.Workspace, ownerState store.AccountState) Workspace {
	role := store.RoleOwner
	out := Workspace{
		AutoReparse: w.AutoReparse, AutoReindex: w.AutoReindex,
		ID: w.ID, Name: w.Name, Description: w.Description, Color: w.Color, Privacy: w.Privacy, ShareRole: w.ShareRole,
		Tags: WrapTags(w.Tags), ChapterCount: w.ChapterCount, FileCount: w.FileCount,
		FilesLimit: w.FilesLimit,
		CreatedAt:  w.CreatedAt, LastAccessedAt: w.LastAccessedAt, IsOwner: true,
		Role: &role, Capabilities: store.CapabilitiesForRole(role, true),
		StorageOwnerName: w.OwnerName,
	}
	if ownerState != "" {
		out.StorageOwnerState = &ownerState
	}
	return out
}

func FromWorkspaceAccess(
	w store.Workspace,
	role store.WorkspaceRole,
	ownerState store.AccountState,
) Workspace {
	out := FromWorkspace(w, ownerState)
	out.IsOwner = role == store.RoleOwner
	out.Capabilities = store.CapabilitiesForRole(role, true)
	if role == "" {
		out.Role = nil
	} else {
		out.Role = &role
	}
	return out
}

// FromWorkspaces renders workspaces the requester owns. ownerStates is keyed by
// owner user id so a mixed-ownership list resolves each owner once.
func FromWorkspaces(
	ws []store.Workspace,
	ownerStates map[string]store.AccountState,
) []Workspace {
	out := make([]Workspace, len(ws))
	for i, w := range ws {
		out[i] = FromWorkspace(w, ownerStates[w.OwnerUserID])
	}
	return out
}

// PublicWorkspace is a workspace shared on Explore.
type PublicWorkspace struct {
	Workspace
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

// FromPublicWorkspaces leaves StorageOwnerState unreported: an Explore visitor
// can only clone, which is charged to them, so the author's billing state is
// both irrelevant here and none of the visitor's business.
func FromPublicWorkspaces(ws []store.PublicWorkspace) []PublicWorkspace {
	out := make([]PublicWorkspace, len(ws))
	for i, w := range ws {
		workspace := FromWorkspaceAccess(w.Workspace, "", "")
		out[i] = PublicWorkspace{Workspace: workspace, Author: w.Author, Clones: w.Clones}
	}
	return out
}

// Quiz is the response contract. Questions stay opaque (the frontend owns the
// polymorphic Question union) so we surface them as a free-form array.
type Quiz struct {
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	WorkspaceID   string           `json:"workspaceId"`
	WorkspaceName string           `json:"workspaceName"`
	Chapters      []string         `json:"chapters" nullable:"false"`
	Questions     []map[string]any `json:"questions" nullable:"false"`
	CreatedAt     time.Time        `json:"createdAt"`
	Privacy       store.Privacy    `json:"privacy"`
	TimeLimitMin  *int             `json:"timeLimitMin,omitempty"`
	// IsOwner and CanEdit are request-scoped. Explicit workspace editors can
	// edit while link/public visitors cannot.
	IsOwner bool `json:"isOwner"`
	CanEdit bool `json:"canEdit"`
}

func FromQuiz(q store.Quiz) Quiz {
	out := Quiz{
		ID: q.ID, Name: q.Name, WorkspaceID: q.WorkspaceID, WorkspaceName: q.WorkspaceName,
		Chapters: q.Chapters, Questions: decodeQuestions(q.Questions), CreatedAt: q.CreatedAt,
		Privacy: q.Privacy, TimeLimitMin: q.TimeLimitMin,
		IsOwner: q.IsOwner, CanEdit: q.CanEdit,
	}
	if out.Chapters == nil {
		out.Chapters = []string{}
	}
	return out
}

func FromQuizzes(qs []store.Quiz) []Quiz {
	out := make([]Quiz, len(qs))
	for i, q := range qs {
		out[i] = FromQuiz(q)
	}
	return out
}

// AttemptDetail is the response contract for GET /api/attempts/{id}. Answers
// and Questions stay opaque (the frontend owns the Answer/Question shapes) so
// they are surfaced as free-form JSON, mirroring how Quiz.Questions works.
type AttemptDetail struct {
	store.Attempt
	Answers   map[string]any   `json:"answers" nullable:"false"`
	Questions []map[string]any `json:"questions" nullable:"false"`
}

func FromAttemptDetail(d store.AttemptDetail) AttemptDetail {
	return AttemptDetail{
		Attempt:   d.Attempt,
		Answers:   decodeAnswers(d.Answers),
		Questions: decodeQuestions(d.Questions),
	}
}

// PublicQuiz is a quiz shared on Explore.
type PublicQuiz struct {
	Quiz
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

func FromPublicQuizzes(qs []store.PublicQuiz) []PublicQuiz {
	out := make([]PublicQuiz, len(qs))
	for i, q := range qs {
		pq := PublicQuiz{Quiz: FromQuiz(q.Quiz), Author: q.Author, Clones: q.Clones}
		pq.IsOwner = false
		pq.CanEdit = false
		out[i] = pq
	}
	return out
}

// PublicFlashcardSet is a flashcard flashcardSet shared on Explore.
type PublicFlashcardSet struct {
	store.FlashcardSet
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

func FromPublicFlashcardSets(ds []store.PublicFlashcardSet) []PublicFlashcardSet {
	out := make([]PublicFlashcardSet, len(ds))
	for i, d := range ds {
		out[i] = PublicFlashcardSet{FlashcardSet: d.FlashcardSet, Author: d.Author, Clones: d.Clones}
	}
	return out
}

// CloneWorkspaceResp reports the cloned workspace. The retrieval index is
// copied in the same transaction as the content, so there is nothing partial to
// report.
type CloneWorkspaceResp struct {
	Workspace Workspace `json:"workspace"`
}

// SubscriptionBlocker is a live subscription standing in the way of account
// deletion. Unavailable means Stripe could not be reached, which is reported as
// a blocker rather than as "no subscription" so an outage cannot let a paying
// account through.
type SubscriptionBlocker struct {
	StripeSubscriptionID string     `json:"stripeSubscriptionId,omitempty"`
	PlanTier             string     `json:"planTier,omitempty"`
	CurrentPeriodEnd     *time.Time `json:"currentPeriodEnd,omitempty"`
	Unavailable          bool       `json:"unavailable,omitempty"`
}

// DeletionPreflight is everything the danger zone needs to state consequences
// before the user commits.
type DeletionPreflight struct {
	CanDelete           bool  `json:"canDelete"`
	LifecycleGeneration int64 `json:"lifecycleGeneration"`
	// WorkspacesNeedingTransfer is retained as an empty compatibility field.
	// Owned workspaces are destroyed regardless of collaborators.
	WorkspacesNeedingTransfer []Workspace `json:"workspacesNeedingTransfer"`
	// WorkspacesToDestroy are all workspaces owned by the user.
	WorkspacesToDestroy []Workspace          `json:"workspacesToDestroy"`
	Subscription        *SubscriptionBlocker `json:"subscription,omitempty"`
	StorageUsedBytes    int64                `json:"storageUsedBytes"`
	// GraceDays is the reactivation window before the purge runs.
	GraceDays int `json:"graceDays"`
}
