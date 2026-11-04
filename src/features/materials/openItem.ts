import type { Region, ReviewMode } from '@/api/types';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import {
  isSettingsTab,
  type SettingsTab,
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
  /** A Study page in the centre while nothing is open; Practice is the one
   * built so far. */
  study?: 'practice';
  /** Practice's topic session to start: its group, topic and, from a
   * suggestion, its mode. */
  group?: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
  /** Practice's result of a finished topic session. */
  review?: string;
  /** Workspace settings open at this tab, over whatever the page shows. */
  settings?: SettingsTab;
  /** One-shot actions from the Get started list, dropped once taken: open the
   * Add file dialog, or a new chat. */
  add?: 'upload';
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
    group: undefined,
    review: undefined,
    reviewMode: undefined,
    study: undefined,
    topicId: undefined,
    ...parseOpenPage(search),
    add: search.add === 'upload' ? 'upload' : undefined,
    chat: search.chat === 'new' ? 'new' : undefined,
    settings: isSettingsTab(search.settings) ? search.settings : undefined,
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
  return search.study === 'practice' ? parsePractice(search) : {};
}

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;
const GROUPS = ['topic', 'others', 'workspace'] as const;
const MODES: readonly ReviewMode[] = ['tricky', 'fading', 'learned'];

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
