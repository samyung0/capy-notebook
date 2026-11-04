import { slateNodesToInsertDelta, YjsEditor } from '@slate-yjs/core';
import {
  createSlatePlugin,
  KEYS,
  NodeApi,
  nanoid,
  type Operation,
  OperationApi,
  TextApi,
  type TRange,
} from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { blockPoint, pointIn } from './roomSwap';

const synced = new WeakSet<object>();
const waiting = new WeakSet<object>();
const bound = new WeakMap<object, (unbound: unknown[]) => void>();
/** Made its first real edit since it bound. */
const edited = new WeakSet<object>();
/** A real edit since the last `takeLocalEdit`. */
const editing = new WeakSet<object>();
/** Writes the trailing paragraph outside Undo. */
const TRAILING_ORIGIN = Symbol('trailing');

/**
 * Whether normalizing with `op` leaves the room's document as it is: an empty
 * leaf beside an inline, or two leaves that read the same merging (Yjs holds
 * neither). Everything else slate-yjs would write.
 */
function writesNothing(editor: YjsEditor, op: Operation) {
  if (op.type === 'set_selection') return true;
  if (op.type === 'insert_node' || op.type === 'remove_node')
    return TextApi.isText(op.node) && op.node.text === '';
  if (op.type !== 'merge_node') return false;
  const at = op.path.at(-1) ?? 0;
  const node = NodeApi.get(editor as never, op.path);
  const before = at
    ? NodeApi.get(editor as never, [...op.path.slice(0, -1), at - 1])
    : null;
  return (
    TextApi.isText(node) && TextApi.isText(before) && sameMarks(node, before)
  );
}

function sameMarks(a: object, b: object) {
  const marks = (leaf: object) =>
    JSON.stringify({ ...leaf, text: undefined }, Object.keys(leaf).sort());
  return marks(a) === marks(b);
}

/**
 * Binds the note editor to its room's document (`YjsEditor.connect`) only
 * once the room has synced. Plate's init binds after waiting at most 5 s for
 * the sync; bound to a document the room had not filled yet, the editor
 * showed it empty, and Plate gave the empty editor a paragraph the document
 * never got, so after the sync the editor held one block more than the room
 * and every Yjs mapping of a point in it threw. A later sync binds here
 * (`bindSyncedRoom`). Until then the editor holds the note's last projection.
 *
 * Binding replaces the editor's whole tree. What the tree held before (the
 * saved copy, edited when the join failed, Q229) goes to the editor's
 * `whenBound` handler right after, which merges the copy's edits into the
 * room's tree as ordinary edits in the same task (Q408). A selection made
 * before it is then kept by block id where its block and text still exist,
 * as a room swap restores one, else dropped: left on the old paths it
 * pointed into nodes the room's tree lacks. Placed after the merge, it
 * lands in the merged text. Goes right after YjsPlugin.
 *
 * Opening never writes (Epo 2026-11-04): binding force-normalizes, and every
 * later remote change normalizes too, as local operations slate-yjs would send
 * to the room. A note ending in a table got its trailing paragraph that way
 * from whoever opened it, one each from two people opening together, and a
 * numbered list without its starts got them. So until the person's first real
 * edit only Slate's own normalizer runs, and only to repair what Yjs does not
 * hold (`writesNothing`); the rest waits for that edit, which normalizes the
 * blocks it touches and brings the trailing paragraph first, outside Undo
 * (`addTrailingParagraph`).
 */
