package store

import "github.com/danielgtaylor/huma/v2"

// This file defines the small string enums shared across the API contract.
//
// Each type implements huma.SchemaProvider so it is emitted ONCE as a named
// component in the OpenAPI spec (e.g. #/components/schemas/Privacy) and reused
// by every request/response field that references it. That gives the frontend
// (orval) a single shared TypeScript union per enum instead of a duplicated
// per-field type — the values stay in lockstep with src/api/types.ts.
//
// The underlying kind is string, so pgx scans/encodes them exactly like a plain
// string column; no sql.Scanner/driver.Valuer is required.

// enumRef registers a string-enum schema under name once and returns a $ref to
// it. Injecting into the registry map (rather than returning an inline schema)
// is what makes huma treat a scalar type as a reusable named component.
func enumRef(r huma.Registry, name string, values ...string) *huma.Schema {
	if r.Map()[name] == nil {
		vals := make([]any, len(values))
		for i, v := range values {
			vals[i] = v
		}
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Enum: vals}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}

// UserColor is the palette shared by workspaces, flashcardSets and labels.
type UserColor string

const (
	ColorGreen       UserColor = "green"
	ColorPurple      UserColor = "purple"
	ColorBlue        UserColor = "blue"
	ColorAmber       UserColor = "amber"
	ColorCoral       UserColor = "coral"
	ColorGraphite    UserColor = "graphite"
	ColorTransparent UserColor = "transparent"
)

func (UserColor) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "UserColor", "green", "purple", "blue", "amber", "coral", "graphite", "transparent")
}

// Privacy is a resource's visibility.
type Privacy string

const (
	PrivacyPrivate Privacy = "private"
	PrivacyPublic  Privacy = "public"
	PrivacyLink    Privacy = "link"
)

func (Privacy) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "Privacy", "private", "public", "link")
}

// WorkspaceRole controls collaborative access. Persisted workspace membership
// and effective link/public material access both use these capability levels.
type WorkspaceRole string

const (
	RoleOwner     WorkspaceRole = "owner"
	RoleEditor    WorkspaceRole = "editor"
	RoleCommenter WorkspaceRole = "commenter"
	RoleViewer    WorkspaceRole = "viewer"
)

func (WorkspaceRole) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "WorkspaceRole", "owner", "editor", "commenter", "viewer")
}

// AssignableRole is a workspace member role that can be granted through invite
// or role change. Ownership moves only through the transfer endpoint.
type AssignableRole string

const (
	AssignableEditor    AssignableRole = "editor"
	AssignableCommenter AssignableRole = "commenter"
	AssignableViewer    AssignableRole = "viewer"
)

func (AssignableRole) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "AssignableRole", "editor", "commenter", "viewer")
}

func (r AssignableRole) WorkspaceRole() WorkspaceRole {
	return WorkspaceRole(r)
}

// ShareRole is the effective material role granted to signed-in nonmembers
// when a workspace is visible by link or publicly. It intentionally excludes
// owner: workspace structure remains governed by persisted membership.
type ShareRole string

const (
	ShareEditor    ShareRole = "editor"
	ShareCommenter ShareRole = "commenter"
	ShareViewer    ShareRole = "viewer"
)

func (ShareRole) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "ShareRole", "editor", "commenter", "viewer")
}

func (r ShareRole) WorkspaceRole() WorkspaceRole {
	switch r {
	case ShareEditor:
		return RoleEditor
	case ShareCommenter:
		return RoleCommenter
	default:
		return RoleViewer
	}
}

// MaterialKind is the canonical persisted kind for a study material.
type MaterialKind string

const (
	MaterialMindmap    MaterialKind = "mindmap"
	MaterialDiagram    MaterialKind = "diagram"
	MaterialQuiz       MaterialKind = "quiz"
	MaterialFlashcards MaterialKind = "flashcards"
	MaterialNote       MaterialKind = "note"
)

func (MaterialKind) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "MaterialKind", "mindmap", "diagram", "quiz", "flashcards", "note")
}

// GenerateKind is the subset of MaterialKind that POST /generate accepts.
type GenerateKind string

const (
	GenerateFlashcards GenerateKind = "flashcards"
	GenerateQuiz       GenerateKind = "quiz"
	GenerateMindmap    GenerateKind = "mindmap"
	GenerateDiagram    GenerateKind = "diagram"
)

func (GenerateKind) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "GenerateKind", "flashcards", "quiz", "mindmap", "diagram")
}

func (k GenerateKind) MaterialKind() MaterialKind { return MaterialKind(k) }

// CognitiveLevel is the Depth-of-Knowledge tag on generated quiz questions.
type CognitiveLevel string

const (
	LevelRecall      CognitiveLevel = "recall"
	LevelApplication CognitiveLevel = "application"
	LevelAnalysis    CognitiveLevel = "analysis"
)

func (CognitiveLevel) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "CognitiveLevel", "recall", "application", "analysis")
}

// GenerateQuestionType is a quiz item shape the generator may emit.
type GenerateQuestionType string

const (
	QuestionMCQ      GenerateQuestionType = "mcq"
	QuestionMulti    GenerateQuestionType = "multi"
	QuestionBoolean  GenerateQuestionType = "boolean"
	QuestionShort    GenerateQuestionType = "short"
	QuestionOpen     GenerateQuestionType = "open"
	QuestionOrdering GenerateQuestionType = "ordering"
	QuestionMatching GenerateQuestionType = "matching"
)

func (GenerateQuestionType) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "GenerateQuestionType", "mcq", "multi", "boolean", "short", "open", "ordering", "matching")
}

