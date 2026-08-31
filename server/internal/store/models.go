package store

import (
	"encoding/json"
	"reflect"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/models"
)

// JSON tags match src/api/types.ts exactly so responses are drop-in for the
// existing frontend (camelCase, nullable fields as pointers).

type User struct {
	ID                 string             `json:"id"`
	Name               string             `json:"name"`
	Email              string             `json:"email"`
	AvatarURL          string             `json:"avatarUrl,omitempty"`
	ClassLabel         string             `json:"classLabel,omitempty"`
	Streak             int                `json:"streak"`
	Locale             string             `json:"locale"`
	ChatModel          models.Ref         `json:"chatModel"`
	GenerateModel      models.Ref         `json:"generateModel"`
	EditorModel        models.Ref         `json:"editorModel"`
	QuizModel          models.Ref         `json:"quizModel"`
	PlanTier           PlanTier           `json:"planTier"`
	SubscriptionStatus SubscriptionStatus `json:"subscriptionStatus"`
}

type Workspace struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     UserColor `json:"color"`
	Privacy   Privacy   `json:"privacy"`
	ShareRole ShareRole `json:"shareRole"`
	Tags      []Tag     `json:"tags"`
	// OwnerUserID is the account every byte in this workspace is charged to.
	// It is the account whose quota governs whether members may add content,
	// so it is not interchangeable with the requester.
	OwnerUserID string `json:"ownerUserId"`
	// OwnerPlanTier is loaded only to resolve this process's startup plan
	// snapshot. It is not exposed as workspace API data.
	OwnerPlanTier PlanTier `json:"-"`
	// OwnerName is that account's display name, so a member can be told whose
	// limit is blocking them rather than a nameless "the owner".
	OwnerName      string    `json:"ownerName"`
	ChapterCount   int       `json:"chapterCount"`
	FileCount      int       `json:"fileCount"`
	FilesLimit     int       `json:"filesLimit"`
	CreatedAt      time.Time `json:"createdAt"`
	LastAccessedAt time.Time `json:"lastAccessedAt"`
}

// AccessCapabilities is request-scoped authorization metadata. It is never
// persisted and must be derived from the requester's workspace role.
type AccessCapabilities struct {
	CanView          bool `json:"canView"`
	CanEdit          bool `json:"canEdit"`
	CanComment       bool `json:"canComment"`
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
	Indexed bool    `json:"indexed"`
	URL     *string `json:"url,omitempty"`
	// PreviewURL renders the exact paginated bytes used for citation regions.
	// It is absent until ingest has finished.
	PreviewURL *string `json:"previewUrl,omitempty"`
	Content    *string `json:"content,omitempty"`
	Revision   int64   `json:"revision"`
}

type Quiz struct {
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
}

type Attempt struct {
	ID string `json:"id"`
	// MaterialID is null for the virtual "review mistakes" quiz, and becomes
	// null when the source quiz is deleted. QuizName and WorkspaceName are the
	// submit-time snapshot that keeps the row readable either way.
	MaterialID    *string   `json:"materialId"`
	QuizName      string    `json:"quizName"`
	WorkspaceName string    `json:"workspaceName"`
	Chapters      []string  `json:"chapters" nullable:"false"`
	Correct       float64   `json:"correct"`
	Total         float64   `json:"total"`
	Pct           int       `json:"pct"`
	TakenAt       time.Time `json:"takenAt"`
}

// AttemptDetail carries the per-question payload for a single attempt's result
// breakdown. Answers is a map keyed by question id; Questions is the snapshot
// taken at submit time. Both stay opaque JSON (the frontend owns the shapes).
type AttemptDetail struct {
	Attempt
	Answers   json.RawMessage
	Questions json.RawMessage
}

