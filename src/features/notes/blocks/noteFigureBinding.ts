import type { SlateEditor, TElement } from 'platejs';
import { localFigureBinding } from '@/features/questions/localFigureBinding';
import type { ChartBlock, GraphBlock } from '@/features/questions/types';

/**
 * A note's chart or graph as its dialog edits it (Epo 2026-11-16, D15): live,
 * as a quiz's is, with no draft. Each change is one Slate `set_node` of the
 * figure's `block` in the note's own editor, an ordinary note edit: bound to
 * the room, the figure codec writes only the entries that changed
 * (`writeFigure`), and the note's Undo, its saving and its unbound saved copy
 * take it as any other. Remove takes the element out. The element hands each
 * change of its block from elsewhere (a peer, an Undo) to `receive`; a
 * chart's series and labels go by place, as the plain block holds them.
 * Figures are top-level blocks, found by their id.
 */
export function noteFigureBinding(
  editor: SlateEditor,
  id: string,
  block: ChartBlock | GraphBlock
) {
  const path = () => {
    const at = editor.children.findIndex((node) => node.id === id);
    return at < 0 ? null : [at];
  };
  return localFigureBinding(block, {
    remove: () => {
      const at = path();
      if (at) editor.tf.removeNodes({ at });
    },
    write: (next) => {
      const at = path();
      if (at) editor.tf.setNodes({ block: next } as Partial<TElement>, { at });
    },
  });
}
