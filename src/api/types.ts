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
  ActivityBlockOutcome,
  ActivityCapture,
  FileKind,
  AnonymousQuiz as GenAnonymousQuiz,
  AttemptDetail as GenAttemptDetail,
  Citation as GenCitation,
  Comment as GenComment,
  CreateCommentReq as GenCreateCommentReq,
  CreateDiscussionReq as GenCreateDiscussionReq,
  CreateEmbeddedMaterialReq as GenCreateEmbeddedMaterialReq,
  CreateMaterialReq as GenCreateMaterialReq,
  CreateQuizReq as GenCreateQuizReq,
  CreateWorkspaceInviteReq as GenCreateWorkspaceInviteReq,
  Discussion as GenDiscussion,
  UserModelSlot as GeneratedModelSlot,
  File as GenFile,
  GradedQuestion as GenGradedQuestion,
  GradedQuiz as GenGradedQuiz,
  Material as GenMaterial,
  Message as GenMessage,
  PublicQuiz as GenPublicQuiz,
  Quiz as GenQuiz,
  ResourceEffectOperation as GenResourceEffectOperation,
  ReviewItem as GenReviewItem,
  ReviewSession as GenReviewSession,
  SearchResult as GenSearchResult,
  StudySummary as GenStudySummary,
  UpdateCommentReq as GenUpdateCommentReq,
  UpdateQuizContentReq as GenUpdateQuizContentReq,
  UpdateWorkspaceMemberReq as GenUpdateWorkspaceMemberReq,
  MaterialKind,
  ResourceEffect,
  ToolError,
  UndoRefStatus,
  UserColor,
  WorkspaceRole,
} from './gen/model';

/* ---------------- pass-through wire contracts ----------------
   Entities, mutation payloads, and the purpose-built bodies of endpoints that
   answer with something other than an entity, so hooks and the forms feeding
   them bind to the wire contract instead of restating it. Contracts whose UI
   shape is richer than the wire (rich text, the Question union,
   non-transferable roles) are overridden further down. */
/** The slots a user may pick a model for. Ingest, retrieval, captioning and
 * rerank are operator-only: they are chosen from the registry and never stored per
 * user, so they are absent from the query enum the server accepts. Quiz is
 * user-selectable and includes in-tab `browser:` keys that never live in
 * model_configs. */
export type ModelSlot = GeneratedModelSlot;
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
  CreateEventReq,
  CreateFlashcardSetReq,
  CreateWorkspaceReq,
  DeletionPreflight,
  Event as CalendarEvent,
  FileChange,
  Flashcard,
  FlashcardSet,
  ImportSourcesAccepted as SourceImportAcceptedResponse,
  InspectedSourceImport,
  InspectSourceImportRejected,
  InspectSourceImportsReq,
  InspectSourceImportsResponse,
  IntegrationsStatus,
  Invoice,
  InvoiceList,
  Label,
  LLMCredential,
  LLMCredentialProvider,
  LLMCredentialsResponse,
  LocaleInputBody,
  MaterialRef,
  MaterialUpdateResult,
  MicrosoftDriveHost,
  ModelOption,
  ModelsResponse,
  ModelThinking,
  Notification as AppNotification,
  NotificationCountOutputBody as NotificationCount,
  NotificationPage,
  NotificationPrefs,
  PublicFlashcardSet,
  PublicWorkspace,
  Ref as ModelRef,
  Region,
  ReorderChaptersReq,
  ReorderContentReq,
  ReportEditIncidentReq,
  RequestAccountDeletionReq,
  RetryProcessingInputBody as RetryProcessingReq,
  SaveCanvasReq,
  SetModelPrefsReq,
  SourceImportStatus,
  SourceUploadPolicy,
  StudyPreferences,
  SubscriptionBlocker,
  Tag,
  TagInput,
  Task,
  TransferWorkspaceReq,
  UpdateChapterReq,
  UpdateEventReq,
  UpdateFileReq,
  UpdateFlashcardSetReq,
  UpdateLabelReq,
  UpdateMaterialReq,
  UpdateMeReq,
  UpdateQuizMetadataReq,
  UpdateStandaloneSharingReq,
  UpdateTaskReq,
  UpdateWorkspaceReq,
  UpdateWorkspaceSharingReq,
  UpsertLLMCredentialReq,
  URLResp,
  UsageEventPage,
  UsageReport,
  User,
  Workspace,
  WorkspaceCollaborator,
  WorkspaceMember,
  WorkspaceStats,
} from './gen/model';
/* ---------------- enums & scalars (straight from the generated spec) ---------------- */
export {
  AccountState,
  FileStatus,
  MaterialKind,
  MaterialRefType,
  NotificationKind,
  PlanTier,
  Privacy,
  SearchKind,
  ShareRole,
  Slot,
  StorageUsageLevel,
  SubscriptionStatus,
  UserColor,
  WorkspaceRole,
} from './gen/model';

export interface IngestSlots {
  slotsFree: number;
  slotsLimit: number;
  slotsUsed: number;
}

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

