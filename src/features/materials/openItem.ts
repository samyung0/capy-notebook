import type { Region, ReviewMode } from '@/api/types';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import {
  type HistorySearch,
  parseHistorySearch,
} from '@/features/study/reviewSearch';
import {
  isSettingsView,
  type SettingsView,
} from '@/features/workspace/settingsTabs';
import type { MaterialMode } from './modePolicy';

/** What the center content pane is currently showing. A source file or a
 * persisted study material (markdown: mindmap, diagram, quiz, flashcards).
 *
 * `page` is a 1-based page in the open file, set when a chat citation is
 * clicked. It lives in the URL rather than in component state so a cited page
 * survives a reload and can be linked to. `regions` is deliberately transient:
 * regular file navigation and reloads clear the citation highlight. `mode` is
 * an Office or text file's optional mode, overriding the locally saved one; a
 * material has none (Epo 2026-11-04), and an old link's is ignored. */
export type OpenItem =
  | {
      kind: 'file';
      id: string;
      page?: number;
      regions?: Region[];
      citation?: OfficeCitation;
    }
  /** `target` is a quiz question or flashcard to bring into view; `citation`
   * a chat citation's passage in a note. */
  | {
      kind: 'material';
      id: string;
      target?: string;
      citation?: NoteCitationTarget;
    };

/** A note citation: the blocks it came from, and its text for one without. */
export type NoteCitationTarget = OfficeCitation & { blockIds?: string[] };

/** The page a URL can't name otherwise (Epo 2026-11-14: Files and Chat are
 * pages, no panel state in the URL): Files with nothing open, the chat list
 * (phones; wider it is the Chat page), a chat (the Chat page, or over the open
 * file its window or sheet), the chat over Files with nothing open
 * (`files-chat`), and the member's board. An open file or material is the
 * Files page; `study` names the others; none is the Dashboard. */
export type WorkspaceView =
  | 'files'
  | 'files-chat'
  | 'chats'
  | 'chat'
  | 'canvas';

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return (
    value === 'files' ||
    value === 'files-chat' ||
    value === 'chats' ||
    value === 'chat' ||
    value === 'canvas'
  );
}

/** URL search params for the open item — mutually exclusive `file` | `material`. */
export type WorkspaceOpenSearch = {
  file?: string;
  material?: string;
  /** A question or card in the open material, e.g. from a review summary. */
  item?: string;
  page?: number;
  /** A file's: an old material link's is dropped. */
  mode?: MaterialMode;
  /** The open item fills the page, header and side panels hidden. In the URL
   * so the back gesture leaves it. */
  fullscreen?: true;
  view?: WorkspaceView;
  /** The Canvas tab's canvas shown (Epo 2026-11-12: a member has several). */
  c?: string;
  /** What fills the canvas's screen (Epo 2026-11-13): a plane's or chart's
   * editor, or a quiz card's drawing answer (`<card>~<part>`). */
  open?: string;
  /** One of the pages that came out of Study (To do or Assignments,
   * Practice, Members, Study's own summary) in the centre while nothing is open. */
  study?:
    | 'practice'
    | 'summary'
    | 'history'
    | 'bank'
    | 'assignments'
    | 'members';
  /** Assignments' open assignment, and a try at it: running, or results. */
  assignment?: string;
  attempt?: string;
  /** An assignment given to its own owner or teaching assistant: their page,
   * not its report. */
  own?: true;
  /** An assignment's report: its tab, and on Approve AI marks a question or
   * member to open at. On a class staff's Study, `member` is the profile open;
   * beside `attempt`, the profile it was opened from. */
  tab?:
    | 'questions'
    | 'responses'
    | 'approve'
    | 'members'
    | 'settings'
    | 'preview';
  /** A graded quiz's Responses By question (By member without it). */
  by?: 'question';
  question?: string;
  member?: string;
  /** A class staff's Study on Topics (board G4), kept while a profile is open. */
  show?: 'topics';
  /** Study's History tab: its sort and filters, as the account's History. */
  sort?: HistorySearch['sort'];
  dir?: HistorySearch['dir'];
  kind?: string;
  status?: string;
  /** Practice's topic session to start: its group, topic and, from a
   * suggestion, its mode. */
  group?: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
  /** Practice's result of a finished topic session. */
  review?: string;
  /** Make a quiz's dialog while nothing is open: its files, pages or run. */
  make?: 'files' | 'pages' | 'run';
  /** The page Make a quiz opened from, which cancelling returns to; the Dashboard
   * when there's none. */
  makeFrom?: 'practice';
  /** The file whose pages it shows. */
  quizFile?: string;
  /** The question paper's files and the mark scheme or answer files, comma
   * separated, kept so a reload or Back returns to the same choice. */
  paper?: string;
  answers?: string;
  /** The run its page follows. */
  run?: string;
  /** Workspace settings open at this tab, over whatever the page shows. */
  settings?: SettingsView;
  /** What its search holds. */
  settingsQuery?: string;
  /** One-shot actions from the Get started list, dropped once taken: open the
   * Add file dialog, or a new chat. */
  add?: 'create' | 'upload';
  chat?: 'new';
};

