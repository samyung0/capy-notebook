import {
  createSlatePlugin,
  KEYS,
  NodeApi,
  type Path,
  RangeApi,
  type SlateEditor,
} from 'platejs';
import { seamGlue } from './mathTextValue';

const isParagraph = (editor: SlateEditor, index: number) =>
  editor.children[index]?.type === KEYS.p;

/** Takes a formula out. A display formula between two paragraphs joins them
 * back (`seamGlue`), as it reads as one block. */
export function removeFormula(editor: SlateEditor, at: Path) {
  const node = NodeApi.get(editor, at);
  const [index] = at;
  const joins =
    node?.type === KEYS.equation &&
    at.length === 1 &&
    isParagraph(editor, index - 1) &&
    isParagraph(editor, index + 1);
  if (!joins) {
    editor.tf.removeNodes({ at });
    return;
  }
  editor.tf.withoutNormalizing(() => {
    editor.tf.removeNodes({ at });
    const before = NodeApi.string(editor.children[index - 1]);
    const after = NodeApi.string(editor.children[index]);
    const seam = editor.api.end([index - 1]);
    if (!seam) return;
    const glue = seamGlue(before, after);
    if (glue) editor.tf.insertText(glue, { at: seam });
    editor.tf.mergeNodes({ at: [index] });
    editor.tf.select({ offset: seam.offset + glue.length, path: seam.path });
  });
}

/** Delete or Backspace on a display formula, or at the edge of the text
 * next to it, takes it out with `removeFormula`. */
export const FormulaJoinPlugin = createSlatePlugin({
  key: 'capy-formula-join',
}).overrideEditor(({ editor, tf: { deleteBackward, deleteForward } }) => {
  const formulaAt = (reverse: boolean): Path | undefined => {
    const { selection } = editor;
    if (!(selection && RangeApi.isCollapsed(selection))) return;
    const entry = editor.api.block({ highest: true });
    if (!entry) return;
    const [node, path] = entry;
    if (node.type === KEYS.equation) return path;
    const edge = reverse
      ? editor.api.isStart(selection.anchor, path)
      : editor.api.isEnd(selection.anchor, path);
    const next = reverse ? path[0] - 1 : path[0] + 1;
    if (edge && editor.children[next]?.type === KEYS.equation) return [next];
  };
  return {
    transforms: {
      deleteBackward(unit) {
        const at = formulaAt(true);
        if (at) removeFormula(editor, at);
        else deleteBackward(unit);
      },
      deleteForward(unit) {
        const at = formulaAt(false);
        if (at) removeFormula(editor, at);
        else deleteForward(unit);
      },
    },
  };
});
