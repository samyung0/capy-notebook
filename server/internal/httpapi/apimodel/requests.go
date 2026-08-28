package apimodel

import (
	"encoding/json"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
)

/* ------------------------------------------------------------------ requests */

// CreateWorkspaceReq is the body for POST /api/workspaces. New workspaces are
// always private; visibility is configured later through the sharing endpoint.
type CreateWorkspaceReq struct {
	Name  string          `json:"name" minLength:"1" maxLength:"100" doc:"Workspace name"`
	Color store.UserColor `json:"color,omitempty" default:"graphite" doc:"User color"`
	Tags  []TagInput      `json:"tags,omitempty" maxItems:"5" doc:"Tags; at most 5; reuse existing by id or create new by value"`
}

// UpdateWorkspaceReq updates general workspace settings only.
type UpdateWorkspaceReq struct {
	Name  *string          `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Color *store.UserColor `json:"color,omitempty"`
	Tags  *[]TagInput      `json:"tags,omitempty" maxItems:"5" doc:"Tags; at most 5"`
}

// UpdateWorkspaceSharingReq updates visibility and nonmember permissions.
type UpdateWorkspaceSharingReq struct {
	Privacy   *store.Privacy   `json:"privacy,omitempty"`
	ShareRole *store.ShareRole `json:"shareRole,omitempty"`
}

type AddChapterReq struct {
	Name string `json:"name" minLength:"1" maxLength:"255" doc:"Chapter name"`
}

type UpdateChapterReq struct {
	Name  *string `json:"name,omitempty" minLength:"1" maxLength:"255"`
	Order *int    `json:"order,omitempty"`
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
	Name      *string `json:"name,omitempty" minLength:"1" maxLength:"512"`
	ChapterID *string `json:"chapterId,omitempty"`
}

// CreateMaterialReq is the body for POST /api/workspaces/{id}/materials.
type CreateMaterialReq struct {
	Kind           store.MaterialKind    `json:"kind" doc:"Material kind"`
	Title          string                `json:"title,omitempty" maxLength:"200"`
	Content        *materialdoc.Envelope `json:"content,omitempty" doc:"Versioned Plate document"`
	ScopeChapters  []string              `json:"scopeChapters,omitempty"`
	ScopeFileNames []string              `json:"scopeFileNames,omitempty"`
}

// UpdateMaterialReq is the (partial) body for PATCH /api/materials/{id}.
//
// ChapterID files the material under a chapter (membership): omit to leave it
// unchanged, send an empty string to unfile it, or a chapter id to file it. The
// empty-string sentinel is needed because JSON null is indistinguishable from
// an omitted field with a single pointer.
type UpdateMaterialReq struct {
	Title            *string        `json:"title,omitempty" minLength:"1" maxLength:"200"`
	ExpectedRevision *int64         `json:"expectedRevision,omitempty" minimum:"1" doc:"Required when changing title"`
	ChapterID        *string        `json:"chapterId,omitempty" doc:"Chapter to file under; empty string unfiles; omit to leave unchanged"`
	ScopeChapters    *[]string      `json:"scopeChapters,omitempty"`
	ScopeFileNames   *[]string      `json:"scopeFileNames,omitempty"`
	Privacy          *store.Privacy `json:"privacy,omitempty" doc:"Visibility (share standalone)"`
}

type CreateWorkspaceInviteReq struct {
	Identifier string               `json:"identifier" minLength:"1" maxLength:"320" doc:"Exact user ID or email address"`
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

type UpdateDiscussionReq struct {
	IsResolved bool `json:"isResolved"`
}

type CreateCommentReq struct {
	ParentCommentID *string          `json:"parentCommentId,omitempty"`
	ContentRich     []map[string]any `json:"contentRich" minItems:"1"`
}

type UpdateCommentReq struct {
	ContentRich []map[string]any `json:"contentRich" minItems:"1"`
}

type CreateQuizReq struct {
	Name         string           `json:"name,omitempty" maxLength:"200"`
	WorkspaceID  string           `json:"workspaceId,omitempty"`
	Chapters     []string         `json:"chapters,omitempty"`
	Questions    []map[string]any `json:"questions,omitempty"`
	Privacy      store.Privacy    `json:"privacy,omitempty"`
	TimeLimitMin *int             `json:"timeLimitMin,omitempty" minimum:"1" maximum:"180"`
}

type UpdateQuizReq struct {
	Name         *string           `json:"name,omitempty" minLength:"1" maxLength:"200"`
	Chapters     *[]string         `json:"chapters,omitempty"`
	Questions    *[]map[string]any `json:"questions,omitempty"`
	Privacy      *store.Privacy    `json:"privacy,omitempty"`
	TimeLimitMin *int              `json:"timeLimitMin,omitempty" minimum:"1" maximum:"180"`
}

type CreateAttemptReq struct {
	Correct   float64          `json:"correct" minimum:"0"`
	Total     float64          `json:"total" exclusiveMinimum:"0"`
	Wrong     []map[string]any `json:"wrong,omitempty" doc:"Questions answered incorrectly"`
	Answers   map[string]any   `json:"answers,omitempty" doc:"User answers keyed by question id"`
	Questions []map[string]any `json:"questions,omitempty" doc:"Question snapshot taken at submit time"`
}

type CreateDeckReq struct {
	Name        string          `json:"name,omitempty" maxLength:"200"`
	Color       store.UserColor `json:"color,omitempty" default:"green"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
}

