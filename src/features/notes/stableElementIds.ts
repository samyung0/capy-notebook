import { YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin, ElementApi } from 'platejs';

type EditorOperation = {
  node?: unknown;
  properties?: Record<string, unknown>;
  type: string;
};

function addStableIds(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const value = structuredClone(node) as Record<string, unknown>;
  if (ElementApi.isElement(value as never)) {
    if (typeof value.id !== 'string' || !value.id.trim()) {
      value.id = crypto.randomUUID();
    }
    if (Array.isArray(value.children)) {
      value.children = value.children.map(addStableIds);
    }
  }
  return value;
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
      if (local && operation.type === 'insert_node' && operation.node) {
        operation.node = addStableIds(operation.node);
      }
      if (
        local &&
        operation.type === 'split_node' &&
        typeof operation.properties?.id === 'string'
      ) {
        operation.properties = {
          ...operation.properties,
          id: crypto.randomUUID(),
        };
      }
      apply(operation);
    }) as typeof editor.apply;
    return editor;
  },
  key: 'capy-stable-element-ids',
});
