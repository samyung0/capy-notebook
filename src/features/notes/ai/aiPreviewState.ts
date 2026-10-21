import {
  type RelativeRange,
  type YHistoryEditor,
  YjsEditor,
} from '@slate-yjs/core';
import {
  type Descendant,
  ElementApi,
  type Path,
  PathApi,
  type Point,
  type Range,
  RangeApi,
  type TElement,
} from 'platejs';
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

const emptyParagraph = (): Descendant =>
  ({ children: [{ text: '' }], type: 'p' }) as Descendant;

/** Markdown's plain text: a paragraph with no block properties of its own. */
function plainParagraph(node: Descendant): node is TElement {
  return (
    ElementApi.isElement(node) &&
    node.type === 'p' &&
    Object.keys(node).every(
      (key) => key === 'type' || key === 'children' || key === 'id'
    )
  );
}

/**
 * The preview's targets as the document reads now, or null when the text it
 * was for was removed entirely: an edit range whose block left the document
 * or whose text is all gone, an insert's block, every table cell. A table
 * cell removed alone is skipped.
 */
function liveTargets(
  editor: PlateEditor,
  preview: AiLocalPreview
): { after?: Path; cells: (Path | null)[]; range?: Range } | null {
  if (preview.kind === 'edit') {
    const range = preview.targetRange
      ? liveSlateRange(editor as PlateEditor & YjsEditor, preview.targetRange)
      : null;
    if (!range || (RangeApi.isCollapsed(range) && preview.originalText)) {
      return null;
    }
    return { cells: [], range };
  }
  if (preview.kind === 'insert') {
    const after = preview.insertAfterId
      ? findPath(editor.children, preview.insertAfterId)
      : null;
    return after ? { after, cells: [] } : null;
  }
  const cells = (preview.tableUpdates ?? []).map(({ id }) =>
    findPath(editor.children, id)
  );
  return cells.some(Boolean) ? { cells } : null;
}

/**
 * Writes `nodes` over `range`. An answer that keeps the range's block count
 * in plain paragraphs (Improve, Grammar and the like) replaces each block's
 * covered text, so every block keeps its type, properties, id and Yjs text: a
 * list item stays one, a peer's typing elsewhere in the block and comment
 * highlights in it stay. Any other answer goes in as a paste over the
 * deleted range, and a plain first paragraph that replaces a whole block
 * takes that block's type, properties and id.
 */
function writeOverRange(
  editor: PlateEditor,
  range: Range,
  nodes: Descendant[]
) {
  const start = RangeApi.start(range);
  const end = RangeApi.end(range);
  const blocks = editor.api.blocks({ at: range, mode: 'lowest' });
  if (
    blocks.length === nodes.length &&
    nodes.every(plainParagraph) &&
    blocks.every(([block]) => !editor.api.isVoid(block))
  ) {
    // Last first, so the earlier blocks' points stay valid.
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const [, path] = blocks[index];
      editor.tf.select({
        anchor: index === 0 ? start : (editor.api.start(path) as Point),
        focus:
          index === blocks.length - 1 ? end : (editor.api.end(path) as Point),
      });
      editor.tf.insertFragment((nodes[index] as TElement).children);
    }
    return;
  }
  const point = deleteRange(editor, range, blocks);
  const [block] = editor.api.block({ at: point }) ?? [];
  const [first, ...rest] = nodes;
  let fragment = nodes;
  if (block && editor.api.isEmpty(block)) {
    // The whole block was covered: the answer replaces it.
    const { children: _children, ...shape } = block;
    fragment = [
      plainParagraph(first)
        ? ({ ...shape, children: first.children } as Descendant)
        : ({ ...first, id: block.id } as Descendant),
      ...rest,
    ];
  }
  // As a paste: Plate's table and code-block insertFragment drop `at`.
  editor.tf.select(point);
  editor.tf.insertFragment(fragment);
}

