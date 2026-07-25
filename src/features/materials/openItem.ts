/** What the center content pane is currently showing. A source file or a
 * persisted study material (markdown: mindmap, diagram, quiz, flashcards). */
export type OpenItem =
  | { kind: 'file'; id: string }
  | { kind: 'material'; id: string };

/** URL search params for the open item — mutually exclusive `file` | `material`. */
export type WorkspaceOpenSearch = { file?: string; material?: string };

export function parseWorkspaceOpenSearch(
  search: Record<string, unknown>
): WorkspaceOpenSearch {
  const file = typeof search.file === 'string' ? search.file : undefined;
  const material =
    typeof search.material === 'string' ? search.material : undefined;
  if (file) return { file };
  if (material) return { material };
  return {};
}

export function openItemFromSearch(
  search: WorkspaceOpenSearch
): OpenItem | null {
  if (search.file) return { id: search.file, kind: 'file' };
  if (search.material) return { id: search.material, kind: 'material' };
  return null;
}

export function searchFromOpenItem(item: OpenItem | null): WorkspaceOpenSearch {
  if (!item) return {};
  return item.kind === 'file' ? { file: item.id } : { material: item.id };
}
