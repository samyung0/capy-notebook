import { createSlatePlugin, PathApi } from 'platejs';

/** Enter on a selected void block (image, embed, diagram) opens an empty
 * paragraph below it; Slate's default break cannot split a void and does
 * nothing. */
export const VoidBlockBreakPlugin = createSlatePlugin({
  key: 'capy-void-block-break',
}).overrideEditor(({ editor, tf: { insertBreak } }) => ({
  transforms: {
    insertBreak() {
      const entry = editor.api.block();
      if (entry && editor.api.isVoid(entry[0])) {
        editor.tf.insertNodes(editor.api.create.block(), {
          at: PathApi.next(entry[1]),
          select: true,
        });
        return;
      }
      insertBreak();
    },
  },
}));