/** A file's last mode here: a material has none, it opens at the highest its
 * reader may have. */
type FileItem = Extract<OpenItem, { kind: 'file' }>;

function documentModeKey(item: FileItem): string {
  return `capy.document.mode.${item.kind}.${item.id}`;
}

export function readDocumentMode(item: FileItem): MaterialMode {
  try {
    return localStorage.getItem(documentModeKey(item)) === 'edit'
      ? 'edit'
      : 'view';
  } catch {
    return 'view';
  }
}

export function saveDocumentMode(item: FileItem, mode: MaterialMode): void {
  try {
    localStorage.setItem(documentModeKey(item), mode);
  } catch {
    // Browsers can disable local storage; the URL still retains the mode.
  }
}

function parseDocumentMode(value: unknown): MaterialMode | undefined {
  return value === 'view' || value === 'edit' ? value : undefined;
}

/** A standalone material's page: full screen only (an old link's `mode` goes). */
export function parseMaterialPageSearch(search: Record<string, unknown>): {
  fullscreen?: true;
  mode?: undefined;
} {
  const { fullscreen } = parseDocumentModeSearch(search);
  return { mode: undefined, ...(fullscreen ? { fullscreen } : {}) };
}

export function parseDocumentModeSearch(search: Record<string, unknown>): {
  mode?: MaterialMode;
  fullscreen?: true;
} {
  const mode = parseDocumentMode(search.mode);
  const fullscreen = search.fullscreen === true || search.fullscreen === 'true';
  return { ...(mode ? { mode } : {}), ...(fullscreen ? { fullscreen } : {}) };
}

export function parseWorkspaceOpenSearch(
  search: Record<string, unknown>
): WorkspaceOpenSearch {
  // Invalid values are cleared explicitly: the router keeps raw keys the
  // parser leaves out.
  return {
    answers: undefined,
    assignment: undefined,
    attempt: undefined,
    dir: undefined,
    file: undefined,
    group: undefined,
    kind: undefined,
    make: undefined,
    makeFrom: undefined,
    member: undefined,
    own: undefined,
    paper: undefined,
    question: undefined,
    quizFile: undefined,
    review: undefined,
    reviewMode: undefined,
    run: undefined,
    show: undefined,
    sort: undefined,
    status: undefined,
    study: undefined,
    tab: undefined,
    topicId: undefined,
    ...parseOpenPage(search),
    add:
      search.add === 'upload' || search.add === 'create'
        ? search.add
        : undefined,
    c: search.view === 'canvas' ? text(search.c) : undefined,
    chat: search.chat === 'new' ? 'new' : undefined,
    open: search.view === 'canvas' ? text(search.open) : undefined,
    settings: isSettingsView(search.settings) ? search.settings : undefined,
    settingsQuery: isSettingsView(search.settings)
      ? text(search.settingsQuery)
      : undefined,
    view: isWorkspaceView(search.view) ? search.view : undefined,
  };
}

function parseOpenPage(search: Record<string, unknown>): WorkspaceOpenSearch {
  const file = typeof search.file === 'string' ? search.file : undefined;
  const material =
    typeof search.material === 'string' ? search.material : undefined;
  if (file) {
    const raw = Number(search.page);
    const page = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    return {
      file,
      ...(page ? { page } : {}),
      ...parseDocumentModeSearch(search),
    };
  }
  if (material) {
    const item =
      typeof search.item === 'string' && search.item ? search.item : undefined;
    const { fullscreen } = parseDocumentModeSearch(search);
    return {
      material,
      mode: undefined,
      ...(fullscreen ? { fullscreen } : {}),
      ...(item ? { item } : {}),
    };
  }
  if (search.study === 'assignments') return parseAssignments(search);
  if (search.study === 'summary') return parseSummary(search);
  if (search.study === 'history')
    return { study: 'history', ...parseHistorySearch(search) };
  if (search.study === 'members') return { study: 'members' };
  if (search.study === 'bank') return { study: 'bank' };
  if (search.study === 'practice') return parsePractice(search);
  return parseMakeQuiz(search);
}

