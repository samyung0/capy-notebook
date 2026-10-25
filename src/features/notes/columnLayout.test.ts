import { ColumnPlugin } from '@platejs/layout/react';
import { KEYS, NodeApi } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { isColumnWidth } from '@/features/materials/document';
import { setColumnLayout } from './columnLayout';
import { COLUMN_LAYOUTS } from './richBlockConfig';

const paragraph = (text: string) => ({ children: [{ text }], type: KEYS.p });
const column = (text: string) => ({
  children: [paragraph(text)],
  type: KEYS.column,
  width: '50%',
});

describe('setColumnLayout', () => {
  it('keeps content unchanged through repeated layout switches', () => {
    const editor = createPlateEditor({
      plugins: [ColumnPlugin],
      value: [
        { children: [column('Left'), column('Right')], type: KEYS.columnGroup },
      ],
    });
    const original = structuredClone(editor.children);
    for (let cycle = 0; cycle < 4; cycle++) {
      setColumnLayout(editor, [0], ['33.333%', '33.333%', '33.334%']);
      setColumnLayout(editor, [0], ['66.667%', '33.333%']);
      setColumnLayout(editor, [0], ['33.333%', '66.667%']);
      setColumnLayout(editor, [0], ['50%', '50%']);
    }
    expect(editor.children).toEqual(original);
  });

  it('retains authored blocks and textless embeds when merging columns', () => {
    const editor = createPlateEditor({
      plugins: [ColumnPlugin],
      value: [
        {
          children: [
            column('First'),
            column('Second'),
            {
              children: [
                paragraph('Third'),
                paragraph(''),
                { children: [{ text: '' }], type: KEYS.hr },
              ],
              type: KEYS.column,
              width: '33.334%',
            },
          ],
          type: KEYS.columnGroup,
        },
      ],
    });
    setColumnLayout(editor, [0], ['50%', '50%']);
    expect(NodeApi.string(editor)).toBe('FirstSecondThird');
    expect(NodeApi.get(editor, [0, 1, 2])).toMatchObject(paragraph(''));
    expect(NodeApi.get(editor, [0, 1, 3])).toMatchObject({ type: KEYS.hr });
  });

  // Plate's normalizer rewrites widths that stop summing to 100 as floats;
  // the document check, Go and the collaboration server must take them.
  it('writes only widths the document check takes', () => {
    const editor = createPlateEditor({
      plugins: [ColumnPlugin],
      value: [
        {
          children: [
            { ...column('One'), width: '33.333%' },
            { ...column('Two'), width: '33.333%' },
            { ...column('Three'), width: '33.334%' },
          ],
          type: KEYS.columnGroup,
        },
        {
          children: [0, 1, 2].map((index) => ({
            children: [paragraph(String(index))],
            type: KEYS.column,
          })),
          type: KEYS.columnGroup,
        },
      ],
    });
    editor.tf.normalize({ force: true });
    editor.tf.select({
      anchor: { offset: 1, path: [0, 0, 0, 0] },
      focus: { offset: 1, path: [0, 1, 0, 0] },
    });
    editor.tf.deleteFragment();
    const widths = editor.children.flatMap((group) =>
      (group.children as { width?: unknown }[]).map((node) => node.width)
    );
    expect(widths).toEqual([
      '49.9995%',
      '50.0005%',
      '33.333333333333336%',
      '33.333333333333336%',
      '33.333333333333336%',
    ]);
    for (const width of widths) expect(isColumnWidth(width)).toBe(true);
    for (const layout of COLUMN_LAYOUTS)
      for (const width of layout.widths)
        expect(isColumnWidth(width)).toBe(true);
  });
});
