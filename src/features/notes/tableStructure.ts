import {
  getCellTypes,
  getRowSpan,
  getTableGridAbove,
  mergeTableCells,
} from '@platejs/table';
import {
  ElementApi,
  KEYS,
  type Path,
  PathApi,
  type SlateEditor,
  type TElement,
  type TTableCellElement,
} from 'platejs';

/**
 * Plate's mergeTableCells removes every selected cell, then inserts the merged
 * cell at the original first-cell path. When the selection covers full-width
 * rows (e.g. merge the whole table), emptied rows keep Slate's mandatory empty
 * text child — which renders as <span> under <tr> and corrupts slate-yjs paths
 * so undo/redo loses cells.
 */
export function sanitizeTableStructure(editor: SlateEditor, tablePath: Path) {
  const tableType = editor.getType(KEYS.table);
  const cellTypes = new Set(getCellTypes(editor));

  editor.tf.withoutNormalizing(() => {
    const tableEntry = editor.api.node(tablePath);
    if (!tableEntry || !ElementApi.isElement(tableEntry[0])) return;
    if (tableEntry[0].type !== tableType) return;

    for (
      let rowIndex = tableEntry[0].children.length - 1;
      rowIndex >= 0;
      rowIndex--
    ) {
      const rowPath = [...tablePath, rowIndex] as Path;
      const rowEntry = editor.api.node(rowPath);
      if (!rowEntry || !ElementApi.isElement(rowEntry[0])) continue;

      const row = rowEntry[0];
      for (
        let childIndex = row.children.length - 1;
        childIndex >= 0;
        childIndex--
      ) {
        if (!ElementApi.isElement(row.children[childIndex])) {
          editor.tf.removeNodes({ at: [...rowPath, childIndex] });
        }
      }

      const updatedRow = editor.api.node(rowPath)?.[0];
      if (!updatedRow || !ElementApi.isElement(updatedRow)) continue;

      const hasCell = updatedRow.children.some(
        (child) => ElementApi.isElement(child) && cellTypes.has(child.type)
      );
      if (!hasCell) {
        editor.tf.removeNodes({ at: rowPath });
      }
    }

    const cleaned = editor.api.node(tablePath)?.[0];
    if (!cleaned || !ElementApi.isElement(cleaned)) return;

    const rowCount = cleaned.children.length;
    cleaned.children.forEach((row, rowIndex) => {
      if (!ElementApi.isElement(row)) return;
      row.children.forEach((cell, cellIndex) => {
        if (!ElementApi.isElement(cell) || !cellTypes.has(cell.type)) return;
        const span = getRowSpan(cell as TTableCellElement);
        if (rowIndex + span <= rowCount) return;
        editor.tf.setNodes(
          { rowSpan: Math.max(1, rowCount - rowIndex) },
          { at: [...tablePath, rowIndex, cellIndex] }
        );
      });
    });
  });
}

/** Prefer this over tf.table.merge when the stock transform may empty whole rows. */
export function mergeTableCellsSafe(editor: SlateEditor) {
  const cellEntries = getTableGridAbove(editor, { format: 'cell' });
  if (cellEntries.length < 2) return;

  const tablePath = PathApi.parent(PathApi.parent(cellEntries[0][1]));
  mergeTableCells(editor);
  sanitizeTableStructure(editor, tablePath);

  const table = editor.api.node(tablePath)?.[0] as TElement | undefined;
  const firstCell =
    table?.children?.[0] && ElementApi.isElement(table.children[0])
      ? table.children[0].children.find(
          (child) =>
            ElementApi.isElement(child) &&
            getCellTypes(editor).includes(child.type)
        )
      : undefined;
  if (firstCell && ElementApi.isElement(firstCell)) {
    const path = editor.api.findPath(firstCell);
    if (path) editor.tf.select(editor.api.end(path));
  }
}