/** Make a quiz's page: pages need their paper, a run its id. */
function parseMakeQuiz(search: Record<string, unknown>): WorkspaceOpenSearch {
  const paper = text(search.paper);
  const answers = text(search.answers);
  const run = text(search.run);
  const makeFrom = search.makeFrom === 'practice' ? search.makeFrom : undefined;
  if (search.make === 'files')
    return { answers, make: 'files', makeFrom, paper };
  if (search.make === 'pages' && paper)
    return {
      answers,
      make: 'pages',
      makeFrom,
      paper,
      quizFile: text(search.quizFile),
    };
  if (search.make === 'run' && run)
    return { answers, make: 'run', makeFrom, paper, run };
  return {};
}

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;
const GROUPS = ['topic', 'others', 'workspace'] as const;
const MODES: readonly ReviewMode[] = ['tricky', 'fading', 'learned'];

const TABS = [
  'questions',
  'responses',
  'approve',
  'members',
  'settings',
  'preview',
] as const;

/** Assignments, one assignment (its report's view), or a try at one. Unknown
 * tabs clear; ids are the page's to answer. */
function parseAssignments(
  search: Record<string, unknown>
): WorkspaceOpenSearch {
  const assignment = text(search.assignment);
  if (!assignment) return { study: 'assignments' };
  const attempt = text(search.attempt);
  if (attempt) {
    // Opened from a member's profile: its back link returns there.
    const member = text(search.member);
    return {
      assignment,
      attempt,
      study: 'assignments',
      ...(member ? { member } : {}),
      ...(member && search.show === 'topics'
        ? { show: 'topics' as const }
        : {}),
    };
  }
  const tab = TABS.find((t) => t === search.tab);
  const question = tab === 'approve' ? text(search.question) : undefined;
  const member = tab === 'approve' ? text(search.member) : undefined;
  const by =
    tab === 'responses' && search.by === 'question'
      ? ('question' as const)
      : undefined;
  return {
    assignment,
    study: 'assignments',
    ...(search.own === true || search.own === 'true'
      ? { own: true as const }
      : {}),
    ...(tab ? { tab } : {}),
    ...(by ? { by } : {}),
    ...(question ? { question } : {}),
    ...(member ? { member } : {}),
  };
}

/** To do's page of a task with no workspace (`/todo/task`): the same keys. */
export const parseTaskSearch = (search: Record<string, unknown>) =>
  parseAssignments(search);

/** Study, for a class's staff its Topics tab or a member's profile. */
function parseSummary(search: Record<string, unknown>): WorkspaceOpenSearch {
  const member = text(search.member);
  return {
    study: 'summary',
    ...(member ? { member } : {}),
    ...(search.show === 'topics' ? { show: 'topics' as const } : {}),
  };
}

/** Practice, a topic session to start on it, or a session's result. */
function parsePractice(search: Record<string, unknown>): WorkspaceOpenSearch {
  const review = text(search.review);
  if (review) return { review, study: 'practice' };
  const group = GROUPS.find((g) => g === search.group);
  const topicId = text(search.topicId);
  if (!group || (group === 'topic' && !topicId)) return { study: 'practice' };
  const reviewMode = MODES.find((md) => md === search.reviewMode);
  return {
    group,
    study: 'practice',
    ...(group === 'topic' ? { topicId } : {}),
    ...(reviewMode ? { reviewMode } : {}),
  };
}

export function openItemFromSearch(
  search: WorkspaceOpenSearch
): OpenItem | null {
  if (search.file) return { id: search.file, kind: 'file', page: search.page };
  if (search.material)
    return search.item
      ? { id: search.material, kind: 'material', target: search.item }
      : { id: search.material, kind: 'material' };
  return null;
}

export function searchFromOpenItem(item: OpenItem | null): WorkspaceOpenSearch {
  if (!item) return {};
  if (item.kind === 'material')
    return item.target
      ? { item: item.target, material: item.id }
      : { material: item.id };
  // Bounding boxes stay in memory. Putting them in search params would create
  // long links and make highlights survive ordinary file navigation.
  return item.page ? { file: item.id, page: item.page } : { file: item.id };
}
