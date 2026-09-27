import { setColumns } from '@platejs/layout';
import {
  ElementApi,
  KEYS,
  type Path,
  type SlateEditor,
  TextApi,
} from 'platejs';

export function setColumnLayout(
  editor: SlateEditor,
  at: Path,
  widths: string[]
) {
  editor.tf.withoutNormalizing(() => {
    const group = editor.api.node(at)?.[0];
    if (!ElementApi.isElement(group)) return;

    // Plate merges removed columns into the last retained one. Discard a lone
    // empty paragraph first so repeated 2↔3 switches don't append blank lines.
    for (
      let index = group.children.length - 1;
      index >= widths.length;
      index--
    ) {
      const column = group.children[index];
      if (!ElementApi.isElement(column) || column.children.length !== 1)
        continue;
      const paragraph = column.children[0];
      if (
        ElementApi.isElement(paragraph) &&
        paragraph.type === editor.getType(KEYS.p) &&
        paragraph.children.length === 1 &&
        TextApi.isText(paragraph.children[0]) &&
        paragraph.children[0].text === ''
      ) {
        editor.tf.removeNodes({ at: [...at, index] });
      }
    }
    setColumns(editor, { at, widths });
  });
}
