package store

import (
	"encoding/json"
	"github.com/samyung0/capy-notebook/server/internal/cover"
	"reflect"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

// JSON tags match src/api/types.ts exactly so responses are drop-in for the
// existing frontend (camelCase, nullable fields as pointers).

type User struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	AvatarIconID string `json:"avatarIconId,omitempty"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
	ClassLabel   string `json:"classLabel,omitempty"`
	Streak       int    `json:"streak"`
	Locale       string `json:"locale"`
	// StudyPreferences shape what the chat agent builds; empty fields take the
	// pipeline's defaults.
	StudyPreferences StudyPreferences `json:"studyPreferences"`
	// ChatSteps is how much of a turn's tool work the chat shows.
	ChatSteps string `json:"chatSteps" enum:"normal,verbose"`
	// ChatSendKey is the key that sends a chat message; the other adds a line.
	ChatSendKey string `json:"chatSendKey" enum:"enter,shift_enter"`
	// Customization is the look last synced from one of the user's devices;
	// nil until they first press Sync.
	Customization      *Customization     `json:"customization,omitempty"`
	ChatModel          models.Ref         `json:"chatModel"`
	EditorModel        models.Ref         `json:"editorModel"`
	PlanTier           PlanTier           `json:"planTier"`
	SubscriptionStatus SubscriptionStatus `json:"subscriptionStatus"`
}

// Customization is how the app looks for one account: the style, the theme
// and the painted page frame (openwiki/frontend/appearance.md). Devices keep
// it locally; Sync stores it here for the user's other devices. Every field is
// required and bounded, and unknown fields are refused, so a stored value is
// always one the app can apply.
type Customization struct {
	Style     string    `json:"style" enum:"capy,fisheye,notion"`
	Theme     string    `json:"theme" enum:"latte,frappe,mocha"`
	PageFrame PageFrame `json:"pageFrame"`
}

// PageFrame is the paint behind the page panel: a pattern drawn in a colour
// preset or in up to three custom colours, each a point on the hue (x) and
// saturation (y) field. Frosted names the panels that turn translucent over
// it.
type PageFrame struct {
	Pattern  string           `json:"pattern" enum:"none,arc,mesh,glow"`
	Colours  string           `json:"colours" enum:"dawn,dusk,sea,meadow,rose,sunset,wheat,mist,custom"`
	Dots     []PageFrameColor `json:"dots" minItems:"1" maxItems:"3"`
	Strength float64          `json:"strength" minimum:"0" maximum:"1"`
	Frosted  []string         `json:"frosted" enum:"left,center,right" maxItems:"3" uniqueItems:"true"`
}

// PageFrameColor is one custom colour as a point on the colour field.
type PageFrameColor struct {
	X float64 `json:"x" minimum:"0" maximum:"1"`
	Y float64 `json:"y" minimum:"0" maximum:"1"`
}

// StudyPreferences are the learner's defaults for what the agent builds
// (todo-learning.md, 1.4). Zero values are unset, so the pipeline's defaults
// apply to them.
type StudyPreferences struct {
	// MainFormat is the output file that explains each chapter (Capy Note or
	// Powerpoint); the agent still makes other files when needed.
	MainFormat   string `json:"mainFormat,omitempty" enum:"note,deck"`
	WritingStyle string `json:"writingStyle,omitempty" enum:"brief,normal,verbose,story"`
	// How much of each practice item a chapter gets (more 10, less 5).
	Quiz       string `json:"quiz,omitempty" enum:"more,less,off"`
	Flashcards string `json:"flashcards,omitempty" enum:"more,less,off"`
	VisualAids string `json:"visualAids,omitempty" enum:"fewer,more"`
	// KnowledgeChecks are a Capy Note's small checks of questions or cards.
	KnowledgeChecks *bool `json:"knowledgeChecks,omitempty"`
	// Review sessions (human/study-progress.md, 2026-10-10): items per
	// session (default 20), which items reviews draw from (default both) and
	// which mode suggestions favour (default balanced). The chat ignores them.
	ReviewSize  int    `json:"reviewSize,omitempty" enum:"10,20,30,50"`
	ReviewItems string `json:"reviewItems,omitempty" enum:"both,quiz,flashcards"`
	ReviewFocus string `json:"reviewFocus,omitempty" enum:"balanced,tricky,fading,learned"`
}

type Workspace struct {
	// AutoProcess lets automatic processing reparse and reindex edited files
	// and notes; off, edits wait for the owner's Process.
	AutoProcess bool   `json:"autoProcess"`
	Description string `json:"description"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	IconID      string `json:"iconId"`
	// Cover is the card's art; nil means no cover, the default.
	Cover     *cover.Cover `json:"cover,omitempty"`
	Privacy   Privacy      `json:"privacy"`
	ShareRole ShareRole    `json:"shareRole"`
	// SharePath is the signed public summary path, /w/{id}.{signature}.
	SharePath string `json:"sharePath"`
	Tags      []Tag  `json:"tags"`
	// OwnerUserID is the account every byte in this workspace is charged to.
	// It is the account whose quota governs whether members may add content,
	// so it is not interchangeable with the requester.
	OwnerUserID string `json:"ownerUserId"`
	// OwnerPlanTier is loaded only to resolve this process's startup plan
	// snapshot. It is not exposed as workspace API data.
	OwnerPlanTier PlanTier `json:"-"`
	// MemberRole is the requester's persisted membership ("" for a visitor),
	// filled by the listing queries so capabilities need no second lookup.
	MemberRole   WorkspaceRole `json:"-"`
	ChapterCount int           `json:"chapterCount"`
	FileCount    int           `json:"fileCount"`
	FilesLimit   int           `json:"filesLimit"`
	CreatedAt    time.Time     `json:"createdAt"`
}

