/** Whether note rooms use the blocks layout (todo-blocksuite-spike.md,
 * boundary 1): the browser's `VITE_DOCUMENT_LAYOUT`, which MSW reads too.
 * Only dev stacks set it; read on each call so tests can stub it. */
export function blocksLayout(): boolean {
  return import.meta.env.VITE_DOCUMENT_LAYOUT === 'blocks';
}
