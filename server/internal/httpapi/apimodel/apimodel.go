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
	"github.com/samyung0/capy-notebook/server/internal/cover"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Tag is the response shape for one tag on an entity: a stable catalog id plus
// its display value. Clients echo the id back on the next write so the backend
// reuses that catalog row (preserving its metadata) instead of recreating it.
// The object wrapping (vs a bare string) also lets react-hook-form's
// useFieldArray bind each row.
type Tag struct {
	ID    string   `json:"id"`
	Value TagValue `json:"value" minLength:"1"`
}

// TagInput is one tag on an incoming write. A non-null ID reuses that existing
// catalog tag; a null/absent ID asks the backend to find-or-create a tag from
// Value.
type TagInput struct {
	ID    *string  `json:"id,omitempty"`
	Value TagValue `json:"value" minLength:"1"`
}

// WrapTags turns the DB tag shape into the wire response shape.
func WrapTags(ts []store.Tag) []Tag {
	out := make([]Tag, len(ts))
	for i, t := range ts {
		out[i] = Tag{ID: t.ID, Value: TagValue(t.Value)}
	}
	return out
}

// ToTagRefs turns the incoming wire tags into store refs for a write.
func ToTagRefs(vs []TagInput) []store.TagRef {
	out := make([]store.TagRef, len(vs))
	for i, v := range vs {
		out[i] = store.TagRef{ID: v.ID, Value: string(v.Value)}
	}
	return out
}

// User is the signed-in user plus their resolved account lifecycle. Every page
// needs both, the second for the over-quota and deletion banners, so the
// lifecycle rides on /me rather than costing each page load a second request.
// Locked accounts never reach the body: the auth middleware answers every
// route, /me included, with the lock code.
type User struct {
	store.User
	Account store.AccountStatus `json:"account"`
}

/* ------------------------------------------------------------------ responses

   Pass-through contracts: the stored model already has the exact wire shape, so
   we alias it. This keeps every API contract referenced from one package while
   avoiding pointless copy structs. */

type (
	Chapter            = store.Chapter
	File               = store.File
	FilePage           = store.FilePage
	MaterialListItem   = store.MaterialListItem
	MaterialPage       = store.MaterialPage
	WorkspaceRecent    = store.WorkspaceRecent
	TrashItem          = store.TrashItem
	TrashPage          = store.TrashPage
	OperationReceipt   = store.AgentOperation
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
	UsageEventPage     = store.UsageEventPage
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
	ChatModel    *models.Ref `json:"chatModel,omitempty"`
	EditorModel  *models.Ref `json:"editorModel,omitempty"`
	ChatThinking *string     `json:"chatThinking,omitempty"`
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
	ProviderSlug string    `json:"providerSlug"`
	APIKey       LLMAPIKey `json:"apiKey"`
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
	// MaxPages is the parser's page cap and MaxOCRPages its cap on pages
	// without a text layer (CAPY_PARSE_MAX_PAGES, CAPY_PARSE_OCR_PAGE_CAP).
	// Only the fast mode sets them.
	MaxPages    int `json:"maxPages,omitempty"`
	MaxOCRPages int `json:"maxOcrPages,omitempty"`
}

type SourceUploadPolicy struct {
	Kinds                        []SourceUploadKindPolicy      `json:"kinds" nullable:"false"`
	ParseModes                   []SourceUploadParseModePolicy `json:"parseModes" nullable:"false"`
	Accept                       string                        `json:"accept"`
	MaxBytes                     int64                         `json:"maxBytes"`
	AllowNoExtension             bool                          `json:"allowNoExtension"`
	DigitalParsePageCreditMicros int64                         `json:"digitalParsePageCreditMicros"`
	VLMIngestPageCreditMicros    int64                         `json:"vlmIngestPageCreditMicros"`
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
	// Attribution of a material written from the knowledge library; absent
	// otherwise. The frontend renders it outside the editable document.
	Provenance *store.Provenance `json:"provenance,omitempty"`
	// ParentMaterialID names the note a quiz or flashcard set is embedded in.
	ParentMaterialID string `json:"parentMaterialId,omitempty"`
	// SharePath is a standalone material's signed share link, for its Share
	// dialog; absent in a workspace or embedded in a note.
	SharePath string `json:"sharePath,omitempty"`
	// EmbedCredits is, for a note, the provenance of each of its own live
	// embedded quizzes and flashcard sets that has credits, by id: the app
	// computes the note's footer from it and the document's current embeds.
	EmbedCredits map[string]*store.Provenance `json:"embedCredits,omitempty"`
	// ImageMaxBytes caps one uploaded image by the reader's plan: whoever adds
	// an image pays for it (M16). The browser shrinks larger images.
	ImageMaxBytes int64 `json:"imageMaxBytes"`
	// AudioMaxBytes caps one uploaded audio file the same way; the browser
	// refuses a larger one before it sends anything (Epo 2026-10-22).
	AudioMaxBytes int64 `json:"audioMaxBytes"`
	// RemovedAssetIDs are the images and audio it or its embedded quizzes and
	// sets show that no longer exist: deleted by their uploader, or with the
	// uploader's account (M16). The app shows each as removed instead of
	// loading it.
	RemovedAssetIDs []string `json:"removedAssetIds,omitempty"`
	// StorageFull: the material is view-only because its payer (its creator)
	// is at its storage limit; "self" when that is the viewer. Editors only.
	StorageFull store.StorageFullBy `json:"storageFull,omitempty"`
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
		Provenance: m.Provenance, ParentMaterialID: m.ParentMaterialID,
	}, nil
}