// AccessCapabilities is request-scoped authorization metadata. It is never
// persisted and must be derived from the requester's workspace role.
// CanEdit covers organizing (rename, move, reorder, delete) and creating;
// CanEditContent is edit mode, comments and annotations, which the storage
// owner at or over its limit also turns off.
type AccessCapabilities struct {
	CanView          bool `json:"canView"`
	CanEdit          bool `json:"canEdit"`
	CanEditContent   bool `json:"canEditContent"`
	CanManageMembers bool `json:"canManageMembers"`
}

// Tag is a catalog tag as read back for an entity: a stable catalog id plus its
// display value (the tag name). The id lets clients reference the same catalog
// row on the next write so per-tag metadata is reused rather than recreated.
type Tag struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

// TagRef is one tag on an incoming write. ID is nil when the client is proposing
// a brand-new tag (resolved find-or-create by Value); when set, the backend
// reuses that catalog row (preserving its metadata).
type TagRef struct {
	ID    *string
	Value string
}

// tagsFromNames wraps bare tag names (e.g. the denormalized public snapshot,
// which has no catalog ids) as Tag rows with empty ids.
func tagsFromNames(names []string) []Tag {
	out := make([]Tag, len(names))
	for i, n := range names {
		out[i] = Tag{Value: n}
	}
	return out
}

type Chapter struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	Order       int      `json:"order"`
	FileIDs     []string `json:"fileIds" nullable:"false"`
}

