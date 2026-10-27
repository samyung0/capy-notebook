import type { Region } from '@/api/types';
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
 * an optional document mode, overriding the locally saved mode. */
export type OpenItem =
  | {
      kind: 'file';
      id: string;
      page?: number;
      regions?: Region[];
      citation?: OfficeCitation;
    }
  /** `target` is a quiz question or flashcard to bring into view. */
  | { kind: 'material'; id: string; target?: string };

/** URL search params for the open item — mutually exclusive `file` | `material`. */
export type WorkspaceOpenSearch = {
  file?: string;
  material?: string;
  /** A question or card in the open material, e.g. from a review summary. */
  item?: string;
  page?: number;
  mode?: MaterialMode;
  /** The open item fills the page, header and side panels hidden. In the URL
   * so the back gesture leaves it. */
  fullscreen?: true;
  /** The workspace's Study page, shown while nothing is open. */
  study?: true;
  /** The Study page's picked plan, kept in this workspace (the Study page
   * shows while nothing is open). */
  plan?: string;
  /** Workspace settings open at this tab, over whatever the page shows. */
  settings?: SettingsTab;
  /** One-shot actions from the Get started list, dropped once taken: open the
   * Add file dialog, or a new chat. */
  add?: 'upload';
  chat?: 'new';
};

function documentModeKey(item: OpenItem): string {
  return `capy.document.mode.${item.kind}.${item.id}`;
}

export function readDocumentMode(item: OpenItem): MaterialMode {
  try {
    return localStorage.getItem(documentModeKey(item)) === 'edit'
      ? 'edit'
      : 'view';
  } catch {
    return 'view';
  }
}

export function saveDocumentMode(item: OpenItem, mode: MaterialMode): void {
  try {
    localStorage.setItem(documentModeKey(item), mode);
  } catch {
    // Browsers can disable local storage; the URL still retains the mode.
  }
}

function parseDocumentMode(value: unknown): MaterialMode | undefined {
  return value === 'view' || value === 'edit' ? value : undefined;
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
    plan: undefined,
    study: undefined,
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
    return {
      material,
      ...parseDocumentModeSearch(search),
      ...(item ? { item } : {}),
    };
  }
  if (typeof search.plan === 'string' && search.plan)
    return { plan: search.plan };
  return search.study === true || search.study === 'true'
    ? { study: true }
    : {};
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