// GenerateReq is the body for POST /api/workspaces/{id}/generate.
// kind, count, and levels are required. detail, diagramType, and types have
// explicit defaults so OpenAPI/orval capture them; the handler does not invent
// values after the gate.
type GenerateReq struct {
	Kind         store.GenerateKind           `json:"kind"`
	Count        int                          `json:"count" minimum:"1" maximum:"50"`
	Levels       []store.CognitiveLevel       `json:"levels" minItems:"1" nullable:"false"`
	Types        []store.GenerateQuestionType `json:"types,omitempty" minItems:"1" default:"[\"mcq\"]" nullable:"false"`
	Detail       store.GenerateDetail         `json:"detail,omitempty" default:"standard"`
	DiagramType  store.GenerateDiagramType    `json:"diagramType,omitempty" default:"auto"`
	Length       string                       `json:"length,omitempty"`
	Format       string                       `json:"format,omitempty"`
	Style        string                       `json:"style,omitempty"`
	Chapters     []string                     `json:"chapters,omitempty" nullable:"false"`
	FileIds      []string                     `json:"fileIds,omitempty" nullable:"false"`
	TimeLimitMin *int                         `json:"timeLimitMin,omitempty" minimum:"1" maximum:"180"`
	Title        string                       `json:"title" minLength:"1" maxLength:"200"`
}

// CreateSourceUploadReq reserves a direct-to-blob PUT. Empty kind and parseMode
// are inferred from name, then validated. That inference is not a product default.
type CreateSourceUploadReq struct {
	Name          string  `json:"name"`
	Kind          string  `json:"kind,omitempty"`
	ChapterID     *string `json:"chapterId,omitempty"`
	ChapterName   string  `json:"chapterName,omitempty"`
	ParseMode     string  `json:"parseMode,omitempty"`
	CaptionImages bool    `json:"captionImages"`
	SizeBytes     int64   `json:"sizeBytes"`
	ContentType   string  `json:"contentType,omitempty"`
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
	Provider  string   `json:"provider" enum:"google,microsoft"`
	FileIds   []string `json:"fileIds" minItems:"1" nullable:"false"`
	DriveIds  []string `json:"driveIds,omitempty" nullable:"false"`
	ChapterID *string  `json:"chapterId,omitempty"`
	RequestID string   `json:"requestId,omitempty" maxLength:"128"`
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

// UpdateDeckReq is the (partial) body for PATCH /api/decks/{id}.
type UpdateDeckReq struct {
	Name    *string          `json:"name,omitempty" minLength:"1" maxLength:"200"`
	Color   *store.UserColor `json:"color,omitempty"`
	Privacy *store.Privacy   `json:"privacy,omitempty" doc:"Visibility (share standalone)"`
}

type CreateCardReq struct {
	Front string `json:"front" minLength:"1" maxLength:"4000"`
	Back  string `json:"back" minLength:"1" maxLength:"4000"`
}

type UpdateCardReq struct {
	Front *string         `json:"front,omitempty" minLength:"1" maxLength:"4000"`
	Back  *string         `json:"back,omitempty" minLength:"1" maxLength:"4000"`
	Known *bool           `json:"known,omitempty"`
	Srs   *store.SrsState `json:"srs,omitempty"`
}

type CreateEventReq struct {
	Title    string    `json:"title" minLength:"1" maxLength:"200"`
	Start    time.Time `json:"start"`
	End      time.Time `json:"end"`
	LabelIDs []string  `json:"labelIds,omitempty"`
	Location *string   `json:"location,omitempty" maxLength:"200"`
	Note     *string   `json:"note,omitempty" maxLength:"2000"`
}

type UpdateEventReq struct {
	Title    *string    `json:"title,omitempty" minLength:"1" maxLength:"200"`
	Start    *time.Time `json:"start,omitempty"`
	End      *time.Time `json:"end,omitempty"`
	LabelIDs *[]string  `json:"labelIds,omitempty"`
	Location *string    `json:"location,omitempty" maxLength:"200"`
	Note     *string    `json:"note,omitempty" maxLength:"2000"`
}

type UpdateLabelReq struct {
	Name  *string          `json:"name,omitempty" minLength:"1" maxLength:"60"`
	Color *store.UserColor `json:"color,omitempty"`
}

type UpdateTaskReq struct {
	Title *string `json:"title,omitempty" minLength:"1" maxLength:"200"`
	Meta  *string `json:"meta,omitempty" maxLength:"500"`
	Done  *bool   `json:"done,omitempty"`
}

type CreateConversationReq struct {
	Title string `json:"title,omitempty" maxLength:"200" doc:"Optional thread title"`
}

type CreateCanvasReq struct {
	Name string `json:"name,omitempty" maxLength:"200"`
}

type SaveCanvasReq struct {
	Name  *string `json:"name,omitempty" minLength:"1" maxLength:"200"`
	Scene any     `json:"scene,omitempty"`
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

// EncodeRaw marshals any value to json.RawMessage (used for scene/srs/wrong).
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
	ConfirmEmail string `json:"confirmEmail" required:"true" minLength:"1" maxLength:"320"`
}
