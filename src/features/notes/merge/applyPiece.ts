import type { PlateEditor } from 'platejs/react';
import type { MaterialElement } from '@/features/materials/document';
import { asOneStep, replaceBlock } from './applyBlocks';
import { sameBlock } from './blockMerge';
import type { MergePiece, PieceChoice } from './types';

const indexOf = (editor: PlateEditor, id: string | null) =>
  id === null ? -1 : editor.children.findIndex((block) => block.id === id);

/**
 * Applies the user's choice for a piece on the bound note editor, as one
 * local Yjs transaction under the session's id and one Undo step
 * (applyBlocks.ts `asOneStep`). `shown` is the current block the user was
 * looking at: when the note's block is no longer it (someone changed it
 * since), nothing is applied and the piece shows the fresh one (`stale`,
 * first applied wins, Q229).
 * - `apply`: the user's version in place of the current block;
 * - `insert` (beside a current block) and `restore` (a block someone
 *   deleted): the user's version as a new block after the current one, else
 *   after the block before it in the user's version, else at the end; its id
 *   is returned to resolve the piece;
 * - `delete`: the current block goes (the user had deleted it).
 */
export function applyChoice(
  editor: PlateEditor,
  piece: MergePiece,
  choice: PieceChoice,
  shown: MaterialElement | undefined
): { result: 'stale' } | { insertedAs?: string; result: 'applied' } {
  const index = indexOf(editor, piece.block);
  const current =
    index < 0 ? undefined : (editor.children[index] as MaterialElement);
  if (current !== shown && !(current && shown && sameBlock(current, shown)))
    return { result: 'stale' };
  let insertedAs: string | undefined;
  asOneStep(editor, () => {
    if (choice === 'apply' && current && piece.mine)
      replaceBlock(editor, index, piece.mine);
    else if (choice === 'delete' && current)
      editor.tf.removeNodes({ at: [index] });
    else if ((choice === 'insert' || choice === 'restore') && piece.mine) {
      insertedAs = crypto.randomUUID();
      const anchor = index >= 0 ? index : indexOf(editor, piece.after);
      const at = index < 0 && anchor < 0 ? editor.children.length : anchor + 1;
      // Nested ids the note still holds are made new on insert
      // (stableElementIds); the top one is given here to resolve the piece.
      editor.tf.insertNodes({ ...piece.mine, id: insertedAs } as never, {
        at: [at],
      });
    }
  });
  return { insertedAs, result: 'applied' };
}
