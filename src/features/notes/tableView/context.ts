import { createContext, useContext } from 'react';
import type { TableViewBlock } from './model';

/** One edit: the next block from the block as the room holds it now. */
export type TableViewEdit = (block: TableViewBlock) => TableViewBlock;

export type TableViewApi = {
  block: TableViewBlock;
  /** Absent in a read-only note: no menus, no + controls. */
  write?: (edit: TableViewEdit) => void;
};

export const TableViewContext = createContext<TableViewApi | null>(null);

export function useTableView(): TableViewApi {
  const api = useContext(TableViewContext);
  if (!api) throw new Error('useTableView outside a table view');
  return api;
}

/** Keys typed in a field stay out of the note editor and of a menu's
 * typeahead; Escape still closes the menu. */
export const keepKeys = (event: React.KeyboardEvent) => {
  if (event.key !== 'Escape') event.stopPropagation();
};
