import { getColSpan, getRowSpan, getTableColumnCount } from '@platejs/table';
import {
  type Descendant,
  ElementApi,
  NodeApi,
  type TTableCellElement,
  type TTableElement,
} from 'platejs';
import { estimateColumnWidth } from '@/lib/columnWidth';
import { isTableSize } from './document';

/** Column widths for a table: a size the user set by resizing wins, other
 *  columns fit their longest line within the shared min and max. */
export function tableColumnWidths(
  table: TTableElement,
  colSizes: readonly unknown[] = table.colSizes ?? []
): number[] {
  const count = getTableColumnCount(table);
  const lines = Array.from({ length: count }, () => [] as string[]);
  // Rows still covered by a rowSpan from above, per column.
  const covered: number[] = Array.from({ length: count }, () => 0);
  for (const row of table.children) {
    if (!ElementApi.isElement(row)) continue;
    let column = 0;
    for (const cell of row.children as TTableCellElement[]) {
      while (covered[column] > 0) column += 1;
      const colSpan = getColSpan(cell);
      // A merged cell spans several columns, so it says nothing about one.
      if (colSpan === 1 && column < count) {
        for (const block of cell.children as Descendant[]) {
          lines[column].push(NodeApi.string(block));
        }
      }
      for (let k = column; k < column + colSpan && k < count; k += 1) {
        covered[k] = getRowSpan(cell);
      }
      column += colSpan;
    }
    for (let k = 0; k < count; k += 1) covered[k] = Math.max(0, covered[k] - 1);
  }
  return lines.map((texts, index) => {
    const size = colSizes[index];
    return isTableSize(size) && size > 0 ? size : estimateColumnWidth(texts);
  });
}
