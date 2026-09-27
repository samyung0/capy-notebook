import { ColumnPlugin } from '@platejs/layout/react';
import { KEYS, NodeApi } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { setColumnLayout } from './columnLayout';

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
});
