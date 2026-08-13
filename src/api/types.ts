/* ============================================================
   Domain types — the single import surface for the mock API, query
   hooks, and UI.

   These are now backed by the orval-generated wire contracts in
   `src/api/gen/model` (reflected from the backend's OpenAPI spec). We
   re-export the generated types directly where they match 1:1, and layer
   thin overrides only where the UI needs a richer shape than the wire can
   express:
     - `questions` stays the discriminated `Question` union (opaque
       `{ [k]: unknown }` on the wire — the frontend owns the polymorphism).
     - a couple of client-only fields (e.g. `SourceFile.ingestPct`).

   Array fields (tags, chapters, fileIds, labelIds, questions) are
   non-nullable on the wire: the backend pins them with `nullable:"false"`
   and always emits `[]`, so no null narrowing is needed here.

   Everything else — enums, scalar shapes — comes straight from generated
   code, so it stays in lockstep with the backend.
   ============================================================ */

import type {
  AttemptDetail as GenAttemptDetail,
  Comment as GenComment,
  CreateAttemptReq as GenCreateAttemptReq,
  CreateCardReq as GenCreateCardReq,
  CreateCommentReq as GenCreateCommentReq,
  CreateDiscussionReq as GenCreateDiscussionReq,
  CreateMaterialReq as GenCreateMaterialReq,
  CreateQuizReq as GenCreateQuizReq,
  CreateWorkspaceInviteReq as GenCreateWorkspaceInviteReq,
  Discussion as GenDiscussion,
  File as GenFile,
  Material as GenMaterial,
  MaterialRevision as GenMaterialRevision,
  PublicQuiz as GenPublicQuiz,
  Quiz as GenQuiz,
  SearchResult as GenSearchResult,
  UpdateCommentReq as GenUpdateCommentReq,
  UpdateQuizReq as GenUpdateQuizReq,
  UpdateWorkspaceMemberReq as GenUpdateWorkspaceMemberReq,
  MaterialKind,
  UserColor,
  WorkspaceRole,
} from './gen/model';

/* ---------------- pass-through wire contracts ----------------
   Entities, mutation payloads, and the purpose-built bodies of endpoints that
   answer with something other than an entity, so hooks and the forms feeding
   them bind to the wire contract instead of restating it. Contracts whose UI
   shape is richer than the wire (rich text, the Question union,
   non-transferable roles) are overridden further down. */
export type {
  AccessCapabilities,
  AccountStatus,
  AddChapterReq,
  Attempt,
  BillingCheckoutReq,
  BillingInfo,
  Canvas as ThinkingCanvas,
  Chapter,
  CloneWorkspaceResp as CloneWorkspaceResult,
  CollaborationTokenResponse as MaterialCollaborationToken,
  ContentOrderItem,
  CreateCanvasReq,
  CreateConversationReq,
  CreateDeckReq,
  CreateEventReq,
  CreateWorkspaceReq,
  Deck,
  DeletionPreflight,
  Event as CalendarEvent,
  Flashcard,
  IntegrationsStatus,
  Label,
  LocaleInputBody,
  MaterialRef,
  MaterialUpdateResult,
  Notification as AppNotification,
  NotificationCountOutputBody as NotificationCount,
  NotificationPage,
  NotificationPrefs,
  PublicDeck,
  PublicWorkspace,
  RecentFile,
  ReorderChaptersReq,
  ReorderContentReq,
  RequestAccountDeletionReq,
  SaveCanvasReq,
  SourceUploadPolicy,
  SrsState,
  SubscriptionBlocker,
  Tag,
  TagInput,
  Task,
  TransferWorkspaceReq,
  UpdateCardReq,
  UpdateChapterReq,
  UpdateDeckReq,
  UpdateDiscussionReq,
  UpdateEventReq,
  UpdateFileReq,
  UpdateLabelReq,
  UpdateMaterialReq,
  UpdateTaskReq,
  UpdateWorkspaceReq,
  UpdateWorkspaceSharingReq,
  URLResp,
  User,
  Workspace,
  WorkspaceCollaborator,
  WorkspaceMember,
  WorkspaceStats,
} from './gen/model';

