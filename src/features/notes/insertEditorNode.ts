import { KEYS, NodeApi } from 'platejs';

// Plate's plugin-derived editor type includes transforms that are wider than
// the base editor type exported by platejs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NoteEditorInstance = any;

/**
 * Insert an inline node at the caret, or a block at the current block position.
 * An empty paragraph (including the paragraph left after choosing a slash
 * command) is replaced so insertion does not leave a stray blank line.
 */
export function insertEditorNode(editor: NoteEditorInstance, node: unknown) {
  editor.tf.focus();

  const selection = editor.selection;
  const isNode = node !== null && typeof node === 'object';
  if (selection && isNode && !editor.api.isInline(node)) {
    const currentBlockPath = [selection.anchor.path[0]];
    const currentBlock = editor.api.node(currentBlockPath)?.[0];

    if (
      currentBlock?.type === editor.getType(KEYS.p) &&
      NodeApi.string(currentBlock) === ''
    ) {
      editor.tf.withoutNormalizing(() => {
        editor.tf.removeNodes({ at: currentBlockPath });
        editor.tf.insertNodes(node, { at: currentBlockPath, select: true });
      });
      return;
    }
  }

  editor.tf.insertNodes(node, { select: true });
}
