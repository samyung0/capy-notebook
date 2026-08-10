import { getCellTypes, mergeTableCells } from '@platejs/table';
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from '@platejs/table/react';
import {
  ElementApi,
  KEYS,
  type TElement,
  TextApi,
  type TTableCellElement,
  type TTableElement,
} from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { stableElementIdsPlugin } from './stableElementIds';
import { mergeTableCellsSafe } from './tableStructure';

function cell(
  id: string,
  text: string,
  type: typeof KEYS.td | typeof KEYS.th = KEYS.td
): TTableCellElement {
  return {
    children: [{ children: [{ text }], type: KEYS.p }],
    id,
    type,
  };
}

function createTableEditor(table: TTableElement) {
  const editor = createPlateEditor({
    plugins: [
      stableElementIdsPlugin,
      TablePlugin.configure({ options: { minColumnWidth: 48 } }),
      TableRowPlugin,
      TableCellPlugin,
      TableCellHeaderPlugin,
    ],
    value: [table, { children: [{ text: '' }], type: KEYS.p }],
  });
  return editor;
}

function selectWholeTable(editor: ReturnType<typeof createTableEditor>) {
  editor.tf.select({
    anchor: { offset: 0, path: [0, 0, 0, 0, 0] },
    focus: { offset: 0, path: [0, 1, 1, 0, 0] },
  });
}

function rowHasOnlyElements(row: TElement) {
  return row.children.every((child) => ElementApi.isElement(child));
}

describe('mergeTableCellsSafe', () => {
  it('keeps a valid table after merging every cell (stock merge leaves text under tr)', () => {
    const editor = createTableEditor({
      children: [
        {
          children: [cell('c00', 'A'), cell('c01', 'B')],
          type: KEYS.tr,
        },
        {
          children: [cell('c10', 'C'), cell('c11', 'D')],
          type: KEYS.tr,
        },
      ],
      type: KEYS.table,
    });

    selectWholeTable(editor);
    mergeTableCells(editor);

    const broken = editor.children[0] as TTableElement;
    expect(
      broken.children.some(
        (row) =>
          ElementApi.isElement(row) &&
          row.children.some((child) => TextApi.isText(child))
      )
    ).toBe(true);

    const safeEditor = createTableEditor({
      children: [
        {
          children: [cell('c00', 'A'), cell('c01', 'B')],
          type: KEYS.tr,
        },
        {
          children: [cell('c10', 'C'), cell('c11', 'D')],
          type: KEYS.tr,
        },
      ],
      type: KEYS.table,
    });
    selectWholeTable(safeEditor);
    mergeTableCellsSafe(safeEditor);

    const table = safeEditor.children[0] as TTableElement;
    expect(table.type).toBe(KEYS.table);
    expect(table.children).toHaveLength(1);
    expect(rowHasOnlyElements(table.children[0] as TElement)).toBe(true);

    const merged = (table.children[0] as TElement)
      .children[0] as TTableCellElement;
    expect(getCellTypes(safeEditor)).toContain(merged.type);
    expect(merged.colSpan).toBe(2);
    expect(merged.rowSpan ?? 1).toBe(1);

    const texts = JSON.stringify(merged);
    expect(texts).toContain('A');
    expect(texts).toContain('B');
    expect(texts).toContain('C');
    expect(texts).toContain('D');
  });
});