/**
 * Deletes `range` and returns where it began. Its void blocks (an image, an
 * embed, a divider) go whole first: Slate's delete keeps a void at the
 * range's end, and insertFragment writes nothing there. A range of voids
 * alone leaves an empty paragraph in their place.
 */
function deleteRange(
  editor: PlateEditor,
  range: Range,
  blocks: [TElement, Path][]
): Point {
  const voids = blocks.filter(([block]) => editor.api.isVoid(block));
  const texts = blocks.filter(([block]) => !editor.api.isVoid(block));
  if (texts.length === 0) {
    const at = blocks[0][1];
    for (const [, path] of [...voids].reverse()) {
      editor.tf.removeNodes({ at: path });
    }
    editor.tf.insertNodes(emptyParagraph(), { at });
    return editor.api.start(at) as Point;
  }
  const [, firstPath] = texts[0];
  const [, lastPath] = texts.at(-1) as [TElement, Path];
  const [lastBlock] = blocks.at(-1) as [TElement, Path];
  const start = editor.api.isVoid(blocks[0][0])
    ? editor.api.start(firstPath)
    : RangeApi.start(range);
  const end = editor.api.isVoid(lastBlock)
    ? editor.api.end(lastPath)
    : RangeApi.end(range);
  const startRef = editor.api.pointRef(start as Point);
  const endRef = editor.api.pointRef(end as Point);
  for (const [, path] of [...voids].reverse()) {
    editor.tf.removeNodes({ at: path });
  }
  editor.tf.delete({
    at: { anchor: startRef.current as Point, focus: endRef.unref() as Point },
  });
  return startRef.unref() as Point;
}

/**
 * Writes the preview over its target as the target reads now, whatever
 * changed there since the preview (Epo 2026-10-21). It is applied once, by
 * local operations that slate-yjs sends in one transaction with its local
 * origin, so Undo reverts it in one step. When the text it was for was
 * removed entirely, the preview is dropped with no message (Epo 2026-10-21):
 * the removal is already visible. An answer with nothing to write throws.
 * True once the preview is done with (written or dropped); false when it was
 * rejected or replaced while it was converted.
 */
export async function applyAiPreview(editor: PlateEditor) {
  const preview = getAiPreview(editor);
  if (!preview) return false;
  const yjs = editor as PlateEditor & YHistoryEditor;
  if (!yjs.sharedRoot?.doc) throw new CopyError(m.editor_ai_not_ready());
  const drop = () => {
    setAiPreview(editor, null);
    return true;
  };
  // Earlier typing is sent first: the targets resolve against the room, and
  // the accept is an Undo step of its own.
  YjsEditor.flushLocalChanges(yjs);
  // Checked before the conversion too, which creates a fence's row.
  if (!liveTargets(editor, preview)) return drop();

  const nodes =
    preview.kind === 'table'
      ? []
      : await markdownNodes(editor, preview.proposedText);
  const cells = await Promise.all(
    (preview.tableUpdates ?? []).map(async ({ content }) => {
      // A cell the model emptied is written empty.
      const converted = content.trim()
        ? await markdownNodes(editor, content)
        : [];
      return converted.length ? converted : [emptyParagraph()];
    })
  );
  if (getAiPreview(editor) !== preview) return false;
  const targets = liveTargets(editor, preview);
  if (!targets) return drop();
  if (preview.kind !== 'table' && nodes.length === 0) {
    throw new CopyError(m.editor_ai_accept_failed());
  }

  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager.stopCapturing();
  editor.tf.withoutNormalizing(() => {
    if (targets.range) writeOverRange(editor, targets.range, nodes);
    if (targets.after) {
      editor.tf.insertNodes(nodes, { at: PathApi.next(targets.after) });
    }
    cells.forEach((children, index) => {
      const at = targets.cells[index];
      if (at) editor.tf.replaceNodes(children, { at, children: true });
    });
  });
  YjsEditor.flushLocalChanges(yjs);
  yjs.undoManager.stopCapturing();
  setAiPreview(editor, null);
  return true;
}
