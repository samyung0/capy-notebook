import {
  type RelativeRange,
  relativeRangeToSlateRange,
  type YjsEditor,
  YjsEditor as YjsEditorApi,
} from '@slate-yjs/core';
import type { TElement } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { useSyncExternalStore } from 'react';
import { m } from '@/i18n';

export interface AiTableUpdate {
  content: string;
  id: string;
}

export interface AiLocalPreview {
  insertAfterId?: string;
  kind: 'edit' | 'insert' | 'table';
  nodes?: TElement[];
  originalText: string;
  proposedText: string;
  tableUpdates?: AiTableUpdate[];
  targetRange?: RelativeRange;
}

const previews = new WeakMap<object, AiLocalPreview | null>();
const listeners = new WeakMap<object, Set<() => void>>();

function emit(editor: object) {
  for (const listener of listeners.get(editor) ?? []) listener();
}

export function getAiPreview(editor: object): AiLocalPreview | null {
  return previews.get(editor) ?? null;
}

export function setAiPreview(editor: object, preview: AiLocalPreview | null) {
  previews.set(editor, preview);
  emit(editor);
}

export function useAiPreview(editor: object) {
  return useSyncExternalStore(
    (listener) => {
      const current = listeners.get(editor) ?? new Set();
      current.add(listener);
      listeners.set(editor, current);
      return () => current.delete(listener);
    },
    () => getAiPreview(editor),
    () => null
  );
}

function nodeId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const id = (node as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

function findPath(
  nodes: unknown[],
  id: string,
  parent: number[] = []
): number[] | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const path = [...parent, index];
    if (nodeId(node) === id) return path;
    const children =
      node && typeof node === 'object'
        ? (node as { children?: unknown }).children
        : null;
    if (Array.isArray(children)) {
      const nested = findPath(children, id, path);
      if (nested) return nested;
    }
  }
  return null;
}

function withStableIds(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const value = structuredClone(node) as Record<string, unknown>;
  if (!('text' in value) && !nodeId(value)) value.id = crypto.randomUUID();
  if (Array.isArray(value.children)) {
    value.children = value.children.map(withStableIds);
  }
  return value;
}

export function applyAiPreview(editor: PlateEditor) {
  const preview = getAiPreview(editor);
  if (!preview) return;
  const yjsEditor = editor as PlateEditor & YjsEditor;
  const document = yjsEditor.sharedRoot?.doc;
  if (!yjsEditor.sharedRoot || !document) {
    throw new Error(m.editor_ai_not_ready());
  }

  let editRange: ReturnType<typeof relativeRangeToSlateRange> = null;
  if (preview.kind === 'edit') {
    if (!preview.targetRange) throw new Error(m.editor_ai_target_unavailable());
    editRange = relativeRangeToSlateRange(
      yjsEditor.sharedRoot,
      editor,
      preview.targetRange
    );
    if (!editRange) {
      throw new Error(m.editor_ai_text_changed());
    }
  }
  const insertPath =
    preview.kind === 'insert' && preview.insertAfterId
      ? findPath(editor.children, preview.insertAfterId)
      : null;
  if (preview.kind === 'insert' && !insertPath) {
    throw new Error(m.editor_ai_insert_changed());
  }
  for (const update of preview.tableUpdates ?? []) {
    if (!findPath(editor.children, update.id)) {
      throw new Error(m.editor_ai_cell_changed());
    }
  }

  document.transact(() => {
    editor.tf.withoutNormalizing(() => {
      if (preview.kind === 'edit' && editRange) {
        editor.tf.select(editRange);
        editor.tf.deleteFragment();
        editor.tf.insertText(preview.proposedText);
      }
      if (preview.kind === 'insert' && insertPath) {
        const at = [...insertPath];
        at[at.length - 1] += 1;
        editor.tf.insertNodes(
          (preview.nodes ?? []).map(withStableIds) as never,
          { at }
        );
      }
      for (const update of preview.tableUpdates ?? []) {
        const path = findPath(editor.children, update.id);
        if (!path) continue;
        const current = editor.api.node(path)?.[0] as TElement | undefined;
        if (!current) continue;
        editor.tf.removeNodes({ at: path });
        editor.tf.insertNodes(
          {
            ...current,
            children: [{ children: [{ text: update.content }], type: 'p' }],
          } as never,
          { at: path }
        );
      }
    });
    YjsEditorApi.flushLocalChanges(yjsEditor);
  }, 'ai-preview-accept');
  setAiPreview(editor, null);
}
