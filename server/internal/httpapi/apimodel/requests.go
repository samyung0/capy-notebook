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
	Color store.UserColor `json:"color,omitempty" doc:"User color; defaults to graphite"`
	Tags  []TagInput      `json:"tags,omitempty" doc:"Tags; reuse existing by id or create new by value"`
}

// UpdateWorkspaceReq updates general workspace settings only.
type UpdateWorkspaceReq struct {
	Name  *string          `json:"name,omitempty"`
	Color *store.UserColor `json:"color,omitempty"`
	Tags  *[]TagInput      `json:"tags,omitempty"`
}

// UpdateWorkspaceSharingReq updates visibility and nonmember permissions.
type UpdateWorkspaceSharingReq struct {
	Privacy   *store.Privacy   `json:"privacy,omitempty"`
	ShareRole *store.ShareRole `json:"shareRole,omitempty"`
}

type AddChapterReq struct {
	Name string `json:"name" minLength:"1" doc:"Chapter name"`
}

type UpdateChapterReq struct {
	Name  *string `json:"name,omitempty"`
	Order *int    `json:"order,omitempty"`
}

type ReorderChaptersReq struct {
	IDs []string `json:"ids" doc:"Chapter ids in the desired order"`
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
	Name      *string `json:"name,omitempty"`
	ChapterID *string `json:"chapterId,omitempty"`
}

// CreateMaterialReq is the body for POST /api/workspaces/{id}/materials. Used to
// create a user-authored note (markdown editor). Kind defaults to "note".
type CreateMaterialReq struct {
	Kind           store.MaterialKind    `json:"kind,omitempty" doc:"Material kind; defaults to note"`
	Title          string                `json:"title,omitempty"`
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
	Title            *string        `json:"title,omitempty"`
	ExpectedRevision *int64         `json:"expectedRevision,omitempty" minimum:"1" doc:"Required when changing title"`
	ChapterID        *string        `json:"chapterId,omitempty" doc:"Chapter to file under; empty string unfiles; omit to leave unchanged"`
	ScopeChapters    *[]string      `json:"scopeChapters,omitempty"`
	ScopeFileNames   *[]string      `json:"scopeFileNames,omitempty"`
	Privacy          *store.Privacy `json:"privacy,omitempty" doc:"Visibility (share standalone)"`
}

type CreateWorkspaceInviteReq struct {
	Identifier string              `json:"identifier" minLength:"1" doc:"Exact user ID or email address"`
	Role       store.WorkspaceRole `json:"role"`
}

type UpdateWorkspaceMemberReq struct {
	Role store.WorkspaceRole `json:"role"`
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
	AnchorVersion int              `json:"anchorVersion,omitempty" minimum:"1"`
	AnchorQuote   string           `json:"anchorQuote,omitempty" maxLength:"1000"`
	ContentRich   []map[string]any `json:"contentRich"`
}

type UpdateDiscussionReq struct {
	IsResolved bool `json:"isResolved"`
}

type CreateCommentReq struct {
	ParentCommentID *string          `json:"parentCommentId,omitempty"`
	ContentRich     []map[string]any `json:"contentRich"`
}

type UpdateCommentReq struct {
	ContentRich []map[string]any `json:"contentRich"`
}

type CreateQuizReq struct {
	Name         string           `json:"name,omitempty"`
	WorkspaceID  string           `json:"workspaceId,omitempty"`
	Chapters     []string         `json:"chapters,omitempty"`
	Questions    []map[string]any `json:"questions,omitempty"`
	Privacy      store.Privacy    `json:"privacy,omitempty"`
	TimeLimitMin *int             `json:"timeLimitMin,omitempty"`
}

type UpdateQuizReq struct {
	Name         *string           `json:"name,omitempty"`
	Chapters     *[]string         `json:"chapters,omitempty"`
	Questions    *[]map[string]any `json:"questions,omitempty"`
	Privacy      *store.Privacy    `json:"privacy,omitempty"`
	TimeLimitMin *int              `json:"timeLimitMin,omitempty"`
}

type CreateAttemptReq struct {
	Correct   int              `json:"correct"`
	Total     int              `json:"total"`
	Wrong     []map[string]any `json:"wrong,omitempty" doc:"Questions answered incorrectly"`
	Answers   map[string]any   `json:"answers,omitempty" doc:"User answers keyed by question id"`
	Questions []map[string]any `json:"questions,omitempty" doc:"Question snapshot taken at submit time"`
}

type CreateDeckReq struct {
	Name        string          `json:"name,omitempty"`
	Color       store.UserColor `json:"color,omitempty"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
}

// UpdateDeckReq is the (partial) body for PATCH /api/decks/{id}.
type UpdateDeckReq struct {
	Name    *string          `json:"name,omitempty"`
	Color   *store.UserColor `json:"color,omitempty"`
	Privacy *store.Privacy   `json:"privacy,omitempty" doc:"Visibility (share standalone)"`
}

type CreateCardReq struct {
	Front string `json:"front,omitempty"`
	Back  string `json:"back,omitempty"`
}

type UpdateCardReq struct {
	Front *string         `json:"front,omitempty"`
	Back  *string         `json:"back,omitempty"`
	Known *bool           `json:"known,omitempty"`
	Srs   *store.SrsState `json:"srs,omitempty"`
}

type CreateEventReq struct {
	Title    string    `json:"title" minLength:"1"`
	Start    time.Time `json:"start"`
	End      time.Time `json:"end"`
	LabelIDs []string  `json:"labelIds,omitempty"`
	Location *string   `json:"location,omitempty"`
	Note     *string   `json:"note,omitempty"`
}

type UpdateEventReq struct {
	Title    *string    `json:"title,omitempty"`
	Start    *time.Time `json:"start,omitempty"`
	End      *time.Time `json:"end,omitempty"`
	LabelIDs *[]string  `json:"labelIds,omitempty"`
	Location *string    `json:"location,omitempty"`
	Note     *string    `json:"note,omitempty"`
}

type UpdateTaskReq struct {
	Title *string `json:"title,omitempty"`
	Meta  *string `json:"meta,omitempty"`
	Done  *bool   `json:"done,omitempty"`
}

type CreateConversationReq struct {
	Title string `json:"title,omitempty" maxLength:"200" doc:"Optional thread title"`
}

type CreateCanvasReq struct {
	Name string `json:"name,omitempty"`
}

type SaveCanvasReq struct {
	Name  *string `json:"name,omitempty"`
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

// RecentFile is a lightweight file reference from an external provider.
type RecentFile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
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
	ConfirmEmail string `json:"confirmEmail" required:"true" maxLength:"320"`
}