/* ---------------- enums & scalars (straight from the generated spec) ---------------- */
export {
  AccountState,
  FileKind,
  FileStatus,
  MaterialKind,
  MaterialRefType,
  MaterialRevisionEvent,
  NotificationKind,
  PlanTier,
  Privacy,
  SearchKind,
  ShareRole,
  SubscriptionStatus,
  UserColor,
  WorkspaceRole,
} from './gen/model';

/* ---------------- UI-only color extras (not on the wire) ---------------- */
export type SystemColor =
  | 'success'
  | 'info'
  | 'warning'
  | 'error'
  | 'accent-1'
  | 'accent-2';

/* ---------------- overridden contracts ----------------
   Same generated shape, minus the wire's opaque / client-only fields. */

/** A past attempt with its per-question breakdown. `questions` is the rich
 * union (opaque on the wire); `answers` maps question id -> the user's answer
 * (the `Answer` union from grade.ts, kept loose here to avoid an import cycle). */
export type AttemptDetail = Omit<GenAttemptDetail, 'questions'> & {
  questions: Question[];
};

/** `ingestPct` is transient upload progress, never persisted. */
export type SourceFile = GenFile & { ingestPct?: number };

/** `color` is a client-side tint derived from the owning workspace/label/deck. */
export type SearchResult = GenSearchResult & { color?: UserColor };

/** `questions` is the rich discriminated union; the wire keeps it opaque. */
export type Quiz = Omit<GenQuiz, 'questions'> & { questions: Question[] };
export type PublicQuiz = Omit<GenPublicQuiz, 'questions'> & {
  questions: Question[];
};

/* ---------------- overridden request bodies ----------------
   Same wire contract with the UI-facing shape restored: the Question union,
   Plate values, and roles that cannot be granted through a normal write. */
export type CreateQuizReq = Omit<GenCreateQuizReq, 'questions'> & {
  questions?: Question[];
};
export type UpdateQuizReq = Omit<GenUpdateQuizReq, 'questions'> & {
  questions?: Question[];
};
export type CreateAttemptReq = Omit<
  GenCreateAttemptReq,
  'questions' | 'wrong'
> & {
  questions?: Question[];
  wrong?: Question[];
};

/** Both faces are optional on the wire; nothing in the UI creates a blank card. */
export type CreateCardReq = Required<Pick<GenCreateCardReq, 'back' | 'front'>>;

export type CreateMaterialReq = Omit<GenCreateMaterialReq, 'content'> & {
  content?: import('@/features/materials/document').MaterialDocument;
};
export type CreateDiscussionReq = Omit<
  GenCreateDiscussionReq,
  'contentRich'
> & {
  contentRich: import('@/features/materials/document').MaterialValue;
};
export type CreateCommentReq = Omit<GenCreateCommentReq, 'contentRich'> & {
  contentRich: import('@/features/materials/document').MaterialValue;
};
export type UpdateCommentReq = Omit<GenUpdateCommentReq, 'contentRich'> & {
  contentRich: import('@/features/materials/document').MaterialValue;
};

/** Ownership moves through the transfer endpoint, never through an invite or a
 * role change, so those bodies exclude it. */
export type AssignableRole = Exclude<WorkspaceRole, 'owner'>;
export type CreateWorkspaceInviteReq = Omit<
  GenCreateWorkspaceInviteReq,
  'role'
> & { role: AssignableRole };
export type UpdateWorkspaceMemberReq = Omit<
  GenUpdateWorkspaceMemberReq,
  'role'
> & { role: AssignableRole };

/* ---------------- chat ----------------
   Conversation + Message + Citation are modelled on the wire (huma) and come
   from the generated spec. ChatMessage is the UI-facing turn: the generated
   Message shape with role/status narrowed to unions and an optional client-only
   `pending` flag while a temp (pre-persisted) row streams. */
export type {
  Citation,
  Conversation,
  Message as WireMessage,
} from './gen/model';

export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatStatus = 'streaming' | 'complete' | 'aborted' | 'error';

export interface ChatMessage {
  citations?: import('./gen/model').Citation[];
  content: string;
  conversationId?: string;
  createdAt?: string;
  id: string;
  role: ChatRole;
  status: ChatStatus;
}

/* ---------------- Quizzes: the polymorphic Question union ----------------
   The backend stores questions opaquely; the frontend owns this shape. */
export type QuestionType =
  | 'mcq' // single correct
  | 'multi' // multiple correct
  | 'boolean'
  | 'fill' // fill in the blank
  | 'short' // short answer
  | 'matching'
  | 'ordering';

