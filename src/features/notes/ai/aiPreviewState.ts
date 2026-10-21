import {
  type RelativeRange,
  type YHistoryEditor,
  YjsEditor,
} from '@slate-yjs/core';
import { type Descendant, PathApi, RangeApi } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { useSyncExternalStore } from 'react';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { importMarkdownDocument } from '../documentAdapters';
import { liveSlateRange } from '../liveRange';
import { resolveImported } from '../pendingRefs';

export interface AiTableUpdate {
  content: string;
  id: string;
}

export interface AiLocalPreview {
  insertAfterId?: string;
  kind: 'edit' | 'insert' | 'table';
  originalText: string;
  /** The model's Markdown, converted on Accept. */
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

/** Markdown as note nodes through the editor's markdown import, as a pasted
 * file's: URL images upload (the AI menu only runs where assets may be
 * created), and quiz and flashcards fences become rows first. */
async function markdownNodes(editor: PlateEditor, markdown: string) {
  const { value } = importMarkdownDocument(editor, markdown, true);
  return resolveImported(value as Descendant[]);
}

/**
 * Writes the preview over its target as the target reads now, whatever
 * changed there since the preview (Epo 2026-10-21). It is applied once, by
 * local operations that slate-yjs sends in one transaction with its local
 * origin, so Undo reverts it in one step. A target whose block left the
 * document writes nothing and throws.
 */
export async function applyAiPreview(editor: PlateEditor) {
  const preview = getAiPreview(editor);
  if (!preview) return;
  const yjs = editor as PlateEditor & YHistoryEditor;
  if (!yjs.sharedRoot?.doc) throw new CopyError(m.editor_ai_not_ready());

  const nodes =
    preview.kind === 'table'
      ? []
      : await markdownNodes(editor, preview.proposedText);
  const cells = await Promise.all(
    (preview.tableUpdates ?? []).map(async ({ content, id }) => ({
      id,
      nodes: await markdownNodes(editor, content),
    }))
  );

  // Resolved after the conversion, which can wait on a fence's row.
  const range =
    preview.kind === 'edit' && preview.targetRange
      ? liveSlateRange(yjs, preview.targetRange)
      : null;
  const after =
    preview.kind === 'insert' && preview.insertAfterId
      ? findPath(editor.children, preview.insertAfterId)
      : null;
  const cellPaths = cells.map(({ id }) => findPath(editor.children, id));
  if (
    (preview.kind === 'edit' && !range) ||
    (preview.kind === 'insert' && !after) ||
    cellPaths.some((path) => !path)
  ) {
    throw new CopyError(m.editor_ai_target_removed());
  }

  // Earlier typing is sent first, so the accept is an Undo step of its own.
  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager.stopCapturing();
  editor.tf.withoutNormalizing(() => {
    if (range) {
      // A range covering a whole block is replaced by the fragment's blocks;
      // the first keeps that block's id, and with it the block's comments.
      const [block] = editor.api.block({ at: RangeApi.start(range) }) ?? [];
      const [first, ...rest] = nodes;
      // As a paste: Plate's table and code-block insertFragment drop `at`.
      editor.tf.select(range);
      editor.tf.insertFragment(
        first && block?.id ? [{ ...first, id: block.id }, ...rest] : nodes
      );
    }
    if (after) editor.tf.insertNodes(nodes, { at: PathApi.next(after) });
    cells.forEach((cell, index) => {
      editor.tf.replaceNodes(cell.nodes, {
        at: cellPaths[index] as number[],
        children: true,
      });
    });
  });
  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager.stopCapturing();
  setAiPreview(editor, null);
}