type (
	WorkspaceMember        = store.WorkspaceMember
	PendingWorkspaceInvite = store.PendingWorkspaceInvite
	WorkspaceCollaborator  = store.WorkspaceCollaborator
	Discussion             = store.Discussion
	Comment                = store.Comment
)

// Workspace is the response contract. Tags are object-wrapped for useFieldArray.
// IsOwner is request-scoped: false when a non-owner reads a link/public
// workspace (the client renders it read-only with a clone action).
type Workspace struct {
	AutoProcess    bool                     `json:"autoProcess"`
	Description    string                   `json:"description"`
	ID             string                   `json:"id"`
	Name           string                   `json:"name"`
	IconID         string                   `json:"iconId"`
	Cover          *cover.Cover             `json:"cover,omitempty" doc:"The card's cover art; absent means none"`
	Privacy        store.Privacy            `json:"privacy"`
	ShareRole      store.ShareRole          `json:"shareRole"`
	SharePath      string                   `json:"sharePath"`
	Tags           []Tag                    `json:"tags" nullable:"false"`
	ChapterCount   int                      `json:"chapterCount"`
	FileCount      int                      `json:"fileCount"`
	FilesLimit     int                      `json:"filesLimit"`
	CreatedAt      time.Time                `json:"createdAt"`
	LastAccessedAt time.Time                `json:"lastAccessedAt"`
	IsOwner        bool                     `json:"isOwner"`
	Role           *store.WorkspaceRole     `json:"role,omitempty"`
	Capabilities   store.AccessCapabilities `json:"capabilities"`
	// CanClone: members of any role and effective editors may copy the
	// workspace; a link/public viewer may not.
	CanClone bool `json:"canClone"`
}

// FromWorkspace renders a workspace the requester owns. It reports no owner
// storage state: content is charged to whoever uploaded or created it (Sam
// 2026-10-18), so a full or frozen account narrows only the items it pays for
// (their own capabilities), never the workspace.
func FromWorkspace(w store.Workspace) Workspace {
	role := store.RoleOwner
	out := Workspace{
		AutoProcess: w.AutoProcess,
		ID:          w.ID, Name: w.Name, Description: w.Description, IconID: w.IconID, Cover: w.Cover, Privacy: w.Privacy, ShareRole: w.ShareRole,
		SharePath: w.SharePath,
		Tags:      WrapTags(w.Tags), ChapterCount: w.ChapterCount, FileCount: w.FileCount,
		FilesLimit: w.FilesLimit,
		CreatedAt:  w.CreatedAt, LastAccessedAt: w.LastAccessedAt, IsOwner: true,
		Role: &role, Capabilities: store.CapabilitiesForRole(role, true), CanClone: true,
	}
	return out
}

