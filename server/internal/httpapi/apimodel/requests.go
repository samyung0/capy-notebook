package apimodel

import (
	"encoding/json"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

/* ------------------------------------------------------------------ requests */

// UpdateMeReq is the body for PATCH /api/me. Name is the display name the user
// typed; the handler trims it and refuses an empty result.
type UpdateMeReq struct {
	Name         UserName `json:"name" minLength:"1" doc:"Display name"`
	AvatarIconID *IconID  `json:"avatarIconId,omitempty" doc:"Curated icon ID; empty restores the current Clerk photo; omitted preserves the selection"`
}

// CreateWorkspaceReq is the body for POST /api/workspaces. New workspaces are
// always private; visibility is configured later through the sharing endpoint.
type CreateWorkspaceReq struct {
	Description *WorkspaceDescription `json:"description,omitempty" doc:"Optional workspace description"`
	IconID      *IconID               `json:"iconId,omitempty" minLength:"1"`
	Name        WorkspaceName         `json:"name" minLength:"1" doc:"Workspace name"`
	Tags        []TagInput            `json:"tags,omitempty" maxItems:"5" doc:"Tags; at most 5; reuse existing by id or create new by value"`
}

// UpdateWorkspaceReq updates general workspace settings only.
type UpdateWorkspaceReq struct {
	AutoProcess *bool                 `json:"autoProcess,omitempty"`
	Description *WorkspaceDescription `json:"description,omitempty" doc:"Optional workspace description; empty clears it"`
	Name        *WorkspaceName        `json:"name,omitempty" minLength:"1"`
	IconID      *IconID               `json:"iconId,omitempty" minLength:"1"`
	Tags        *[]TagInput           `json:"tags,omitempty" maxItems:"5" doc:"Tags; at most 5"`
}

// UpdateWorkspaceSharingReq updates visibility and nonmember permissions.
type UpdateWorkspaceSharingReq struct {
	Privacy   *store.Privacy   `json:"privacy,omitempty"`
	ShareRole *store.ShareRole `json:"shareRole,omitempty"`
}

type AddChapterReq struct {
	Name ChapterName `json:"name" minLength:"1" doc:"Chapter name"`
}

type UpdateChapterReq struct {
	Name  *ChapterName `json:"name,omitempty" minLength:"1"`
	Order *int         `json:"order,omitempty"`
}

type ReorderChaptersReq struct {
	IDs []string `json:"ids" minItems:"1" doc:"Chapter ids in the desired order"`
}

type ContentOrderItem struct {
	ID   string `json:"id" minLength:"1"`
	Type string `json:"type" enum:"file,material"`
}

type ReorderContentReq struct {
	ChapterID *string            `json:"chapterId" doc:"Destination chapter; null means the unfiled bucket"`
	Items     []ContentOrderItem `json:"items" minItems:"1" doc:"Destination content in the desired mixed order"`
}

// UpdateFileReq is the (partial) body for PATCH /api/files/{id} — rename and/or
// move to a chapter.
type UpdateFileReq struct {
	Name      *FileName `json:"name,omitempty" minLength:"1"`
	ChapterID *string   `json:"chapterId,omitempty"`
}

// TrashActionReq identifies one restore of one trash episode. The request id
// is the browser's idempotency key for this click; a repeat returns the same
// receipt instead of acting twice.
type TrashActionReq struct {
	EpisodeID string `json:"episodeId" minLength:"1" doc:"Trash episode returned by the trash listing"`
	RequestID string `json:"requestId" minLength:"1" maxLength:"64" doc:"Client-generated idempotency key for this action"`
}

// UndoEditReq carries the browser's idempotency key for one Undo click.
type UndoEditReq struct {
	RequestID string `json:"requestId" minLength:"1" maxLength:"64" doc:"Client-generated idempotency key for this action"`
}

// CreateMaterialReq is the body for POST /api/workspaces/{id}/materials.
type CreateMaterialReq struct {
	Kind           store.MaterialKind    `json:"kind" doc:"Material kind"`
	Title          MaterialTitle         `json:"title,omitempty"`
	Content        *materialdoc.Envelope `json:"content,omitempty" doc:"Versioned Plate document"`
	ScopeChapters  []string              `json:"scopeChapters,omitempty"`
	ScopeFileNames []string              `json:"scopeFileNames,omitempty"`
}

// CreateEmbeddedMaterialReq is the body for POST /api/materials/{id}/embedded:
// a quiz or flashcard set authored inside the note {id}. The note title gives
// the default title; the caller inserts the returned id as a reference block.
type CreateEmbeddedMaterialReq struct {
	Kind      store.MaterialKind `json:"kind" enum:"quiz,flashcards"`
	Questions []map[string]any   `json:"questions,omitempty"`
	Cards     []CardContent      `json:"cards,omitempty"`
}

// AdoptEmbeddedMaterialsReq is the body for POST
// /api/materials/{id}/embedded/adopt: one entry per quiz or flashcard block
// just pasted into the note {id}.
type AdoptEmbeddedMaterialsReq struct {
	Materials []AdoptEmbeddedMaterial `json:"materials" minItems:"1" maxItems:"20" nullable:"false"`
}

// AdoptEmbeddedMaterial is one pasted block's reference. Copy asks for a copy
// even of the note's own row, for a block whose quiz another block keeps.
type AdoptEmbeddedMaterial struct {
	MaterialID string `json:"materialId" minLength:"1"`
	Copy       bool   `json:"copy,omitempty"`
}

// AdoptedEmbeddedMaterial is the note's own material for one pasted source;
// MaterialID is omitted when the block cannot stay.
type AdoptedEmbeddedMaterial struct {
	SourceID   string `json:"sourceId"`
	MaterialID string `json:"materialId,omitempty"`
}

// AdoptEmbeddedMaterialsResp has one entry per requested block, in request order.
type AdoptEmbeddedMaterialsResp struct {
	Materials []AdoptedEmbeddedMaterial `json:"materials" nullable:"false"`
}

// CardContent is one authored flashcard face pair.
type CardContent struct {
	Front string `json:"front"`
	Back  string `json:"back"`
}

// UpdateMaterialReq is the (partial) body for PATCH /api/materials/{id}/metadata.
//
// ChapterID files the material under a chapter (membership): omit to leave it
// unchanged, send an empty string to unfile it, or a chapter id to file it. The
// empty-string sentinel is needed because JSON null is indistinguishable from
// an omitted field with a single pointer.
type UpdateMaterialReq struct {
	Title          *MaterialTitle `json:"title,omitempty" minLength:"1"`
	ChapterID      *string        `json:"chapterId,omitempty" doc:"Chapter to file under; empty string unfiles; omit to leave unchanged"`
	ScopeChapters  *[]string      `json:"scopeChapters,omitempty"`
	ScopeFileNames *[]string      `json:"scopeFileNames,omitempty"`
}

type UpdateStandaloneSharingReq struct {
	Privacy store.Privacy `json:"privacy" doc:"Visibility for a standalone material"`
}

type CreateWorkspaceInviteReq struct {
	Identifier Email                `json:"identifier" minLength:"1" doc:"Exact user ID or email address"`
	Role       store.AssignableRole `json:"role"`
}

type UpdateWorkspaceMemberReq struct {
	Role store.AssignableRole `json:"role"`
}

// TransferWorkspaceReq hands a workspace to another member. The recipient must
// already be a member: transfer charges them for every byte in the workspace, so
// it cannot be done to somebody who has not opted in.
type TransferWorkspaceReq struct {
	RecipientID string `json:"recipientId" minLength:"1"`
}

type CreateDiscussionReq struct {
	BlockID       *string          `json:"blockId,omitempty"`
	AnchorStart   []byte           `json:"anchorStart,omitempty" maxLength:"4096"`
	AnchorEnd     []byte           `json:"anchorEnd,omitempty" maxLength:"4096"`
	AnchorVersion int              `json:"anchorVersion" minimum:"1"`
	AnchorQuote   string           `json:"anchorQuote,omitempty" maxLength:"1000"`
	ContentRich   []map[string]any `json:"contentRich" minItems:"1"`
}

type CreateCommentReq struct {
	ContentRich []map[string]any `json:"contentRich" minItems:"1"`
}

type UpdateCommentReq struct {
	ContentRich []map[string]any `json:"contentRich" minItems:"1"`
}

type CreateQuizReq struct {
	Name        MaterialTitle    `json:"name,omitempty"`
	WorkspaceID string           `json:"workspaceId,omitempty"`
	Chapters    []string         `json:"chapters,omitempty"`
	Questions   []map[string]any `json:"questions,omitempty"`
	Privacy     store.Privacy    `json:"privacy,omitempty"`
}

type UpdateQuizContentReq struct {
	ExpectedRevision int64             `json:"expectedRevision" minimum:"1"`
	Questions        *[]map[string]any `json:"questions,omitempty"`
}

type UpdateQuizMetadataReq struct {
	Name     *MaterialTitle `json:"name,omitempty" minLength:"1"`
	Chapters *[]string      `json:"chapters,omitempty"`
}

// Answers maps part ids to a learner's answers; questions.ScorePart documents
// each answer type's shape. The server grades them against the stored key.
type Answers = map[string]any

type CreateAttemptReq struct {
	Answers Answers `json:"answers" nullable:"false" doc:"The learner's answers by part id"`
}

// GradeAnonymousQuizReq is a signed-out attempt at a shared quiz.
type GradeAnonymousQuizReq struct {
	Answers Answers `json:"answers" nullable:"false" doc:"The learner's answers by part id"`
	// LocalID is the anonymous browser's reporting id for the grading caps.
	LocalID string `json:"localId,omitempty" maxLength:"64"`
}

// CheckReviewItemReq checks one question of a review session.
type CheckReviewItemReq struct {
	MaterialID string  `json:"materialId" minLength:"1"`
	ItemID     string  `json:"itemId" minLength:"1"`
	Answers    Answers `json:"answers" nullable:"false" doc:"The learner's answers by part id"`
}

// CheckBankQuestionReq checks one bank question.
type CheckBankQuestionReq struct {
	Answers Answers `json:"answers" nullable:"false" doc:"The learner's answers by part id"`
}

type CreateFlashcardSetReq struct {
	Name        MaterialTitle   `json:"name,omitempty"`
	Color       store.UserColor `json:"color,omitempty" default:"green"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
}

// GenerateReq is the body for POST /api/workspaces/{id}/generate.
// kind is required; levels is optional. An omitted count takes the requester's
// study preference for the kind (quiz length, flashcards per chapter) in the
// pipeline. detail, diagramType, and types have explicit defaults so
// OpenAPI/orval capture them; the handler does not invent values after the gate.
type GenerateReq struct {
	Kind        store.GenerateKind           `json:"kind"`
	Count       int                          `json:"count,omitempty" minimum:"1" maximum:"50"`
	Levels      []store.CognitiveLevel       `json:"levels,omitempty" nullable:"false"`
	Types       []store.GenerateQuestionType `json:"types,omitempty" minItems:"1" default:"[\"mcq\"]" nullable:"false"`
	Detail      store.GenerateDetail         `json:"detail,omitempty" default:"standard"`
	DiagramType store.GenerateDiagramType    `json:"diagramType,omitempty" default:"auto"`
	Chapters    []string                     `json:"chapters,omitempty" nullable:"false"`
	FileIds     []string                     `json:"fileIds,omitempty" nullable:"false"`
	Title       MaterialTitle                `json:"title" minLength:"1"`
}

// CreateSourceUploadReq reserves a direct-to-blob PUT. Empty kind and parseMode
// are inferred from name, then validated. That inference is not a product default.
type CreateSourceUploadReq struct {
	Name        FileName    `json:"name" minLength:"1"`
	Kind        string      `json:"kind,omitempty"`
	ChapterID   *string     `json:"chapterId,omitempty"`
	ChapterName ChapterName `json:"chapterName,omitempty"`
	ParseMode   string      `json:"parseMode,omitempty"`
	SizeBytes   int64       `json:"sizeBytes"`
	ContentType string      `json:"contentType,omitempty"`
	// EstimatedCreditMicros is the browser's page/duration estimate at the
	// upload policy rates. It only gates admission headroom; the parser
	// receipt bills the measured pages.
	EstimatedCreditMicros int64 `json:"estimatedCreditMicros,omitempty" minimum:"0"`
	// PageCount is the browser's page count for a fast-parse document; a
	// count past the upload policy's maxPages is refused.
	PageCount int `json:"pageCount,omitempty" minimum:"0"`
	// BatchID names the upload (one AddSourceDialog submission) this file
	// belongs to; its notification fires once BatchTotal files settle.
	BatchID    string `json:"batchId" minLength:"1" maxLength:"64" pattern:"^[A-Za-z0-9_-]+$"`
	BatchTotal int    `json:"batchTotal" minimum:"1" maximum:"10000"`
}

// SourceUploadReservation is the presigned PUT the browser uses after reserve.
type SourceUploadReservation struct {
	UploadID  string            `json:"uploadId"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers" nullable:"false"`
	ExpiresAt time.Time         `json:"expiresAt"`
}

// ImportSourcesReq pulls files from a connected Drive/OneDrive account.
type ImportSourcesReq struct {
	Provider    string      `json:"provider" enum:"google,microsoft"`
	FileIds     []string    `json:"fileIds" minItems:"1" maxItems:"20" nullable:"false"`
	DriveIds    []string    `json:"driveIds,omitempty" nullable:"false"`
	ChapterID   *string     `json:"chapterId,omitempty"`
	ChapterName ChapterName `json:"chapterName,omitempty"`
	ParseMode   string      `json:"parseMode,omitempty" enum:"fast,none"`
	RequestID   string      `json:"requestId,omitempty" maxLength:"128"`
	// BatchID names the import submission; BatchTotal is its picked items.
	// Each request then counts its own files in the batch.
	BatchID    string `json:"batchId" minLength:"1" maxLength:"64" pattern:"^[A-Za-z0-9_-]+$"`
	BatchTotal int    `json:"batchTotal" minimum:"1" maximum:"10000"`
}

type SourceImportAccepted struct {
	JobID    string `json:"jobId"`
	UploadID string `json:"uploadId"`
	Name     string `json:"name"`
}

type SourceImportRejected struct {
	FileID string `json:"fileId"`
	Code   string `json:"code"`
}

type ImportSourcesAccepted struct {
	Jobs     []SourceImportAccepted `json:"jobs" nullable:"false"`
	Rejected []SourceImportRejected `json:"rejected" nullable:"false"`
}

type SourceImportStatus struct {
	JobID     string  `json:"jobId"`
	Status    string  `json:"status" enum:"pending,running,succeeded,failed,cancelled"`
	Name      string  `json:"name"`
	FileID    *string `json:"fileId,omitempty"`
	ErrorCode string  `json:"errorCode,omitempty"`
}

// UpdateFlashcardSetReq changes relational metadata only.
type UpdateFlashcardSetReq struct {
	Name  *MaterialTitle   `json:"name,omitempty" minLength:"1"`
	Color *store.UserColor `json:"color,omitempty"`
}

type FlashcardContentInput struct {
	ID    string `json:"id,omitempty"`
	Front string `json:"front" minLength:"1" maxLength:"4000"`
	// A back holds at most 2,000 characters (human/frontend/plate-editor.md).
	Back  string          `json:"back" minLength:"1" maxLength:"2000"`
	Image *FlashcardImage `json:"image,omitempty"`
}

// FlashcardImage is a card's one image: an editor asset uploaded through the
// set, shown on the front under the text.
type FlashcardImage struct {
	AssetID string `json:"assetId" minLength:"1" maxLength:"128"`
}

type UpdateFlashcardContentReq struct {
	ExpectedRevision int64                   `json:"expectedRevision" minimum:"1"`
	Cards            []FlashcardContentInput `json:"cards" minItems:"1"`
}

type CreateEventReq struct {
	Title    EventTitle     `json:"title" minLength:"1"`
	Start    time.Time      `json:"start"`
	End      time.Time      `json:"end"`
	LabelIDs []string       `json:"labelIds,omitempty"`
	Location *EventLocation `json:"location,omitempty"`
	Note     *string        `json:"note,omitempty" maxLength:"2000"`
}

type UpdateEventReq struct {
	Title    *EventTitle    `json:"title,omitempty" minLength:"1"`
	Start    *time.Time     `json:"start,omitempty"`
	End      *time.Time     `json:"end,omitempty"`
	LabelIDs *[]string      `json:"labelIds,omitempty"`
	Location *EventLocation `json:"location,omitempty"`
	Note     *string        `json:"note,omitempty" maxLength:"2000"`
}

type UpdateLabelReq struct {
	Name  *LabelName       `json:"name,omitempty" minLength:"1"`
	Color *store.UserColor `json:"color,omitempty"`
}

type UpdateTaskReq struct {
	Title *TaskTitle `json:"title,omitempty" minLength:"1"`
	Meta  *string    `json:"meta,omitempty" maxLength:"500"`
	Done  *bool      `json:"done,omitempty"`
}

type CreateConversationReq struct {
	Title ConversationTitle `json:"title,omitempty" doc:"Optional thread title"`
}

type CreateCanvasReq struct {
	Name MaterialTitle `json:"name,omitempty"`
}

type SaveCanvasReq struct {
	Name  *MaterialTitle `json:"name,omitempty" minLength:"1"`
	Scene any            `json:"scene,omitempty"`
}

type BillingCheckoutReq struct {
	PlanTier string `json:"planTier" enum:"pro"`
}

/* --------------------------------------------------------- small responses */

// URLResp is returned by billing checkout/portal (a redirect target).
type URLResp struct {
	URL string `json:"url"`
}

// AccessTokenResp is returned by the Google picker-token endpoint.
type AccessTokenResp struct {
	AccessToken string `json:"accessToken"`
}

// MicrosoftDriveHost is Graph GET /me/drive, used to choose the File Picker
// v8 URL (personal vs work). The browser must not infer this from email.
type MicrosoftDriveHost struct {
	ID        string `json:"id"`
	DriveType string `json:"driveType"`
	WebURL    string `json:"webUrl"`
}

/* ------------------------------------------------------------------ helpers */

// decodeQuestions turns stored question JSON into a free-form array for output.
func decodeQuestions(raw []byte) []map[string]any {
	out := []map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = []map[string]any{}
	}
	return out
}