export const roomBindingPlugin = createSlatePlugin({
  extendEditor: ({ editor }) => {
    if (!YjsEditor.isYjsEditor(editor)) return editor;
    const { apply, connect, normalize } = editor;
    const plate = editor as unknown as PlateEditor;
    // Slate's own normalizer and the plugins before this one: the plugins
    // after it (lists, tables, the trailing block, ...) wait for a real edit.
    // A pass of it with their writes dropped would not end: a list's start
    // normalizes again until it took.
    const repairOnly = editor.normalizeNode;
    let normalizing = 0;
    editor.normalize = (options) => {
      const gated = YjsEditor.connected(editor) && !edited.has(editor);
      const { normalizeNode } = editor;
      if (gated) editor.normalizeNode = repairOnly;
      normalizing += 1;
      try {
        normalize(options);
      } finally {
        normalizing -= 1;
        if (gated) editor.normalizeNode = normalizeNode;
      }
    };
    editor.apply = (op) => {
      const local = YjsEditor.isLocal(editor);
      if (normalizing) {
        if (
          local &&
          YjsEditor.connected(editor) &&
          !edited.has(editor) &&
          !writesNothing(editor, op as Operation)
        )
          return;
      } else if (
        op.type !== 'set_selection' &&
        (local || YjsEditor.origin(editor) === (editor as Undoable).undoManager)
      ) {
        if (local && YjsEditor.connected(editor) && !edited.has(editor)) {
          edited.add(editor);
          addTrailingParagraph(editor);
        }
        editing.add(editor);
      }
      apply(op);
    };
    editor.connect = () => {
      if (!synced.has(editor)) {
        waiting.add(editor);
        return;
      }
      waiting.delete(editor);
      const { selection } = editor;
      const kept = selection && {
        anchor: blockPoint(plate, selection.anchor),
        focus: blockPoint(plate, selection.focus),
      };
      const unbound = editor.children;
      editor.selection = null;
      connect();
      bound.get(editor)?.(unbound);
      const anchor = kept?.anchor && pointIn(plate, kept.anchor);
      const focus = kept?.focus && pointIn(plate, kept.focus);
      if (anchor && focus) plate.tf.select({ anchor, focus });
    };
    // Until the bind, Undo and Redo walk Slate's own history of the saved
    // copy (Q397): the Yjs history works on the bound document only.
    const { redo, undo } = plate;
    const history = (plate as unknown as { history: CopyHistory }).history;
    const walk = (from: Batch[], to: Batch[], back: boolean) => {
      const batch = from.pop();
      if (!batch) return;
      plate.tf.withoutSaving(() =>
        plate.tf.withoutNormalizing(() => {
          if (batch.selectionBefore) plate.tf.select(batch.selectionBefore);
          const ops = back
            ? batch.operations.map(OperationApi.inverse).reverse()
            : batch.operations;
          for (const op of ops) plate.tf.apply(op);
        })
      );
      to.push(batch);
    };
    plate.undo = () =>
      YjsEditor.connected(editor)
        ? undo()
        : walk(history.undos, history.redos, true);
    plate.redo = () =>
      YjsEditor.connected(editor)
        ? redo()
        : walk(history.redos, history.undos, false);
    return editor;
  },
  key: 'capy-room-binding',
});

interface Undoable {
  undoManager?: unknown;
}
interface Batch {
  operations: Operation[];
  selectionBefore: TRange | null;
}
interface CopyHistory {
  redos: Batch[];
  undos: Batch[];
}

/**
 * A note whose last block is no paragraph gets one (TrailingBlockPlugin's
 * rule), written straight into the document: as an ordinary edit it would
 * share the first edit's Undo step, and that Undo would bring it back as a new
 * edit, emptying Redo. Later ones stay the plugin's.
 */
function addTrailingParagraph(editor: YjsEditor) {
  const last = editor.children.at(-1) as { type?: string } | undefined;
  if (last?.type === KEYS.p) return;
  const root = editor.sharedRoot;
  const paragraph = { children: [{ text: '' }], id: nanoid(), type: KEYS.p };
  root.doc?.transact(
    () =>
      root.applyDelta(
        [
          { retain: root.length },
          ...slateNodesToInsertDelta([paragraph] as never),
        ],
        { sanitize: false }
      ),
    TRAILING_ORIGIN
  );
}

/** A click below the note's last block: its first real edit when the note
 * holds no paragraph there to click on, and the caret goes in it. */
export function openTrailingParagraph(plate: PlateEditor) {
  const editor = plate as unknown as YjsEditor;
  if (!YjsEditor.connected(editor)) return;
  const last = plate.children.at(-1) as { type?: string } | undefined;
  if (last?.type === KEYS.p) return;
  edited.add(editor);
  addTrailingParagraph(editor);
  plate.tf.select(plate.api.end([]));
  plate.tf.focus();
}

/** Whether a real edit (this person's, an Undo's) happened since the last
 * call: a change of value from a co-editor or a normalization holds none. */
export function takeLocalEdit(editor: object) {
  return editing.delete(editor);
}

/**
 * TrailingBlockPlugin's rule, only behind a real edit in this batch: a
 * co-editor's or an agent's change that leaves the note ending in a table
 * writes no paragraph from everyone who has it open.
 */
export const trailingBlockPlugin = createSlatePlugin({
  key: 'capy-trailing-block',
}).overrideEditor(({ editor, tf: { normalizeNode } }) => ({
  transforms: {
    normalizeNode([node, path]) {
      const last = editor.children.at(-1) as { type?: string } | undefined;
      if (path.length === 0 && editing.has(editor) && last?.type !== KEYS.p) {
        const at = [editor.children.length];
        editor.tf.insertNodes(editor.api.create.block({ type: KEYS.p }, at), {
          at,
        });
        return;
      }
      normalizeNode([node, path]);
    },
  },
}));

/** The room synced (the provider's first sync): a bind Plate tried before
 * it happens now. */
export function bindSyncedRoom(editor: object) {
  synced.add(editor);
  if (waiting.has(editor)) YjsEditor.connect(editor as YjsEditor);
}

/** `handler` runs once the editor is bound, with the tree binding replaced
 * (Q229: the copy's edits merge then, before the caret is placed). */
export function whenBound(
  editor: object,
  handler: (unbound: unknown[]) => void
) {
  bound.set(editor, handler);
}