// GenerateDetail is the mindmap density knob.
type GenerateDetail string

const (
	DetailBrief    GenerateDetail = "brief"
	DetailStandard GenerateDetail = "standard"
	DetailDetailed GenerateDetail = "detailed"
)

func (GenerateDetail) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "GenerateDetail", "brief", "standard", "detailed")
}

// GenerateDiagramType picks a Mermaid diagram family. auto lets the model choose.
type GenerateDiagramType string

const (
	DiagramAuto      GenerateDiagramType = "auto"
	DiagramFlowchart GenerateDiagramType = "flowchart"
	DiagramSequence  GenerateDiagramType = "sequence"
	DiagramClass     GenerateDiagramType = "class"
	DiagramState     GenerateDiagramType = "state"
	DiagramER        GenerateDiagramType = "er"
)

func (GenerateDiagramType) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "GenerateDiagramType", "auto", "flowchart", "sequence", "class", "state", "er")
}

// MaterialRefType is the kind exposed by the unified materials list.
type MaterialRefType string

const (
	MaterialRefMindmap    MaterialRefType = "mindmap"
	MaterialRefDiagram    MaterialRefType = "diagram"
	MaterialRefQuiz       MaterialRefType = "quiz"
	MaterialRefFlashcards MaterialRefType = "flashcards"
	MaterialRefNote       MaterialRefType = "note"
)

func (MaterialRefType) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "MaterialRefType", "mindmap", "diagram", "quiz", "flashcards", "note")
}

func (k MaterialKind) RefType() MaterialRefType {
	if k == MaterialFlashcards {
		return MaterialRefFlashcards
	}
	return MaterialRefType(k)
}

// MaterialRevisionEvent records why a complete material snapshot was written.
type MaterialRevisionEvent string

const (
	RevisionCreate MaterialRevisionEvent = "create"
	RevisionEdit   MaterialRevisionEvent = "edit"
)

func (MaterialRevisionEvent) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "MaterialRevisionEvent", "create", "edit")
}

// PlanTier is the account subscription tier.
type PlanTier string

const (
	PlanFree PlanTier = "free"
	PlanPro  PlanTier = "pro"
)

func (PlanTier) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "PlanTier", "free", "pro")
}

// SubscriptionStatus mirrors the Stripe subscription lifecycle.
type SubscriptionStatus string

const (
	SubNone     SubscriptionStatus = "none"
	SubActive   SubscriptionStatus = "active"
	SubPastDue  SubscriptionStatus = "past_due"
	SubCanceled SubscriptionStatus = "canceled"
	SubTrialing SubscriptionStatus = "trialing"
)

func (SubscriptionStatus) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "SubscriptionStatus", "none", "active", "past_due", "canceled", "trialing")
}

// FileKind is a source file's type.
type FileKind string

const (
	FilePDF     FileKind = "pdf"
	FileDoc     FileKind = "doc"
	FileMD      FileKind = "md"
	FileImage   FileKind = "image"
	FileTxt     FileKind = "txt"
	FileSheet   FileKind = "sheet"
	FileSlides  FileKind = "slides"
	FileAudio   FileKind = "audio"
	FileJson    FileKind = "json"
	FileUnknown FileKind = "unknown"
)

func (FileKind) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "FileKind", "pdf", "doc", "md", "image", "txt", "sheet", "slides", "audio", "json", "unknown")
}

// FileStatus is the ingest lifecycle state.
type FileStatus string

const (
	FilePending    FileStatus = "pending"
	FileProcessing FileStatus = "processing"
	FileReady      FileStatus = "ready"
	FileFailed     FileStatus = "failed"
)

func (FileStatus) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "FileStatus", "pending", "processing", "ready", "failed")
}

// NotificationKind categorises an in-app notification.
type NotificationKind string

const (
	NotifEvent                  NotificationKind = "event"
	NotifQuiz                   NotificationKind = "quiz"
	NotifSystem                 NotificationKind = "system"
	NotifWorkspaceInvite        NotificationKind = "workspace_invite"
	NotifWorkspaceRoleChanged   NotificationKind = "workspace_role_changed"
	NotifWorkspaceMemberRemoved NotificationKind = "workspace_member_removed"
)

func (NotificationKind) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "NotificationKind", "event", "quiz", "system", "workspace_invite", "workspace_role_changed", "workspace_member_removed")
}

// SearchKind is the category of a global-search hit.
type SearchKind string

const (
	SearchWorkspace  SearchKind = "workspace"
	SearchFile       SearchKind = "file"
	SearchEvent      SearchKind = "event"
	SearchFlashcards SearchKind = "flashcards"
	SearchThinking   SearchKind = "thinking"
)

func (SearchKind) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "SearchKind", "workspace", "file", "event", "flashcards", "thinking")
}

// SrsState is the serialized FSRS scheduling state persisted per flashcard as
// jsonb. Shape mirrors SrsState in src/api/types.ts; the frontend owns the
// algorithm and round-trips this object unchanged.
type SrsState struct {
	Due           string  `json:"due"`
	Stability     float64 `json:"stability"`
	Difficulty    float64 `json:"difficulty"`
	ElapsedDays   int     `json:"elapsed_days"`
	ScheduledDays int     `json:"scheduled_days"`
	Reps          int     `json:"reps"`
	Lapses        int     `json:"lapses"`
	State         int     `json:"state"`
	LastReview    *string `json:"last_review,omitempty"`
	LearningSteps *int    `json:"learning_steps,omitempty"`
}