// decodeAnswers turns stored answer JSON into a free-form map for output.
func decodeAnswers(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	return out
}

// EncodeQuestions marshals a free-form question array back to storage bytes.
func EncodeQuestions(qs []map[string]any) json.RawMessage {
	if qs == nil {
		return json.RawMessage("[]")
	}
	b, err := json.Marshal(qs)
	if err != nil {
		return json.RawMessage("[]")
	}
	return b
}

// EncodeRaw marshals any value to json.RawMessage.
func EncodeRaw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// RequestAccountDeletionReq confirms an irreversible action. The email is
// re-typed by the user and verified server-side.
type RequestAccountDeletionReq struct {
	ConfirmEmail        Email `json:"confirmEmail" required:"true" minLength:"1"`
	LifecycleGeneration int64 `json:"lifecycleGeneration" required:"true" minimum:"0"`
}

// SetStudyEnabledReq turns study progress on or off, for one workspace or as
// the account default.
type SetStudyEnabledReq struct {
	Enabled bool `json:"enabled"`
}

// SetStudyItemReq marks one file or material; an omitted state marks it unread.
type SetStudyItemReq struct {
	FileID     *string `json:"fileId,omitempty"`
	MaterialID *string `json:"materialId,omitempty"`
	State      *string `json:"state,omitempty" enum:"done,removed" doc:"Omitted marks the item unread"`
}

