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
  Attempt as GenAttempt,
  AttemptDetail as GenAttemptDetail,
  Chapter as GenChapter,
  Comment as GenComment,
  Deck as GenDeck,
  Discussion as GenDiscussion,
  Event as GenEvent,
  File as GenFile,
  Quiz as GenQuiz,
  SearchResult as GenSearchResult,
  Workspace as GenWorkspace,
  Privacy,
  UserColor,
} from './gen/model';

/* ---------------- pass-through wire contracts ---------------- */
export type {
  BillingInfo,
  Canvas as ThinkingCanvas,
  Flashcard,
  IntegrationsStatus,
  Label,
  Notification as AppNotification,
  NotificationPage,
  NotificationPrefs,
  SourceUploadPolicy,
  SrsState,
  Tag,
  TagInput,
  Task,
  User,
} from './gen/model';

/* ---------------- enums & scalars (straight from the generated spec) ---------------- */
export {
  FileKind,
  FileStatus,
  NotificationKind,
  PlanTier,
  Privacy,
  SearchKind,
  SubscriptionStatus,
  UserColor,
} from './gen/model';

/* ---------------- UI-only color extras (not on the wire) ---------------- */
export type SystemColor =
  | 'success'
  | 'info'
  | 'warning'
  | 'error'
  | 'accent-1'
  | 'accent-2';

/* ---------------- pass-through contracts (identical to the wire) ---------------- */
export type Workspace = Omit<GenWorkspace, 'isOwner'> & {
  isOwner?: boolean;
  /** General material permission for signed-in link/public visitors. */
  shareRole?: 'viewer' | 'commenter' | 'editor';
};
export type Chapter = GenChapter;
export type Attempt = GenAttempt;
export type CalendarEvent = GenEvent;

/** A past attempt with its per-question breakdown. `questions` is the rich
 * union (opaque on the wire); `answers` maps question id -> the user's answer
 * (the `Answer` union from grade.ts, kept loose here to avoid an import cycle). */
export type AttemptDetail = Omit<GenAttemptDetail, 'questions' | 'answers'> & {
  questions: Question[];
  answers: Record<string, unknown>;
};

/* ---------------- overridden contracts ----------------
   Same generated shape, minus the wire's opaque / client-only fields. */

/** Adds transient client state while tolerating legacy mock rows without a position. */
export type SourceFile = Omit<GenFile, 'position'> & {
  position?: number;
  ingestPct?: number;
};

/** `color` is a client-side tint derived from the owning workspace/label/deck. */
export type SearchResult = GenSearchResult & { color?: UserColor };

/** `questions` is the rich discriminated union; the wire keeps it opaque. */
export type Quiz = Omit<GenQuiz, 'questions' | 'isOwner'> & {
  questions: Question[];
  isOwner?: boolean;
};

/** Legacy mock rows omit new sharing fields; real API always returns both. */
export type Deck = Omit<GenDeck, 'privacy' | 'isOwner'> & {
  privacy?: Privacy;
  isOwner?: boolean;
};

export type PublicWorkspace = Workspace & { author: string; clones: number };
export type PublicQuiz = Quiz & { author: string; clones: number };
export type PublicDeck = Deck & { author: string; clones: number };

/** Response of POST /workspaces/{id}/clone. `ragCloned` is false when the
 * pipeline was offline — the copied files exist but have no knowledge graph
 * until they are re-ingested. */
export interface CloneWorkspaceResult {
  ragCloned: boolean;
  workspace: Workspace;
}

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
export type GenerateKind = 'flashcards' | 'quiz' | 'mindmap' | 'diagram';

export interface GenerateScope {
  chapters: string[]; // chapter ids
  fileIds: string[]; // file ids
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
export type MaterialKind =
  | 'mindmap'
  | 'diagram'
  | 'quiz'
  | 'flashcards'
  | 'note';

export interface Material {
  capabilities: import('./gen/model').AccessCapabilities;
  /** Chapter this material is filed under (membership). null = unfiled.
   * Orthogonal to scopeChapters (provenance of the generated content). */
  chapterId: string | null;
  /** Presentation tint; only meaningful for flashcards decks. */
  color?: UserColor;
  /** Versioned Universal Plate document. */
  content: import('@/features/materials/document').MaterialDocument;
  /** UTF-8 byte length of the persisted content JSON returned by the backend. */
  contentBytes?: number;
  createdAt: string;
  id: string;
  /** Request-scoped: false when viewing someone else's shared material. */
  isOwner?: boolean;
  kind: MaterialKind;
  maxDepth?: number;
  nodeCount?: number;
  /** Shared ordering position among files and materials in the same bucket. */
  position?: number;
  privacy: Privacy;
  revision?: number;
  role?: WorkspaceRole;
  scopeChapters: string[];
  scopeFileIds: string[];
  title: string;
  updatedAt?: string;
  workspaceId: string;
  workspaceName: string;
}

/* ---------------- Plate collaboration ---------------- */
export type WorkspaceRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface WorkspaceMember {
  avatarUrl?: string;
  createdAt: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  userId: string;
  workspaceId: string;
}

export type MaterialComment = Omit<GenComment, 'contentRich' | 'replies'> & {
  contentRich: import('@/features/materials/document').MaterialValue | null;
  replies: MaterialComment[];
};

export type MaterialDiscussion = Omit<GenDiscussion, 'comments'> & {
  comments: MaterialComment[];
};

export interface MaterialRevision {
  content: import('@/features/materials/document').MaterialDocument;
  createdAt: string;
  createdBy?: string;
  materialId: string;
  revision: number;
  title: string;
}

/** A row in the left-panel materials list. Aggregates markdown materials plus
 * the workspace's quizzes and decks into one flat (non chapter-scoped) list. */
export type MaterialRefType = 'mindmap' | 'diagram' | 'quiz' | 'deck' | 'note';
export interface MaterialRef {
  /** Chapter this material is filed under (membership). null = unfiled. */
  chapterId: string | null;
  createdAt: string;
  id: string;
  /** Shared ordering position among files and materials in the same bucket. */
  position: number;
  title: string;
  type: MaterialRefType;
}

/* ---------------- Raw generated namespace ----------------
   Reach for `Gen` when you need the exact backend contract (e.g. nullable
   arrays, request bodies) rather than the UI-facing domain type above. */
export * as Gen from './gen/model';
