import { type YHistoryEditor, YjsEditor } from '@slate-yjs/core';
import type { PlateEditor } from 'platejs/react';
import type { MaterialElement } from '@/features/materials/document';
import { type MergeStep, sameBlock } from './blockMerge';

/**
 * Runs `edit` on the bound note editor as one local Yjs transaction under
 * the session's id and one Undo step, as an accepted AI preview does
 * (aiPreviewState.ts): what came before is flushed and closed first.
 */
export function asOneStep(editor: PlateEditor, edit: () => void) {
  const yjs = editor as unknown as YHistoryEditor;
  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager?.stopCapturing();
  editor.tf.withoutNormalizing(edit);
  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager?.stopCapturing();
}

const indexOf = (editor: PlateEditor, id: string) =>
  editor.children.findIndex((block) => block.id === id);

/**
 * Puts `block` where the top-level block at `index` is. Of the same type the
 * block's element stays (its attributes set and unset, its children
 * replaced), so its block-level comment threads stay with it; of another
 * type it is removed and `block` inserted at the same index, keeping its id.
 */
export function replaceBlock(
  editor: PlateEditor,
  index: number,
  block: MaterialElement
) {
  const at = [index];
  const current = editor.children[index] as MaterialElement;
  if (current.type !== block.type) {
    editor.tf.removeNodes({ at });
    editor.tf.insertNodes(block as never, { at });
    return;
  }
  const { children, id: _id, ...props } = block;
  const { children: shown, id: _shown, ...old } = current;
  const set = Object.fromEntries(
    Object.entries(props).filter(([key, value]) => !sameBlock(value, old[key]))
  );
  const unset = Object.keys(old).filter(
    (key) => old[key] !== undefined && props[key] === undefined
  );
  if (Object.keys(set).length) editor.tf.setNodes(set, { at });
  if (unset.length) editor.tf.unsetNodes(unset, { at });
  if (!sameBlock(children, shown))
    editor.tf.replaceNodes(children as never, { at, children: true });
}

/** Applies a merge's steps (blockMerge.ts) to the editor's top-level blocks,
 * finding each block by id as it goes. */
export function applyMergeSteps(editor: PlateEditor, steps: MergeStep[]) {
  for (const step of steps) {
    if (step.kind === 'set') {
      const index = indexOf(editor, step.id);
      if (index >= 0) replaceBlock(editor, index, step.block);
    } else if (step.kind === 'remove') {
      const index = indexOf(editor, step.id);
      if (index >= 0) editor.tf.removeNodes({ at: [index] });
    } else {
      const anchor = step.after === null ? -1 : indexOf(editor, step.after);
      const target =
        step.after !== null && anchor < 0 ? editor.children.length : anchor + 1;
      if (step.kind === 'insert') {
        editor.tf.insertNodes(step.block as never, { at: [target] });
        continue;
      }
      const from = indexOf(editor, step.id);
      if (from < 0) continue;
      // Slate's `to` is the index once the node left its place.
      const to = from < target ? target - 1 : target;
      if (to !== from) editor.tf.moveNodes({ at: [from], to: [to] });
    }
  }
}