// FromWorkspaceAccess renders a workspace for a requester. Role is their
// persisted membership (nil for a link/public visitor) and Capabilities follow
// their effective role, so a share-role editor sees content controls while
// settings stay keyed on Role. A frozen requester (actorReadOnly) edits
// nowhere and cannot clone.
func FromWorkspaceAccess(
	w store.Workspace,
	member, effective store.WorkspaceRole,
	actorReadOnly bool,
) Workspace {
	out := FromWorkspace(w)
	out.IsOwner = member == store.RoleOwner
	out.Capabilities = store.CapabilitiesForRole(effective, true)
	out.Capabilities.CanEdit = out.Capabilities.CanEdit && !actorReadOnly
	out.Capabilities.CanEditContent = out.Capabilities.CanEdit
	out.CanClone = store.CanCloneFrom(member, effective) && !actorReadOnly
	if member == "" {
		out.Role = nil
	} else {
		out.Role = &member
	}
	return out
}

// FromWorkspaces renders workspaces the requester owns.
func FromWorkspaces(ws []store.Workspace) []Workspace {
	out := make([]Workspace, len(ws))
	for i, w := range ws {
		out[i] = FromWorkspace(w)
	}
	return out
}

// PublicWorkspace is a workspace shared on Explore.
type PublicWorkspace struct {
	Workspace
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

// FromPublicWorkspaces: capabilities and canClone follow the caller's real
// grant, membership or share role, and the caller's own frozen account
// (actorReadOnly).
func FromPublicWorkspaces(ws []store.PublicWorkspace, actorReadOnly bool) []PublicWorkspace {
	out := make([]PublicWorkspace, len(ws))
	for i, w := range ws {
		effective := store.EffectiveRole(w.MemberRole, w.Privacy, w.ShareRole)
		workspace := FromWorkspaceAccess(w.Workspace, w.MemberRole, effective, actorReadOnly)
		out[i] = PublicWorkspace{Workspace: workspace, Author: w.Author, Clones: w.Clones}
	}
	return out
}

// Quiz is the response contract. Questions stay opaque (the frontend owns the
// polymorphic Question union) so we surface them as a free-form array.
type Quiz struct {
	Revision      int64            `json:"revision"`
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	WorkspaceID   string           `json:"workspaceId"`
	WorkspaceName string           `json:"workspaceName"`
	Chapters      []string         `json:"chapters" nullable:"false"`
	Questions     []map[string]any `json:"questions" nullable:"false"`
	CreatedAt     time.Time        `json:"createdAt"`
	Privacy       store.Privacy    `json:"privacy"`
	SharePath     string           `json:"sharePath,omitempty"`
	// Author is the owner a shared page shows; only the single-quiz read fills it.
	Author *store.MaterialAuthor `json:"author,omitempty"`
	// ParentMaterialID is the note a quiz is embedded in (a quick check).
	ParentMaterialID string `json:"parentMaterialId,omitempty"`
	// Provenance credits the library books the quiz was written from.
	Provenance *store.Provenance `json:"provenance,omitempty"`
	// IsOwner and CanEdit are request-scoped. Explicit workspace editors can
	// edit while link/public visitors cannot. CanEditContent is CanEdit unless
	// the storage owner is at its limit.
	IsOwner        bool `json:"isOwner"`
	CanEdit        bool `json:"canEdit"`
	CanEditContent bool `json:"canEditContent"`
}

func FromQuiz(q store.Quiz) Quiz {
	out := Quiz{
		Revision: q.Revision,
		ID:       q.ID, Name: q.Name, WorkspaceID: q.WorkspaceID, WorkspaceName: q.WorkspaceName,
		Chapters: q.Chapters, Questions: decodeQuestions(q.Questions), CreatedAt: q.CreatedAt,
		Privacy: q.Privacy, SharePath: q.SharePath, ParentMaterialID: q.ParentMaterialID, Provenance: q.Provenance,
		IsOwner: q.IsOwner, CanEdit: q.CanEdit, CanEditContent: q.CanEditContent,
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
	// Cards is a flashcard attempt's cards; empty for a quiz.
	Cards []store.AttemptCard `json:"cards" nullable:"false"`
	// Previous is the set's attempt before this one; absent for a quiz or a
	// first attempt.
	Previous *store.PreviousAttempt `json:"previous,omitempty"`
}

func FromAttemptDetail(d store.AttemptDetail) AttemptDetail {
	out := AttemptDetail{Attempt: d.Attempt, Answers: decodeAnswers(d.Answers), Questions: []map[string]any{}, Cards: []store.AttemptCard{}}
	if d.Kind == "flashcards" {
		out.Cards = decodeCards(d.Questions)
		out.Previous = d.Previous
		return out
	}
	out.Questions = decodeQuestions(d.Questions)
	return out
}

// GradedQuiz is a graded signed-out attempt: every question with its key and,
// on each part, the awarded marks (open parts also itemAwards, Jev's marks per
// marking item; matching and gaps parts also itemResults, right or wrong per
// pair or gap). Correct is the awarded marks over Total, the quiz's marks.
type GradedQuiz struct {
	Correct   float64          `json:"correct"`
	Total     float64          `json:"total"`
	Questions []map[string]any `json:"questions" nullable:"false"`
}

// GradedQuestion is one checked question, keyed and awarded like GradedQuiz.
type GradedQuestion struct {
	Correct  float64        `json:"correct"`
	Total    float64        `json:"total"`
	Question map[string]any `json:"question"`
}

// PublicQuiz is a quiz shared on Explore.
type PublicQuiz struct {
	Quiz
	Author string `json:"author"`
	Clones int    `json:"clones"`
	// CanClone: the caller may copy it, a member of its workspace or an
	// effective editor (any reader of a standalone one).
	CanClone bool `json:"canClone"`
}

// FromPublicQuizzes lists quizzes for browsing, so questions are answer-free.
func FromPublicQuizzes(qs []store.PublicQuiz) []PublicQuiz {
	out := make([]PublicQuiz, len(qs))
	for i, q := range qs {
		pq := PublicQuiz{Quiz: FromQuiz(q.Quiz), Author: q.Author, Clones: q.Clones, CanClone: q.CanClone}
		pq.Questions = questions.LearnerViews(pq.Questions)
		pq.IsOwner = false
		pq.CanEdit, pq.CanEditContent = false, false
		out[i] = pq
	}
	return out
}

// PublicFlashcardSet is a flashcard flashcardSet shared on Explore.
type PublicFlashcardSet struct {
	store.FlashcardSet
	Author   string `json:"author"`
	Clones   int    `json:"clones"`
	CanClone bool   `json:"canClone"` // as PublicQuiz.CanClone
}

func FromPublicFlashcardSets(ds []store.PublicFlashcardSet) []PublicFlashcardSet {
	out := make([]PublicFlashcardSet, len(ds))
	for i, d := range ds {
		out[i] = PublicFlashcardSet{FlashcardSet: d.FlashcardSet, Author: d.Author, Clones: d.Clones, CanClone: d.CanClone}
	}
	return out
}

// CloneWorkspaceResp reports the cloned workspace. The retrieval index is
// copied in the same transaction as the content, so there is nothing partial to
// report.
type CloneWorkspaceResp struct {
	Workspace Workspace `json:"workspace"`
	// Files left out of the copy (Epo 2026-10-20): materials whose stored
	// content the current rules refuse and files past the cloner's per-file
	// cap. The app shows a toast when above zero.
	SkippedMaterials int `json:"skippedMaterials" minimum:"0"`
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

// FileLinks carries short-lived presigned reads for a file's bytes. Viewers
// fetch it through the authenticated API because B2 URLs cannot carry the
// bearer token and the gateway must not proxy file bytes.
type FileLinks struct {
	URL string `json:"url"`
	// PreviewURL is the paginated PDF whose coordinates citation regions use.
	PreviewURL *string   `json:"previewUrl,omitempty"`
	ExpiresAt  time.Time `json:"expiresAt"`
	// StorageFull: the file's payer (its uploader) is at its storage limit,
	// so its content (annotations included) is view-only; "self" when that
	// is the viewer.
	StorageFull store.StorageFullBy `json:"storageFull,omitempty"`
}

// Invoice is one Stripe invoice on the Subscription tab. Total is in the
// currency's smallest unit, as Stripe reports it.
type Invoice struct {
	ID        string     `json:"id"`
	CreatedAt time.Time  `json:"createdAt"`
	DueAt     *time.Time `json:"dueAt,omitempty"`
	Total     int64      `json:"total"`
	Currency  string     `json:"currency"`
	Status    string     `json:"status" enum:"open,paid,uncollectible,void"`
	URL       string     `json:"url,omitempty"`
	// Kind is the invoice's Type column: the Pro plan, a top-up or an auto-reload.
	Kind string `json:"kind" enum:"plan,topup,reload"`
	// NextAttemptAt is when Stripe retries an open invoice; absent once it stopped.
	NextAttemptAt *time.Time `json:"nextAttemptAt,omitempty"`
}

type InvoiceList struct {
	Items []Invoice `json:"items" nullable:"false"`
}
