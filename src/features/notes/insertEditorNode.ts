import { KEYS, NodeApi, type Path, RangeApi } from 'platejs';

// Plate's plugin-derived editor type includes transforms that are wider than
// the base editor type exported by platejs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NoteEditorInstance = any;

function isEmptyParagraph(editor: NoteEditorInstance, path: Path) {
  const block = editor.api.node(path)?.[0];
  return block?.type === editor.getType(KEYS.p) && NodeApi.string(block) === '';
}

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
    if (isEmptyParagraph(editor, currentBlockPath)) {
      editor.tf.withoutNormalizing(() => {
        editor.tf.removeNodes({ at: currentBlockPath });
        editor.tf.insertNodes(node, { at: currentBlockPath, select: true });
      });
      return;
    }
  }

  editor.tf.insertNodes(node, { select: true });
}

/**
 * Hold the place a block command ran for blocks whose data arrives later (a
 * round trip, a file read), while the user may keep typing or move elsewhere.
 * `insert` puts the top-level block, or blocks, there: over the command's
 * line while it is still an empty paragraph, otherwise after it (where the
 * line stood, if it was deleted). With `atCaret` (the toolbar's Import) they
 * go exactly where the selection was, replacing it and splitting the line as
 * an insert at the selection does, when nothing has touched the lines it
 * spans since; otherwise after the last of those lines, deleting nothing.
 * They take the caret only if the caret has not moved. Call `release` once
 * the wait settles.
 */
export function holdInsertPlace(
  editor: NoteEditorInstance,
  { atCaret = false } = {}
) {
  const selection = editor.selection;
  if (!selection)
    return {
      insert: (node: unknown) => insertEditorNode(editor, node),
      release: () => {},
    };
  const [start, end] = RangeApi.edges(selection);
  const index = start.path[0];
  const line = editor.api.pathRef([index]);
  const lastLine = editor.api.pathRef([end.path[0]]);
  // Any edit inside a line replaces its object; edits elsewhere keep it.
  const lines = editor.children.slice(index, end.path[0] + 1);
  const untouched = () =>
    !!line.current &&
    lines.every(
      (node: unknown, offset: number) =>
        editor.children[line.current![0] + offset] === node
    );
  // Typing at the caret moves the selection but not this ref.
  const caret = editor.api.rangeRef(selection, { affinity: 'backward' });
  return {
    insert(node: unknown) {
      const still =
        !!caret.current &&
        !!editor.selection &&
        RangeApi.equals(caret.current, editor.selection);
      if (still) editor.tf.focus();
      if (atCaret && caret.current && untouched()) {
        editor.tf.insertNodes(node, { at: caret.current, select: still });
        return;
      }
      editor.tf.withoutNormalizing(() => {
        let at: Path;
        if (
          !atCaret &&
          line.current &&
          isEmptyParagraph(editor, line.current)
        ) {
          at = [line.current[0]];
          editor.tf.removeNodes({ at });
        } else {
          const after = lastLine.current ?? line.current;
          at = after
            ? [after[0] + 1]
            : [Math.min(index, editor.children.length)];
        }
        editor.tf.insertNodes(node, { at, select: still });
      });
    },
    release() {
      line.unref();
      lastLine.unref();
      caret.unref();
    },
  };
}