type Deck struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	WorkspaceID   string    `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	Color         UserColor `json:"color"`
	Privacy       Privacy   `json:"privacy"`
	CardCount     int       `json:"cardCount"`
	KnownPct      int       `json:"knownPct"`
	DueCount      int       `json:"dueCount"`
	// IsOwner is request-scoped: true when the requester owns the parent
	// workspace (false for link/public shared reads).
	IsOwner bool `json:"isOwner"`
}

// Srs is the FSRS scheduling state persisted as jsonb; the shape mirrors
// SrsState in src/api/types.ts (the frontend owns the algorithm).
type Flashcard struct {
	ID     string   `json:"id"`
	DeckID string   `json:"deckId"`
	Front  string   `json:"front"`
	Back   string   `json:"back"`
	Known  bool     `json:"known"`
	Srs    SrsState `json:"srs"`
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
	Color          UserColor `json:"color,omitempty"` // decks only; presentation tint
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	Revision       int64     `json:"revision"`
	SizeBytes      int64     `json:"-"`
	NodeCount      int       `json:"-"`
	MaxDepth       int       `json:"-"`
	// IsOwner is request-scoped (not persisted): true when the requester owns
	// the parent workspace, false for link/public shared reads.
	IsOwner      bool               `json:"isOwner"`
	Role         *WorkspaceRole     `json:"role,omitempty"`
	Capabilities AccessCapabilities `json:"capabilities"`
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

type MaterialRevision struct {
	MaterialID     string                `json:"materialId"`
	Revision       int64                 `json:"revision"`
	ParentRevision *int64                `json:"parentRevision,omitempty"`
	EventType      MaterialRevisionEvent `json:"eventType"`
	Title          string                `json:"title"`
	Content        string                `json:"-"`
	EventMetadata  json.RawMessage       `json:"-"`
	CreatedBy      *string               `json:"createdBy,omitempty"`
	CreatedAt      time.Time             `json:"createdAt"`
}

type WorkspaceMember struct {
	WorkspaceID string        `json:"workspaceId"`
	UserID      string        `json:"userId"`
	Name        string        `json:"name"`
	Email       string        `json:"email"`
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
	IsResolved      bool      `json:"isResolved"`
	IsDeleted       bool      `json:"isDeleted"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	Comments        []Comment `json:"comments" nullable:"false"`
}

type Comment struct {
	ID              string          `json:"id"`
	DiscussionID    string          `json:"discussionId"`
	ParentCommentID *string         `json:"parentCommentId,omitempty"`
	UserID          string          `json:"userId"`
	AuthorName      string          `json:"authorName"`
	AuthorAvatarURL string          `json:"authorAvatarUrl,omitempty"`
	ContentRich     json.RawMessage `json:"contentRich"`
	IsEdited        bool            `json:"isEdited"`
	IsDeleted       bool            `json:"isDeleted"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	Replies         []Comment       `json:"replies" nullable:"false"`
}

// MaterialRef is one row in the unified left-panel materials list, aggregating
// markdown materials plus the workspace's quizzes and decks. ChapterID lets the
// tree group refs under their chapter (null = unfiled).
type MaterialRef struct {
	ID        string          `json:"id"`
	Type      MaterialRefType `json:"type"`
	Title     string          `json:"title"`
	ChapterID *string         `json:"chapterId"`
	Position  int64           `json:"position"`
	CreatedAt time.Time       `json:"createdAt"`
	// Revision is required when renaming from the list so title updates can
	// satisfy the material expectedRevision precondition.
	Revision int64 `json:"revision"`
	// SizeBytes lets the client decide how to open a document before paying to
	// fetch it. Maintained by the materials trigger as octet_length(content).
	SizeBytes int64 `json:"sizeBytes"`
	NodeCount int   `json:"nodeCount"`
	MaxDepth  int   `json:"maxDepth"`
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
	// These fields are used internally when publishing cache events and are not
	// part of the public notification response.
	UserID            string `json:"-"`
	WorkspaceID       string `json:"-"`
	WorkspaceInviteID string `json:"-"`
}

type NotificationPrefs struct {
	EmailWorkspaceInvite bool `json:"emailWorkspaceInvite"`
	EmailMembership      bool `json:"emailMembership"`
	EmailBilling         bool `json:"emailBilling"`
}

type Canvas struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	UpdatedAt time.Time       `json:"updatedAt"`
	Scene     json.RawMessage `json:"scene,omitempty"`
}

type SearchResult struct {
	ID       string     `json:"id"`
	Kind     SearchKind `json:"kind"`
	Title    string     `json:"title"`
	Subtitle string     `json:"subtitle,omitempty"`
	Href     string     `json:"href"`
}

type PublicWorkspace struct {
	Workspace
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

type PublicQuiz struct {
	Quiz
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

type PublicDeck struct {
	Deck
	Author string `json:"author"`
	Clones int    `json:"clones"`
}

type WorkspaceStats struct {
	Chapters int `json:"chapters"`
	Files    int `json:"files"`
	Quizzes  int `json:"quizzes"`
	Attempts int `json:"attempts"`
	AvgScore int `json:"avgScore"`
}
