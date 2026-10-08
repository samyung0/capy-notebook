import { YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin, type Descendant, ElementApi } from 'platejs';

type EditorOperation = {
  node?: unknown;
  properties?: Record<string, unknown>;
  type: string;
};

function elementIds(nodes: Descendant[], ids = new Set<string>()) {
  for (const node of nodes) {
    if (!ElementApi.isElement(node)) continue;
    if (typeof node.id === 'string') ids.add(node.id);
    elementIds(node.children, ids);
  }
  return ids;
}

/** Give every element of an inserted subtree an id no other element of the
 * note has. `taken` lists the note's ids, built only when the subtree brings
 * ids of its own (a paste, a duplicate, an import). */
function addStableIds(
  value: Record<string, unknown>,
  taken: () => Set<string>
) {
  // Plate's NodeIdPlugin marks a node inserted with an id as `_id` and drops
  // the marker only from its own copy of the operation, not from the one
  // Slate-Yjs records. The store refuses it on interactive blocks.
  delete value._id;
  if (!ElementApi.isElement(value as never)) return;
  // NodeIdPlugin also replaces an id already in the note on its own copy only,
  // so the room got the duplicate and the store refused it.
  if (
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    taken().has(value.id)
  ) {
    value.id = crypto.randomUUID();
  } else {
    taken().add(value.id);
  }
  for (const child of value.children as Record<string, unknown>[])
    addStableIds(child, taken);
}

/**
 * Assign IDs in the Slate operation before Slate-Yjs records it. Remote Yjs
 * operations are never rewritten, because non-deterministic normalization on
 * each peer would diverge.
 */
export const stableElementIdsPlugin = createSlatePlugin({
  extendEditor: ({ editor }) => {
    const apply = editor.apply as (operation: EditorOperation) => void;
    editor.apply = ((operation: EditorOperation) => {
      const local = !YjsEditor.isYjsEditor(editor) || YjsEditor.isLocal(editor);
      if (
        local &&
        operation.type === 'insert_node' &&
        operation.node &&
        typeof operation.node === 'object'
      ) {
        const node = structuredClone(operation.node) as Record<string, unknown>;
        let ids: Set<string> | undefined;
        addStableIds(node, () => (ids ??= elementIds(editor.children)));
        operation.node = node;
      }
      if (local && operation.type === 'split_node' && operation.properties) {
        // Plate leaves `_id` on the node it inserted from (a duplicated
        // block), and a split copies the node's properties.
        const { _id, ...properties } = operation.properties;
        if (typeof properties.id === 'string')
          properties.id = crypto.randomUUID();
        operation.properties = properties;
      }
      apply(operation);
    }) as typeof editor.apply;
    return editor;
  },
  key: 'capy-stable-element-ids',
});
