import { type YHistoryEditor, YjsEditor } from '@slate-yjs/core';
import type { Descendant } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import { DRAFT_EXPIRY_MS } from '@/lib/editDrafts';
import {
  type CopyPair,
  type MergeStep,
  mergeCopies,
  sameBlock,
} from './blockMerge';
import { piecesFromCopy } from './pieces';

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

type Node = Descendant & { children?: Descendant[]; text?: string };

const isText = (node: Node) => typeof node.text === 'string';

/** A text node's marks: every key but its text. */
const marks = ({ text: _text, ...rest }: Node) => rest;

/** Nodes one edit can turn into the other in place: texts with the same
 * marks, or elements of the same type. */
const alike = (a: Node, b: Node) =>
  isText(a)
    ? isText(b) && sameBlock(marks(a), marks(b), false)
    : !isText(b) && a.type === b.type;

const isHigh = (code: number) => code >= 0xd8_00 && code <= 0xdb_ff;
const isLow = (code: number) => code >= 0xdc_00 && code <= 0xdf_ff;

/** The one run that differs between two strings (their common prefix and
 * suffix kept), never splitting a surrogate pair. */
export function textChange(before: string, after: string) {
  const most = Math.min(before.length, after.length);
  let start = 0;
  while (start < most && before[start] === after[start]) start++;
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < most - start && before.at(-1 - end) === after.at(-1 - end))
    end++;
  if (end > 0 && isLow(before.charCodeAt(before.length - end))) end--;
  return {
    inserted: after.slice(start, after.length - end),
    offset: start,
    removed: before.slice(start, before.length - end),
  };
}

/** Sets and unsets an element's attributes to `wanted`'s; its id stays (the
 * block's own, Yjs-held ids below). */
function syncProps(
  editor: PlateEditor,
  at: number[],
  shown: Node,
  wanted: Node
) {
  const { children: _c, id: _id, ...props } = wanted as Record<string, unknown>;
  const { children: _s, id: _sid, ...old } = shown as Record<string, unknown>;
  const set = Object.fromEntries(
    Object.entries(props).filter(
      ([key, value]) => !sameBlock(value, old[key], false)
    )
  );
  const unset = Object.keys(old).filter(
    (key) => old[key] !== undefined && props[key] === undefined
  );
  if (Object.keys(set).length) editor.tf.setNodes(set, { at });
  if (unset.length) editor.tf.unsetNodes(unset, { at });
}

/**
 * Turns the children at `path` into `wanted` with as small edits as it can
 * (review r1 M3, Q397): when both have the same shape (as many nodes,
 * texts with the same marks, elements of the same type), each text's
 * changed run is deleted and inserted in place, so the Yjs items around it,
 * and the comment anchors and peers' carets on them, stay; otherwise the
 * children are replaced.
 */
function syncChildren(
  editor: PlateEditor,
  path: number[],
  shown: Node[],
  wanted: Node[]
) {
  if (sameBlock(shown, wanted, false)) return;
  if (
    shown.length !== wanted.length ||
    shown.some((node, index) => !alike(node, wanted[index]))
  ) {
    editor.tf.replaceNodes(wanted as never, { at: path, children: true });
    return;
  }
  wanted.forEach((node, index) => {
    const at = [...path, index];
    const old = shown[index];
    if (isText(node)) {
      const { inserted, offset, removed } = textChange(
        old.text as string,
        node.text as string
      );
      if (removed)
        editor.tf.apply({
          offset,
          path: at,
          text: removed,
          type: 'remove_text',
        });
      if (inserted)
        editor.tf.apply({
          offset,
          path: at,
          text: inserted,
          type: 'insert_text',
        });
      return;
    }
    syncProps(editor, at, old, node);
    syncChildren(
      editor,
      at,
      (old.children ?? []) as Node[],
      (node.children ?? []) as Node[]
    );
  });
}

/**
 * Puts `block` where the top-level block at `index` is. Of the same type the
 * block's element stays (its attributes set and unset, its id kept) and only
 * what differs inside it is rewritten (`syncChildren`), so its comment
 * threads and the anchors in its text stay; of another type it is removed
 * and `block` inserted at the same index, keeping its id.
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
  syncProps(editor, at, current as Node, block as Node);
  syncChildren(
    editor,
    at,
    current.children as Node[],
    block.children as Node[]
  );
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

/** A copy at the bind, with its last edit. */
export interface BoundCopy extends CopyPair {
  editedAt: number;
}

/**
 * The bind merge (Q229, Q408): the copies diffed against the editor's blocks
 * as bound and applied as one Undo step, in the same task, so nothing can
 * change a block between the diff and its step. A copy whose last edit is
 * past the 7-day expiry is never merged (Q412, Q421: the tab's own included)
 * and becomes pieces whole (`expired`). Returns whether a step applied, the
 * conflicts and the expired copies' pieces.
 */
export function mergeAtBind(
  editor: PlateEditor,
  copies: BoundCopy[],
  now = Date.now()
) {
  const live = copies.filter(
    ({ editedAt }) => now - editedAt <= DRAFT_EXPIRY_MS
  );
  const { conflicts, steps } = mergeCopies(
    live,
    editor.children as MaterialValue
  );
  if (steps.length) asOneStep(editor, () => applyMergeSteps(editor, steps));
  const value = editor.children as MaterialValue;
  const expired = copies
    .filter((copy) => !live.includes(copy))
    .flatMap((copy) => piecesFromCopy(copy, value, 'expired', now));
  return { applied: steps.length > 0, conflicts, expired };
}