type File struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspaceId"`
	ChapterID   *string    `json:"chapterId"` // null = unfiled (not omitempty)
	Position    int64      `json:"position"`
	Name        string     `json:"name"`
	Kind        FileKind   `json:"kind"`
	SizeBytes   int64      `json:"sizeBytes"`
	AddedAt     time.Time  `json:"addedAt"`
	Status      FileStatus `json:"status,omitempty"`
	// Indexed is true after ingest has written retrieval chunks. Ready files
	// stored without parsing stay false: they are viewable but invisible to
	// chat and generate.
	Indexed bool `json:"indexed"`
	// IndexLimit names the ingest limit a ready, unindexed file's content is
	// over (too many pages, pixels, audio hours, CSV cells or text). The file
	// opens and downloads as usual; only search and chat skip it.
	IndexLimit *FileIndexLimit `json:"indexLimit,omitempty"`
	// HasBytes says a source object exists. Bytes are read through the links
	// endpoint's presigned URLs; the row never carries a fetchable URL.
	HasBytes bool `json:"hasBytes"`
	// PreviewURL renders the exact paginated bytes used for citation regions.
	// It is absent until ingest has finished.
	PreviewURL *string `json:"previewUrl,omitempty"`
	Revision   int64   `json:"revision"`
	// Provenance credits the library books a generated file was written from;
	// nil for an upload.
	Provenance *Provenance `json:"provenance,omitempty"`
	// ThumbnailKey is the page-1 WebP object; list handlers sign it into
	// ThumbnailURL for rows the caller can already read.
	ThumbnailKey string `json:"-"`
	// PayerID is the uploader who pays; handlers turn it into IsPayer for the
	// caller, so no other account id leaves the server.
	PayerID string `json:"-"`
	// IsPayer: the caller pays for the file, so it may move it (Epo
	// 2026-10-27) whatever its role in the workspace.
	IsPayer      bool    `json:"isPayer"`
	ThumbnailURL *string `json:"thumbnailUrl,omitempty" doc:"Hour-stable presigned GET of the page-1 thumbnail; list rows only"`
	// Preview is a text source's opening characters.
	Preview FilePreview `json:"preview,omitempty"`
	// ErrorID is a failed file's error id for the Indexing tab's Failed files:
	// the trace of the ingest attempt that failed it (migration 0105). Only the
	// workspace file list sends it, and only to the owner and editors.
	ErrorID string `json:"errorId,omitempty"`
	// WorkspaceName and LostAccess: owned-list rows only (ListOwnedFiles).
	WorkspaceName string `json:"workspaceName,omitempty"`
	LostAccess    bool   `json:"lostAccess,omitempty" doc:"The file sits in a workspace the caller no longer owns or belongs to; they still pay for it and may only delete it"`
}

// FilePreview is {"text": ...}, a text source's first ~600 characters written
// at ingest (openwiki/thumbnails.md). Rows pass the stored JSON through.
type FilePreview json.RawMessage

func (p FilePreview) MarshalJSON() ([]byte, error) { return rawOrNull(p), nil }

// UnmarshalJSON keeps the bytes, which is how pgx scans the jsonb column.
func (p *FilePreview) UnmarshalJSON(b []byte) error {
	*p = append((*p)[:0], b...)
	return nil
}

func (FilePreview) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{
		Type:       huma.TypeObject,
		Properties: map[string]*huma.Schema{"text": {Type: huma.TypeString}},
		Required:   []string{"text"},
	}
}

// MaterialPreview is a material's list-card preview, the union on kind that
// materialdoc.Preview writes to materials.preview (openwiki/thumbnails.md).
// Rows pass the stored JSON through; the client types the union by hand.
type MaterialPreview json.RawMessage

func (p MaterialPreview) MarshalJSON() ([]byte, error) { return rawOrNull(p), nil }

// UnmarshalJSON keeps the bytes, which is how pgx scans the jsonb column.
func (p *MaterialPreview) UnmarshalJSON(b []byte) error {
	*p = append((*p)[:0], b...)
	return nil
}

func (MaterialPreview) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{
		Type:                 huma.TypeObject,
		AdditionalProperties: true,
		Description:          "List-card preview, a union on kind (note, quiz, flashcards, mindmap, diagram); see openwiki/thumbnails.md",
	}
}

func rawOrNull(raw []byte) []byte {
	if len(raw) == 0 {
		return []byte("null")
	}
	return raw
}