/** An attempt as the server graded it, also POST /quizzes/{id}/attempts'
 * response: `questions` carry their keys and, on each part, `awarded`, plus
 * `itemAwards` (open) or `itemResults` (matching, gaps); `answers` maps part
 * id -> the user's answer (the `Answer` union from grade.ts, kept loose here
 * to avoid an import cycle). */
export type AttemptDetail = Omit<GenAttemptDetail, 'questions'> & {
  questions: Question[];
};
/** A signed-out attempt graded by POST /public/quizzes/{token}/grade, keyed
 * and awarded like AttemptDetail; nothing is stored server-side. */
export type GradedQuiz = Omit<GenGradedQuiz, 'questions'> & {
  questions: Question[];
};
/** One question checked by POST /review/check or /bank/questions/{id}/check,
 * with its key and awards. */
export type GradedQuestion = Omit<GenGradedQuestion, 'question'> & {
  question: Question;
};

/** `ingestPct` is transient upload progress, never persisted. */
export type SourceFile = GenFile & { ingestPct?: number };
/** A file the viewer has resolved through GET /files/{id}/links: `url` is a
 * short-lived presigned read, the only URL the browser ever holds for file
 * bytes; `previewUrl` is a presence marker for PDF sources. */
export type ViewableFile = SourceFile & { url: string };

/** `color` is a client-side tint derived from the owning workspace/label/flashcardSet. */
export type SearchResult = GenSearchResult & { color?: UserColor };

/** GET /quizzes/{id}: the quiz to view or take, answer-free (the wire keeps
 * questions opaque). */
export type Quiz = Omit<GenQuiz, 'questions'> & {
  questions: LearnerQuestion[];
};
/** GET /quizzes/{id}/edit, for whoever may edit, and the responses of the
 * create, content, metadata, sharing and clone routes: with keys. */
export type EditableQuiz = Omit<GenQuiz, 'questions'> & {
  questions: Question[];
};
/** A shared standalone quiz as signed-out visitors read it, answer-free. */
export type AnonymousQuiz = Omit<GenAnonymousQuiz, 'questions'> & {
  questions: LearnerQuestion[];
};
export type {
  AnonymousFlashcards,
  AnonymousNote,
  CheckBankQuestionReq,
  CheckReviewItemReq,
  ComputationCheckResp,
  GradeAnonymousQuizReq,
} from './gen/model';
/** An Explore quiz, answer-free. */
export type PublicQuiz = Omit<GenPublicQuiz, 'questions'> & {
  questions: LearnerQuestion[];
};

/** A card or question in a review session; questions are answer-free and
 * checked through POST /review/check. */
export type ReviewItem = Omit<GenReviewItem, 'question'> & {
  question?: LearnerQuestion;
};
export type ReviewSession = Omit<GenReviewSession, 'items'> & {
  items: ReviewItem[];
};
/** The Study tab's summary; Quick review items are cards, never questions. */
export type StudySummary = Omit<GenStudySummary, 'quickReview'> & {
  quickReview: ReviewItem[];
};
export type {
  BankCopyInputBody as BankCopyReq,
  BankCopyOutputBody as BankCopyResult,
  BankMarksOutputBody as BankTopicMarks,
  BankProgressOutputBody as BankProgress,
  RateReviewItemReq,
  ReviewWorkspace,
  Row as BankListRow,
  SetStudyEnabledReq,
  SetStudyItemReq,
  StudyItem,
  TopicProgress as BankTopicProgress,
} from './gen/model';

/* ---------------- overridden request bodies ----------------
   Same wire contract with the UI-facing shape restored: the Question union,
   Plate values, and roles that cannot be granted through a normal write. */
export type CreateQuizReq = Omit<GenCreateQuizReq, 'questions'> & {
  questions?: Question[];
};
export type UpdateQuizContentReq = Omit<
  GenUpdateQuizContentReq,
  'questions'
> & {
  questions?: Question[];
};
export type { CreateAttemptReq } from './gen/model';

export type CreateMaterialReq = Omit<GenCreateMaterialReq, 'content'> & {
  content?: import('@/features/materials/document').MaterialDocument;
};
/** A quiz or flashcard set authored inside a note; the wire keeps questions opaque. */
export type CreateEmbeddedMaterialReq = Omit<
  GenCreateEmbeddedMaterialReq,
  'questions'
> & { questions?: Question[] };
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
export type { Conversation, FileLinks } from './gen/model';

/** `n` is the passage number the answer program cites; its index in the
 * message's citation list is the number the reader sees. */
export type Citation = GenCitation & { chunkId?: string; n?: number };

/* Shared agent-tool result contract (server/internal/agenttools). A tool block
   without an outcome is still running in the browser; the outcome, safe error
   and durable resource effects arrive on tool_end and are what history stores. */
/* Trash: owner-only bin for source files and materials. */
export type {
  AgentOperation as OperationReceipt,
  ResourceEffect,
  ResourceRef,
  ToolError,
  TrashActionReq,
  TrashItem,
  TrashPage,
  UndoEditReq,
  UndoRef,
} from './gen/model';
export type ToolOutcome = ActivityBlockOutcome;
export type ResourceEffectOperation = GenResourceEffectOperation;
export type UndoStatus = UndoRefStatus;

