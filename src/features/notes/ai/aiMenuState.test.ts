import { AIChatPlugin, AIPlugin } from '@platejs/ai/react';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { RangeApi } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { expect, it } from 'vitest';
import { commandRange } from './aiMenuState';

it('acts on a Shift+Down selection without the next block it ends at', () => {
  const editor = createPlateEditor({
    plugins: [AIPlugin, AIChatPlugin, BlockSelectionPlugin],
    value: [
      { children: [{ text: 'one' }], id: 'p1', type: 'p' },
      { children: [{ text: 'two' }], id: 'p2', type: 'p' },
    ],
  });
  editor.setOption(AIChatPlugin, 'chatSelection', {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 0, path: [1, 0] },
  });
  const range = commandRange(editor);
  expect(range && RangeApi.end(range)).toEqual({ offset: 3, path: [0, 0] });
});
