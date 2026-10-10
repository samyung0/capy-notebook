import { YjsEditor } from '@slate-yjs/core';
import {
  NodeApi,
  type Operation,
  type Path,
  type SlateEditor,
  type TElement,
} from 'platejs';
import * as Y from 'yjs';
import { blockSource } from '@/features/materials/liveMermaid';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';

/**
 * A mermaid block is void, yet its child is the caption element rather than a
 * text leaf. slate-react maps a DOM selection inside a void to [void, 0], the
 * caption element, which crashes marks() and the Yjs cursor. Points that land
 * on the caption element move onto its text.
 */
export function fixMermaidSelection<O extends Operation>(
  editor: SlateEditor,
  operation: O
): O {
  if (operation.type !== 'set_selection' || !operation.newProperties)
    return operation;
  const next = { ...operation.newProperties };
  for (const edge of ['anchor', 'focus'] as const) {
    const point = next[edge];
    const node = point && NodeApi.get<TElement>(editor, point.path);
    if (point && node?.type === 'mermaid_caption')
      next[edge] = editor.api.start(point.path) ?? point;
  }
  return { ...operation, newProperties: next };
}

/**
 * A mermaid block inserted without a theme (slash command, paste, import, AI
 * edit) takes its creator's default, so every viewer sees the same theme.
 */
export function stampMermaidTheme<O extends Operation>(
  operation: O,
  theme: MermaidTheme
): O {
  if (
    operation.type !== 'insert_node' ||
    (operation.node as TElement).type !== 'mermaid' ||
    (operation.node as TElement).theme
  )
    return operation;
  return { ...operation, node: { ...operation.node, theme } };
}

/** The source text (shape A) of the top-level mermaid block `id` in the
 * note's shared document, for its dialog to edit live. Null outside a
 * collaborative editor. */
export function mermaidSourceText(
  editor: SlateEditor,
  id: string
): Y.Text | null {
  if (!YjsEditor.isYjsEditor(editor)) return null;
  for (const op of editor.sharedRoot.toDelta() as { insert: unknown }[]) {
    const block = op.insert;
    if (
      block instanceof Y.XmlText &&
      block.getAttribute('type') === 'mermaid' &&
      block.getAttribute('id') === id
    )
      return blockSource(block);
  }
  return null;
}

/** Replaces the caption text of the mermaid block at `at`. */
export function setMermaidCaption(editor: SlateEditor, at: Path, text: string) {
  const range = editor.api.range([...at, 0]);
  if (range) editor.tf.insertText(text, { at: range, voids: true });
}