type Quiz struct {
	Revision       int64           `json:"revision"`
	ID             string          `json:"id"`
	UserID         string          `json:"-"`
	Name           string          `json:"name"`
	WorkspaceID    string          `json:"workspaceId"`
	WorkspaceName  string          `json:"workspaceName"`
	Chapters       []string        `json:"chapters"`
	ScopeFileNames []string        `json:"-"`
	Questions      json.RawMessage `json:"questions"`
	CreatedAt      time.Time       `json:"createdAt"`
	Privacy        Privacy         `json:"privacy"`
	TimeLimitMin   *int            `json:"timeLimitMin,omitempty"`
	// SharePath is the signed share link of a standalone quiz.
	SharePath string `json:"sharePath,omitempty"`
	// ParentMaterialID is the note a quiz is embedded in (a quick check).
	ParentMaterialID string `json:"parentMaterialId,omitempty"`
	// Provenance is the source material's attribution record; the attempt page
	// renders it as a footer.
	Provenance *Provenance `json:"provenance,omitempty"`
	// IsOwner and CanEdit are request-scoped capabilities, not persisted quiz
	// attributes. Explicit workspace editors can edit without owning it.
	// CanEditContent is CanEdit unless the storage owner is at its limit.
	IsOwner        bool `json:"isOwner"`
	CanEdit        bool `json:"canEdit"`
	CanEditContent bool `json:"canEditContent"`
}

type Attempt struct {
	ID string `json:"id"`
	// MaterialID becomes null when the source quiz is deleted. QuizName and
	// WorkspaceName are the submit-time snapshot that keeps the row readable.
	MaterialID *string `json:"materialId"`
	// WorkspaceID is the quiz's current workspace, null with MaterialID.
	WorkspaceID *string `json:"workspaceId"`
	// IconID is that workspace's catalog icon, filled by the attempts list
	// and a single result, which show it beside the workspace name.
	IconID *string `json:"iconId,omitempty"`
	// Kind is quiz or flashcards; QuizName is the quiz's or set's name.
	Kind          string   `json:"kind" enum:"quiz,flashcards"`
	QuizName      string   `json:"quizName"`
	WorkspaceName string   `json:"workspaceName"`
	Chapters      []string `json:"chapters" nullable:"false"`
	// Correct of Total: marks for a quiz, cards first rated Good or Easy of
	// cards rated for a set.
	Correct float64 `json:"correct"`
	Total   float64 `json:"total"`
	Pct     int     `json:"pct"`
	// StartedAt is when the learner began; null for an attempt sent without it.
	StartedAt *time.Time `json:"startedAt"`
	// TakenAt is a quiz's submit time, or a set's latest rating.
	TakenAt time.Time `json:"takenAt"`
}

// AttemptCard is one card of a flashcard attempt, in the order first rated,
// with its faces as studied and every rating it got (1 Again .. 4 Easy).
type AttemptCard struct {
	ID      string                 `json:"id"`
	Front   string                 `json:"front"`
	Back    string                 `json:"back"`
	Image   *materialdoc.CardImage `json:"image,omitempty"`
	Ratings []int                  `json:"ratings" nullable:"false"`
}

// AttemptDetail carries the per-question payload for a single attempt's result
// breakdown. Answers is a map keyed by question id; Questions is the snapshot
// taken at submit time. Both stay opaque JSON (the frontend owns the shapes).
type AttemptDetail struct {
	Attempt
	Answers   json.RawMessage
	Questions json.RawMessage
	// Previous is a flashcard attempt's earlier attempt of the same set, for
	// the result's change since then; nil for a quiz or a first attempt.
	Previous *PreviousAttempt
}

// PreviousAttempt is the score and time of the attempt before a result.
type PreviousAttempt struct {
	Correct float64   `json:"correct"`
	Total   float64   `json:"total"`
	TakenAt time.Time `json:"takenAt"`
}