/**
 * Cognitive level of a question (a light Depth-of-Knowledge style tag). Replaces
 * the old easy/medium/hard difficulty so students see *what kind* of thinking a
 * question demands. Ordered from lowest to highest cognitive load.
 */
export type CognitiveLevel = 'recall' | 'application' | 'analysis';

interface BaseQuestion {
  explanation?: string;
  id: string;
  level: CognitiveLevel;
  prompt: string;
  type: QuestionType;
}
export interface ChoiceQuestion extends BaseQuestion {
  /** indices into `options` */
  correct: number[];
  /** Object-wrapped so react-hook-form useFieldArray can bind each row. Each
   * option can carry its own explanation (why it is right or wrong), surfaced
   * during review. Question-level `explanation` still applies to non-choice
   * types. */
  options: { value: string; explanation?: string }[];
  type: 'mcq' | 'multi';
}
export interface BooleanQuestion extends BaseQuestion {
  correct: boolean;
  type: 'boolean';
}
export interface TextQuestion extends BaseQuestion {
  /** accepted answers (case-insensitive), object-wrapped for useFieldArray */
  accepted: { value: string }[];
  type: 'fill' | 'short';
}
export interface MatchingQuestion extends BaseQuestion {
  pairs: { left: string; right: string }[];
  type: 'matching';
}
export interface OrderingQuestion extends BaseQuestion {
  /** items in their correct order, object-wrapped for useFieldArray */
  items: { value: string }[];
  type: 'ordering';
}
export type Question =
  | ChoiceQuestion
  | BooleanQuestion
  | TextQuestion
  | MatchingQuestion
  | OrderingQuestion;

/* ---------------- Generate (request options, not wire response types) ----------------
   Every generation is scoped: `chapters` (ids) and/or `fileIds` narrow the
   source material. The backend resolves chapter ids to their member files (for
   retrieval) and to names (for display + the LLM scope hint). Empty scope means
   the whole workspace. */
export type GenerateKind = Exclude<MaterialKind, 'note'>;

export interface GenerateScope {
  chapters: string[]; // chapter ids
  fileIds: string[]; // file ids
  title: string;
}
export interface GenerateFlashcardsOptions extends GenerateScope {
  count: number;
  kind: 'flashcards';
  style: 'term-def' | 'qa' | 'cloze';
}
export interface GenerateQuizOptions extends GenerateScope {
  count: number;
  kind: 'quiz';
  levels: CognitiveLevel[];
  timeLimitMin?: number;
  types: QuestionType[];
}
export type DiagramType =
  | 'auto'
  | 'flowchart'
  | 'sequence'
  | 'class'
  | 'state'
  | 'er';
export interface GenerateMindmapOptions extends GenerateScope {
  detail: 'brief' | 'standard' | 'detailed';
  kind: 'mindmap';
}
export interface GenerateDiagramOptions extends GenerateScope {
  diagramType: DiagramType;
  kind: 'diagram';
}
export type GenerateOptions =
  | GenerateFlashcardsOptions
  | GenerateQuizOptions
  | GenerateMindmapOptions
  | GenerateDiagramOptions;

/* ---------------- Study materials ----------------
   Persisted, workspace-scoped (not chapter-scoped) study artifacts rendered
   in-pane. Mindmaps and diagrams are markdown documents (mermaid fences);
   quizzes and decks are referenced by the unified materials index. */
/** `content` is the rich Plate document; the wire keeps its nodes opaque. */
export type Material = Omit<GenMaterial, 'content'> & {
  content: import('@/features/materials/document').MaterialDocument;
};

/* ---------------- Plate collaboration ---------------- */
export type MaterialComment = Omit<GenComment, 'contentRich' | 'replies'> & {
  contentRich: import('@/features/materials/document').MaterialValue | null;
  replies: MaterialComment[];
};

export type MaterialDiscussion = Omit<GenDiscussion, 'comments'> & {
  comments: MaterialComment[];
};

export type MaterialRevision = Omit<GenMaterialRevision, 'content'> & {
  content: import('@/features/materials/document').MaterialDocument;
};

/* ---------------- Raw generated namespace ----------------
   Reach for `Gen` when you need the exact backend contract (e.g. nullable
   arrays, request bodies) rather than the UI-facing domain type above. */
export * as Gen from './gen/model';
