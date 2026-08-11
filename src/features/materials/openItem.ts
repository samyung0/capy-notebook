/** What the center content pane is currently showing. A source file or a
 * persisted study material (markdown: mindmap, diagram, quiz, flashcards).
 *
 * `page` is a 1-based page in the open file, set when a chat citation is
 * clicked. It lives in the URL rather than in component state so a cited page
 * survives a reload and can be linked to. */
export type OpenItem =
  | { kind: 'file'; id: string; page?: number }
  | { kind: 'material'; id: string };

/** URL search params for the open item — mutually exclusive `file` | `material`. */
export type WorkspaceOpenSearch = {
  file?: string;
  material?: string;
  page?: number;
};

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
  if (material) return { material };
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
  return item.page ? { file: item.id, page: item.page } : { file: item.id };
}