export type ActivityBlock =
  | { id: string; kind: 'narration'; text: string }
  | {
      callId: string;
      capture?: ActivityCapture;
      detail?: string;
      effects?: ResourceEffect[];
      error?: ToolError;
      id: string;
      kind: 'tool';
      name: string;
      outcome?: ToolOutcome;
    };

export type WireMessage = Omit<GenMessage, 'citations'> & {
  activity?: ActivityBlock[];
  citations?: Citation[] | null;
};

export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatStatus = 'streaming' | 'complete' | 'aborted' | 'error';
export type ChatPhase = 'planning' | 'running_tools' | 'answering';

export interface ChatMessage {
  activity?: ActivityBlock[];
  citations?: Citation[];
  content: string;
  conversationId?: string;
  createdAt?: string;
  currentBlockId?: string;
  currentBlockText?: string;
  error?: string;
  id: string;
  modelDisplayName?: string;
  modelSlug?: string;
  modelVersion?: number;
  phase?: ChatPhase;
  providerSlug?: string;
  role: ChatRole;
  status: ChatStatus;
}

export type {
  CognitiveLevel,
  LearnerQuestion,
  Question,
  QuestionAnswer,
  QuestionBlock,
  QuestionPart,
  QuestionType,
} from '@/features/questions/types';
/* Shared authored question contract. The wire stores it as opaque JSON. */
export { QUESTION_TYPES } from '@/features/questions/types';

import type {
  CognitiveLevel,
  LearnerQuestion,
  Question,
  QuestionType,
} from '@/features/questions/types';

/* ---------------- Generate (request options, not wire response types) ----------------
   Every generation is scoped: `chapters` (ids) and/or `fileIds` narrow the
   source material. The backend resolves chapter ids to their member files (for
   retrieval) and to names (for display + the LLM scope hint). Empty scope means
   the whole workspace. */
export type GenerateKind = Exclude<MaterialKind, 'note'>;

export interface GenerateScope {
  chapters: string[]; // chapter ids
  /** Omitted, the server takes the user's study preference for the kind. */
  count?: number;
  fileIds: string[]; // file ids
  levels?: CognitiveLevel[];
  title: string;
}
export interface GenerateFlashcardsOptions extends GenerateScope {
  kind: 'flashcards';
}
export interface GenerateQuizOptions extends GenerateScope {
  kind: 'quiz';
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
   quizzes and flashcardSets are referenced by the unified materials index. */
/** `content` is the rich Plate document; the wire keeps its nodes opaque. */
export type Material = Omit<GenMaterial, 'content'> & {
  content: import('@/features/materials/document').MaterialDocument;
};

/* Owner-scoped, paginated listings behind the Create and Files pages. */
export type {
  FileKind,
  FilePage,
  MaterialListItem,
  MaterialPage,
} from './gen/model';
export type MaterialListKind = 'note' | 'quiz' | 'flashcards';
export type MaterialListLocation = 'workspace' | 'embedded' | 'standalone';
export type MaterialListSort = 'updated' | 'created' | 'title' | 'kind';
/** owned: the caller's workspaces (and standalone materials); member: also
 * every workspace they are a member of. */
export type ListScope = 'owned' | 'member';
export interface MaterialListParams {
  dir?: 'asc' | 'desc';
  kinds?: MaterialKind[];
  locations?: MaterialListLocation[];
  scope?: ListScope;
  sort?: MaterialListSort;
  workspaceIds?: string[];
}
export type FileListSort = 'added' | 'name' | 'size' | 'kind';
export interface FileListParams {
  dir?: 'asc' | 'desc';
  kinds?: FileKind[];
  scope?: ListScope;
  sort?: FileListSort;
  workspaceIds?: string[];
}

/* Attribution of a material or file written from the shared knowledge library,
   rendered outside the editable document so a user cannot delete the credit. */
export type {
  Provenance,
  ProvenanceBook,
  QuestionCredit,
} from './gen/model';

/* ---------------- Plate collaboration ---------------- */
export type MaterialComment = Omit<GenComment, 'contentRich'> & {
  contentRich: import('@/features/materials/document').MaterialValue | null;
};

export type MaterialDiscussion = Omit<GenDiscussion, 'comments'> & {
  comments: MaterialComment[];
};

export type {
  MaterialAuthor,
  PDFRect,
  SourceCollaborationToken,
  SourceProcessResult,
  SourceSession,
  WorkspaceSummary,
  WorkspaceSummaryChapter,
  WorkspaceSummaryFile,
} from './gen/model';
/* ---------------- Raw generated namespace ----------------
   Reach for `Gen` when you need the exact backend contract (e.g. nullable
   arrays, request bodies) rather than the UI-facing domain type above. */
export * as Gen from './gen/model';
export type PDFAnnotationBody = Omit<
  import('./gen/model').PDFAnnotationBody,
  'rects'
> & { rects: import('./gen/model').PDFRect[] };
export type PDFAnnotation = Omit<
  import('./gen/model').PDFAnnotation,
  'rects'
> & { rects: import('./gen/model').PDFRect[] };