type FlashcardSet struct {
	Revision      int64     `json:"revision"`
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	WorkspaceID   string    `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	Color         UserColor `json:"color"`
	Privacy       Privacy   `json:"privacy"`
	// SharePath is the signed share link of a standalone flashcard set.
	SharePath string `json:"sharePath,omitempty"`
	// Author is the owner a shared page shows; only the single-set read fills it.
	Author *MaterialAuthor `json:"author,omitempty"`
	// ParentMaterialID is the note a set is embedded in: a quick check that
	// records nothing (its study page sends no ratings), and the note's own only
	// when it names that note.
	ParentMaterialID string `json:"parentMaterialId,omitempty"`
	CardCount        int    `json:"cardCount"`
	// Provenance is the source material's attribution record; the study page
	// renders it as a footer.
	Provenance *Provenance `json:"provenance,omitempty"`
	// IsOwner and CanEdit are request-scoped capabilities. Explicit workspace
	// editors can edit without owning it; link/public visitors cannot.
	// CanEditContent (the cards) is CanEdit unless the storage owner is at its
	// limit.
	IsOwner        bool `json:"isOwner"`
	CanEdit        bool `json:"canEdit"`
	CanEditContent bool `json:"canEditContent"`
	// RemovedAssetIDs are its card images that no longer exist: deleted by
	// their uploader, or with the uploader's account (M16). Study shows each
	// as removed instead of loading it.
	RemovedAssetIDs []string `json:"removedAssetIds,omitempty"`
}

type Flashcard struct {
	Revision   int64                  `json:"revision"`
	ID         string                 `json:"id"`
	MaterialID string                 `json:"materialId"`
	Front      string                 `json:"front"`
	Back       string                 `json:"back"`
	Image      *materialdoc.CardImage `json:"image,omitempty"`
}

// Material is a persisted versioned Plate document scoped to chapters and/or
// files. Every material kind shares this universal envelope.
//
// ScopeChapters/ScopeFileNames record *provenance* (what a generated artifact was
// built from). ChapterID is the orthogonal *membership* link — which chapter
// the material is filed under in the tree (null = unfiled), mirroring File.
type Material struct {
	ID string `json:"id"`
	// CreatedBy is the author; empty when the authoring account was hard-deleted.
	// OwnerUserID is the storage owner and is never empty. See the FK notes in
	// the migration for why the two axes differ.
	CreatedBy     string       `json:"-"`
	OwnerUserID   string       `json:"-"`
	WorkspaceID   string       `json:"workspaceId"`
	WorkspaceName string       `json:"workspaceName"`
	Kind          MaterialKind `json:"kind"`
	Title         string       `json:"title"`
	// Content is the encoded materialdoc.Envelope stored as jsonb. The API
	// model decodes it so clients receive an object rather than a JSON string.
	Content        string    `json:"-"`
	ChapterID      *string   `json:"chapterId"` // null = unfiled (not omitempty)
	Position       int64     `json:"position"`
	ScopeChapters  []string  `json:"scopeChapters" nullable:"false"`
	ScopeFileNames []string  `json:"scopeFileNames" nullable:"false"`
	Privacy        Privacy   `json:"privacy"`
	Color          UserColor `json:"color,omitempty"` // flashcardSets only; presentation tint
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	Revision       int64     `json:"revision"`
	SizeBytes      int64     `json:"-"`
	NodeCount      int       `json:"-"`
	MaxDepth       int       `json:"-"`
	// Provenance is the attribution record of a material written from the
	// shared knowledge library; nil for everything else. Written at creation,
	// appended by curate edits, and rendered outside the editable document.
	Provenance *Provenance `json:"provenance,omitempty"`
	// ParentMaterialID is set on a quiz or flashcard set embedded in a note.
	// The note owns its lifecycle and access; see embedded.go.
	ParentMaterialID string `json:"parentMaterialId,omitempty"`
	// IsOwner is request-scoped (not persisted): true when the requester owns
	// the parent workspace, false for link/public shared reads.
	IsOwner      bool               `json:"isOwner"`
	Role         *WorkspaceRole     `json:"role,omitempty"`
	Capabilities AccessCapabilities `json:"capabilities"`
}

// Provenance is what a curated material or generated file was written from:
// one entry per source book, plus the work's own licence when a source is
// copyleft.
type Provenance struct {
	Books []ProvenanceBook `json:"books" nullable:"false"`
	// Web lists pages a bank passage was adapted from; library materials leave it empty.
	Web []ProvenanceWeb `json:"web,omitempty"`
	// License is computed by the server from the books, never supplied.
	License string `json:"license,omitempty"`
	// Questions credits each question copied from the question bank, keyed by
	// its id in the quiz: where its passage and figures came from. It shows
	// under that question rather than in the material's footer, and only the
	// bank copy route writes it.
	Questions map[string]QuestionCredit `json:"questions,omitempty"`
}

// QuestionCredit is the sources of one copied bank question, resolved by the
// server from the bank, with the licence computed over them.
type QuestionCredit struct {
	Books   []ProvenanceBook `json:"books" nullable:"false"`
	Web     []ProvenanceWeb  `json:"web,omitempty"`
	License string           `json:"license,omitempty"`
}

// ProvenanceWeb is one openly licensed web page, as it read on RetrievedAt.
type ProvenanceWeb struct {
	URL         string   `json:"url"`
	Title       string   `json:"title"`
	Authors     []string `json:"authors" nullable:"false"`
	Publisher   string   `json:"publisher,omitempty"`
	License     string   `json:"license"`
	LicenseURL  string   `json:"licenseUrl,omitempty"`
	RetrievedAt string   `json:"retrievedAt"`
}

// ProvenanceBook is one source book with the excerpts the material used.
type ProvenanceBook struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Authors []string `json:"authors" nullable:"false"`
	Edition string   `json:"edition,omitempty"`
	// Version is the book version the excerpts were read from: a later publish
	// of the same book does not change what this material was written from.
	Version    int      `json:"version"`
	License    string   `json:"license,omitempty"`
	LicenseURL string   `json:"licenseUrl,omitempty"`
	SourceURL  string   `json:"sourceUrl,omitempty"`
	ExcerptIDs []string `json:"excerptIds" nullable:"false"`
}

// MarshalJSON exposes the stored jsonb bytes as a Plate envelope object rather
// than a quoted JSON string. Content stays a string internally so legacy
// generator call sites can cross the store boundary without owning the
// persistence contract.
func (m Material) MarshalJSON() ([]byte, error) {
	content, err := materialdoc.Parse(m.Content)
	if err != nil {
		return nil, err
	}
	type materialFields Material
	return json.Marshal(struct {
		materialFields
		Content materialdoc.Envelope `json:"content"`
	}{
		materialFields: materialFields(m),
		Content:        content,
	})
}

func (Material) TransformSchema(r huma.Registry, schema *huma.Schema) *huma.Schema {
	schema.Properties["content"] = huma.SchemaFromType(r, reflect.TypeOf(materialdoc.Envelope{}))
	schema.Required = append(schema.Required, "content")
	return schema
}

type WorkspaceMember struct {
	WorkspaceID string        `json:"workspaceId"`
	UserID      string        `json:"userId"`
	Name        string        `json:"name"`
	AvatarURL   string        `json:"avatarUrl,omitempty"`
	Role        WorkspaceRole `json:"role"`
	CreatedAt   time.Time     `json:"createdAt"`
}

// WorkspaceCollaborator is the directory entry served to everyone who may
// comment, which on a link or public workspace includes nonmembers. It carries
// only what a mention menu renders. Email is personal data collected through
// the invitation flow and would enable account enumeration, and the roster of
// who holds which role is the workspace owner's business, so neither is here.
type WorkspaceCollaborator struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

type WorkspaceInvite struct {
	ID            string        `json:"id"`
	WorkspaceID   string        `json:"workspaceId"`
	InvitedUserID string        `json:"invitedUserId"`
	Email         string        `json:"email"`
	Role          WorkspaceRole `json:"role"`
	Token         string        `json:"token,omitempty"`
	InvitedBy     string        `json:"invitedBy"`
	ExpiresAt     time.Time     `json:"expiresAt"`
	AcceptedAt    *time.Time    `json:"acceptedAt,omitempty"`
	RevokedAt     *time.Time    `json:"revokedAt,omitempty"`
	CreatedAt     time.Time     `json:"createdAt"`
}

// Discussion and Comment carry their author's display identity rather than
// leaving the client to join against the current member list. Attribution
// belongs to the moment the thread was written: a contributor who has since
// been removed from the workspace still wrote it, and a reader who is not a
// member has no roster to look them up in.
type Discussion struct {
	ID              string    `json:"id"`
	MaterialID      string    `json:"materialId"`
	BlockID         *string   `json:"blockId,omitempty"`
	AnchorStart     []byte    `json:"anchorStart,omitempty"`
	AnchorEnd       []byte    `json:"anchorEnd,omitempty"`
	AnchorVersion   int       `json:"anchorVersion"`
	AnchorQuote     string    `json:"anchorQuote"`
	CreatedBy       string    `json:"userId"`
	AuthorName      string    `json:"authorName"`
	AuthorAvatarURL string    `json:"authorAvatarUrl,omitempty"`
	IsDeleted       bool      `json:"isDeleted"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	Comments        []Comment `json:"comments" nullable:"false"`
}