// RateReviewItemReq rates a flashcard (rating) or a question answered in
// review (score).
type RateReviewItemReq struct {
	MaterialID string `json:"materialId" minLength:"1"`
	ItemID     string `json:"itemId" minLength:"1"`
	Rating     int    `json:"rating" minimum:"1" maximum:"4" doc:"A flashcard's button: 1 Again .. 4 Easy; questions are rated by POST /api/review/check"`
}

// ReportEditIncidentReq is one editing incident only the browser sees, where
// a user lost or could lose work (human/observability-metering.md,
// 2026-10-05, 2026-10-06). The collaboration service records the room
// incidents itself. Reasons are the tokens the browser sends, nothing else.
type ReportEditIncidentReq struct {
	FileID   string `json:"fileId" minLength:"1" maxLength:"64" pattern:"^[A-Za-z0-9_-]+$" doc:"The note (material) or source file"`
	FileKind string `json:"fileKind" enum:"material,source_file"`
	Kind     string `json:"kind" enum:"other_epoch_draft,draft_unrestorable,draft_storage_failed,unconfirmed_edit,offline_episode,discard_unsaved"`
	Reason   string `json:"reason,omitempty" enum:"reopen,epoch_changed,paused,base_missing,quota,unavailable,write,browser_offline,unreachable,read_only,forbidden,not_found"`
	// The bytes at risk: the drafts involved, or what the device held unsaved.
	// 1 GiB is far above the 100 MB source state cap.
	SizeBytes *int64 `json:"sizeBytes,omitempty" minimum:"0" maximum:"1073741824"`
}
