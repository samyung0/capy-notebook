import type { Region } from '@/api/types';
import type { MaterialMode } from './modePolicy';

/** What the center content pane is currently showing. A source file or a
 * persisted study material (markdown: mindmap, diagram, quiz, flashcards).
 *
 * `page` is a 1-based page in the open file, set when a chat citation is
 * clicked. It lives in the URL rather than in component state so a cited page
 * survives a reload and can be linked to. `regions` is deliberately transient:
 * regular file navigation and reloads clear the citation highlight. `mode` is
 * an optional initial material mode (dashboard links force view). */
export type OpenItem =
  | { kind: 'file'; id: string; page?: number; regions?: Region[] }
  | { kind: 'material'; id: string };

/** URL search params for the open item — mutually exclusive `file` | `material`. */
export type WorkspaceOpenSearch = {
  file?: string;
  material?: string;
  page?: number;
  mode?: MaterialMode;
};

const MATERIAL_MODES = new Set<MaterialMode>(['view', 'edit', 'comment']);

function parseMaterialMode(value: unknown): MaterialMode | undefined {
  return typeof value === 'string' && MATERIAL_MODES.has(value as MaterialMode)
    ? (value as MaterialMode)
    : undefined;
}

export function parseWorkspaceOpenSearch(
  search: Record<string, unknown>
): WorkspaceOpenSearch {
  const file = typeof search.file === 'string' ? search.file : undefined;
  const material =
    typeof search.material === 'string' ? search.material : undefined;
  if (file) {
    const raw = Number(search.page);
    const page = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    return page ? { file, page } : { file };
  }
  if (material) {
    const mode = parseMaterialMode(search.mode);
    return mode ? { material, mode } : { material };
  }
  return {};
}

export function openItemFromSearch(
  search: WorkspaceOpenSearch
): OpenItem | null {
  if (search.file) return { id: search.file, kind: 'file', page: search.page };
  if (search.material) return { id: search.material, kind: 'material' };
  return null;
}

export function searchFromOpenItem(item: OpenItem | null): WorkspaceOpenSearch {
  if (!item) return {};
  if (item.kind === 'material') return { material: item.id };
  // Bounding boxes stay in memory. Putting them in search params would create
  // long links and make highlights survive ordinary file navigation.
  return item.page ? { file: item.id, page: item.page } : { file: item.id };
}