type Comment struct {
	ID              string `json:"id"`
	DiscussionID    string `json:"discussionId"`
	UserID          string `json:"userId"`
	AuthorName      string `json:"authorName"`
	AuthorAvatarURL string `json:"authorAvatarUrl,omitempty"`
	// Text is empty for a deleted comment.
	Text      string    `json:"text"`
	IsEdited  bool      `json:"isEdited"`
	IsDeleted bool      `json:"isDeleted"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// MaterialRef is one row in the unified left-panel materials list, aggregating
// markdown materials plus the workspace's quizzes and flashcardSets. ChapterID lets the
// tree group refs under their chapter (null = unfiled).
type MaterialRef struct {
	ID        string          `json:"id"`
	Type      MaterialRefType `json:"type"`
	Title     string          `json:"title"`
	ChapterID *string         `json:"chapterId"`
	Position  int64           `json:"position"`
	CreatedAt time.Time       `json:"createdAt"`
	// SizeBytes lets the client decide how to open a document before paying to
	// fetch it. Maintained by the materials trigger as octet_length(content).
	SizeBytes int64 `json:"sizeBytes"`
	NodeCount int   `json:"nodeCount"`
	MaxDepth  int   `json:"maxDepth"`
	// Provenance credits the library books a curated material was written from.
	Provenance *Provenance `json:"provenance,omitempty"`
}

type ContentOrderItem struct {
	ID   string
	Type string // file | material
}

type Label struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Color UserColor `json:"color"`
}

type Event struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Start    time.Time `json:"start"`
	End      time.Time `json:"end"`
	LabelIDs []string  `json:"labelIds" nullable:"false"`
	Location *string   `json:"location,omitempty"`
	Note     *string   `json:"note,omitempty"`
}

type Task struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	Meta    *string   `json:"meta,omitempty"`
	Done    bool      `json:"done"`
	DueDate time.Time `json:"dueDate"`
}

type Notification struct {
	ID     string           `json:"id"`
	Kind   NotificationKind `json:"kind"`
	Data   json.RawMessage  `json:"data"`
	At     time.Time        `json:"at"`
	ReadAt *time.Time       `json:"readAt,omitempty"`
	Href   string           `json:"href,omitempty"`
	// Joined at read time for the row's icon: the workspace it is about and,
	// for an accepted invite, the member who joined. The list fills them; the
	// stream's created events do not, so the browser refetches the list.
	WorkspaceName   string `json:"workspaceName,omitempty"`
	WorkspaceIconID string `json:"workspaceIconId,omitempty"`
	MemberAvatarURL string `json:"memberAvatarUrl,omitempty"`
	// These fields are used internally when publishing cache events and are not
	// part of the public notification response.
	UserID            string `json:"-"`
	WorkspaceID       string `json:"-"`
	WorkspaceInviteID string `json:"-"`
}

type NotificationPrefs struct {
	EmailWorkspaceInvite bool `json:"emailWorkspaceInvite"`
	EmailBilling         bool `json:"emailBilling"`
}

type SearchResult struct {
	ID       string     `json:"id"`
	Kind     SearchKind `json:"kind"`
	FileKind FileKind   `json:"fileKind,omitempty"`
	IconID   string     `json:"iconId,omitempty"`
	Title    string     `json:"title"`
	Subtitle string     `json:"subtitle,omitempty"`
	Href     string     `json:"href"`
	// ThumbnailKey is a file's page-1 WebP; the handler signs it into
	// ThumbnailURL.
	ThumbnailKey string  `json:"-"`
	ThumbnailURL *string `json:"thumbnailUrl,omitempty" doc:"Hour-stable presigned GET of a file's page-1 thumbnail"`
	// Preview is a flashcard set's list-card preview, or {text} for a text file.
	Preview MaterialPreview `json:"preview,omitempty" doc:"A flashcard set's list-card preview, or {text} for a text file; see openwiki/thumbnails.md"`
}

type PublicWorkspace struct {
	Workspace
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

// PublicQuiz is a quiz on Explore, read from its stored preview.
type PublicQuiz struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	WorkspaceID string `json:"workspaceId"`
	// QuestionCount is the stored preview's; absent while the quiz has none.
	QuestionCount *int   `json:"questionCount,omitempty"`
	Author        string `json:"author"`
	Clones        int    `json:"clones"`
	// CanClone: the caller may copy it (CanCloneFrom; a standalone item, anyone).
	CanClone bool `json:"canClone"`
}

type PublicFlashcardSet struct {
	FlashcardSet
	Author   string `json:"author"`
	Clones   int    `json:"clones"`
	CanClone bool   `json:"canClone"` // as PublicQuiz.CanClone
}

// FileChange is one source file in the Indexing tab's file changes list.
// waiting: saved edits not yet requested; queued: requested and not started,
// so still cancellable; processing: started; failed: the last attempt failed
// or was refused, and automatic processing skips it until the next save.
type FileChange struct {
	FileID       string    `json:"fileId"`
	Name         string    `json:"name"`
	Kind         FileKind  `json:"kind"`
	State        string    `json:"state" enum:"waiting,queued,processing,failed"`
	LastEditedAt time.Time `json:"lastEditedAt"`
	// ErrorID is a failed row's error id: the trace id of its failed attempt
	// (migration 0105), so a reported failure can be traced; the failure's
	// text stays hidden. Absent on other rows and when none was recorded.
	ErrorID string `json:"errorId,omitempty"`
}

// NoteChange is one workspace note in the same list: its content is ahead of
// its index. waiting: dirty, indexed automatically at its threshold while auto
// process is on; queued and processing: its index job; failed: parked after
// its failed jobs until its next edit or the owner's Process.
type NoteChange struct {
	MaterialID   string    `json:"materialId"`
	Title        string    `json:"title"`
	State        string    `json:"state" enum:"waiting,queued,processing,failed"`
	LastEditedAt time.Time `json:"lastEditedAt"`
	ErrorID      string    `json:"errorId,omitempty"` // as FileChange.ErrorID
}

type WorkspaceStats struct {
	Indexed      int `json:"indexed"`
	NotIndexed   int `json:"notIndexed"`
	NotIndexable int `json:"notIndexable"`
	// FileChanges lists source files with unprocessed saved edits, oldest
	// edit first, including ones queued or processing.
	FileChanges []FileChange `json:"fileChanges" nullable:"false"`
	// NoteChanges lists workspace notes whose index is behind their content,
	// work in flight first, then oldest edit, at most the owner's files per
	// workspace; MoreNoteChanges counts the notes past that cap.
	NoteChanges     []NoteChange `json:"noteChanges" nullable:"false"`
	MoreNoteChanges int          `json:"moreNoteChanges"`
	Chapters        int          `json:"chapters"`
	Files           int          `json:"files"`
	Quizzes         int          `json:"quizzes"`
	Attempts        int          `json:"attempts"`
	AvgScore        int          `json:"avgScore"`
}
