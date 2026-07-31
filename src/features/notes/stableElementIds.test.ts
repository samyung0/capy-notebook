import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { stableElementIdsPlugin } from './stableElementIds';

describe('stableElementIdsPlugin', () => {
  it('assigns IDs recursively before inserted nodes enter the editor', () => {
    const editor = createPlateEditor({
      plugins: [stableElementIdsPlugin],
      value: [{ children: [{ text: '' }], id: 'initial', type: 'p' }],
    });
    editor.tf.insertNodes(
      {
        children: [
          {
            children: [{ text: 'nested' }],
            type: 'p',
          },
        ],
        type: 'blockquote',
      } as never,
      { at: [1] }
    );
    const block = editor.children[1] as {
      children: Array<{ id?: string }>;
      id?: string;
    };
    expect(block.id).toBeTruthy();
    expect(block.children[0].id).toBeTruthy();
  });
});
