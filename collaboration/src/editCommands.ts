import { withYjs, YjsEditor, yTextToSlateElement } from '@slate-yjs/core';
import {
  createEditor,
  Editor,
  Node,
  type Path,
  type Point,
  Transforms,
} from 'slate';
import * as Y from 'yjs';
import { fullGuard, type GuardRun, guardsEqual, rangeGuard } from './guards.js';

/**
 * Direct AI content edits on a Plate material or a plain-text source.
 *
 * Commands name stable targets (block ids, child node ids) and the exact text
 * they expect. They are applied to an isolated Y.Doc built from the durable
 * state under the material lock; the caller commits the resulting state with
 * the receipt, the inverse commands and the post-edit guards in one
 * transaction. Nothing here talks to the database or the live room.
 */

export type EditErrorCode =
  | 'invalid_input'
  | 'stale_target'
  | 'unavailable_target'
  | 'unsupported_operation';

export class EditError extends Error {
  readonly code: EditErrorCode;
  constructor(
    code: EditErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.code = code;
  }
}

type PlateNode = Record<string, unknown> & { id?: string; type?: string };

export type DocumentCommand =
  | {
      type: 'replace_text';
      blockId?: string;
      expectedText: string;
      text: string;
      /** Set on inverses: replace exactly this span instead of searching. */
      offset?: number;
    }
  | { type: 'insert_block'; afterBlockId: string | null; blocks: PlateNode[] }
  | { type: 'remove_block'; blockId: string; expectedText: string }
  | {
      type: 'replace_child';
      parentType: string;
      nodeId: string;
      node: PlateNode;
    }
  | {
      type: 'insert_child';
      parentType: string;
      afterNodeId: string | null;
      node: PlateNode;
    }
  | { type: 'remove_child'; parentType: string; nodeId: string }
  | {
      type: 'set_property';
      nodeType: string;
      property: string;
      expectedValue: string;
      value: string;
    };

/** One guarded region after the edit: a block by id or the gap after a block. */
export type GuardTarget =
  | { kind: 'block'; blockId: string; runs: GuardRun[] }
  | { kind: 'gap'; afterBlockId: string | null; runs: GuardRun[] }
  | { kind: 'child'; parentId: string; nodeId: string; runs: GuardRun[] }
  | {
      kind: 'child_gap';
      parentId: string;
      afterNodeId: string | null;
      runs: GuardRun[];
    }
  | {
      kind: 'text';
      offset: number;
      length: number;
      /** The span's content after the edit, used to re-find a moved span. */
      text: string;
      runs: GuardRun[];
    }
  | {
      kind: 'office';
      id: string;
      path: string[];
      range?: [number, number];
      runs: GuardRun[];
    };

export interface EditOutcome {
  guards: GuardTarget[];
  /** Flashcard ids inserted by this edit. */
  insertedCardIds: string[];
  inverse: DocumentCommand[];
  /** Flashcard ids removed by this edit (their study rows need retaining). */
  removedCardIds: string[];
}

const MEDIA_TYPES = new Set([
  'img',
  'image',
  'video',
  'audio',
  'file',
  'media_embed',
  'youtube',
  'excalidraw',
]);

export const MAX_TEXT_EDIT_CHARS = 200_000;

function stableId(node: PlateNode): string {
  return typeof node.id === 'string' ? node.id : '';
}

function hasMedia(node: PlateNode): boolean {
  if (MEDIA_TYPES.has(String(node.type ?? '')) || 'assetId' in node)
    return true;
  const children = node.children;
  return (
    Array.isArray(children) &&
    children.some((child) => hasMedia(child as PlateNode))
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/** Slate point for a UTF-16 offset inside an element's concatenated text. */
function pointAt(editor: Editor, path: Path, offset: number): Point {
  let remaining = offset;
  let last: Point | null = null;
  for (const [text, textPath] of Node.texts(editor, { from: path, to: path })) {
    if (remaining <= text.text.length) {
      return { offset: remaining, path: textPath };
    }
    remaining -= text.text.length;
    last = { offset: text.text.length, path: textPath };
  }
  if (last && remaining === 0) return last;
  throw new EditError('stale_target', 'text offset is outside the target');
}

function topLevelEntry(
  editor: Editor,
  predicate: (node: PlateNode) => boolean
): [PlateNode, number] | null {
  const children = editor.children as unknown as PlateNode[];
  const index = children.findIndex((node) => predicate(node));
  return index < 0 ? null : [children[index], index];
}

function requireBlock(editor: Editor, blockId: string): [PlateNode, number] {
  const entry = topLevelEntry(editor, (node) => stableId(node) === blockId);
  if (!entry) {
    throw new EditError(
      'unavailable_target',
      `block ${blockId} no longer exists`
    );
  }
  return entry;
}

function requireParent(
  editor: Editor,
  parentType: string
): [PlateNode, number] {
  const entry = topLevelEntry(editor, (node) => node.type === parentType);
  if (!entry) {
    throw new EditError(
      'unavailable_target',
      `no ${parentType} block in this material`
    );
  }
  return entry;
}

function childIndex(parent: PlateNode, nodeId: string): number {
  const children = (parent.children as PlateNode[]) ?? [];
  return children.findIndex((child) => stableId(child) === nodeId);
}

/** Nearest of `candidates` (from the end) that still exists, else null. */
function surviving(
  candidates: string[],
  exists: (id: string) => boolean
): string | null {
  for (let i = candidates.length - 1; i >= 0; i--)
    if (exists(candidates[i])) return candidates[i];
  return null;
}

function assertNodeShape(node: PlateNode, what: string) {
  if (
    !node ||
    typeof node !== 'object' ||
    !stableId(node) ||
    typeof node.type !== 'string'
  ) {
    throw new EditError(
      'invalid_input',
      `${what} requires a typed node with a stable id`
    );
  }
  if (!Array.isArray(node.children)) {
    throw new EditError('invalid_input', `${what} requires children`);
  }
  if (hasMedia(node)) {
    throw new EditError(
      'unsupported_operation',
      'media nodes cannot be inserted by an edit'
    );
  }
}

/** Open a headless Slate editor bound to the document's Plate root. */
export function openHeadlessEditor(document: Y.Doc) {
  const sharedRoot = document.get('content', Y.XmlText);
  const baseEditor = createEditor();
  baseEditor.children = (
    yTextToSlateElement(sharedRoot) as { children: typeof baseEditor.children }
  ).children;
  const editor = withYjs(baseEditor, sharedRoot, { autoConnect: false });
  YjsEditor.connect(editor);
  return { editor, sharedRoot };
}

function blockGuard(
  sharedRoot: Y.XmlText,
  editor: Editor,
  blockId: string
): GuardTarget {
  const [, index] = requireBlock(editor, blockId);
  return {
    blockId,
    kind: 'block',
    runs: rangeGuard(sharedRoot, index, index + 1, 0),
  };
}

/** The nested Y.XmlText of the top-level element at `index`. */
function nestedTypeAt(root: Y.XmlText, index: number): Y.XmlText {
  let position = 0;
  for (let item = root._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    if (position + item.length > index) {
      const content = item.content;
      if (content instanceof Y.ContentType && content.type instanceof Y.XmlText)
        return content.type;
      break;
    }
    position += item.length;
  }
  throw new EditError('stale_target', 'the parent block is not an element');
}

function childGuard(
  sharedRoot: Y.XmlText,
  editor: Editor,
  parentId: string,
  nodeId: string
): GuardTarget {
  const [parent, index] = requireBlock(editor, parentId);
  const at = childIndex(parent, nodeId);
  if (at < 0)
    throw new EditError('unavailable_target', `${nodeId} no longer exists`);
  return {
    kind: 'child',
    nodeId,
    parentId,
    runs: rangeGuard(nestedTypeAt(sharedRoot, index), at, at + 1, 0),
  };
}

function childGapGuard(
  sharedRoot: Y.XmlText,
  editor: Editor,
  parentId: string,
  afterNodeId: string | null
): GuardTarget {
  const [parent, index] = requireBlock(editor, parentId);
  const at = afterNodeId === null ? 0 : childIndex(parent, afterNodeId) + 1;
  if (at <= 0 && afterNodeId !== null)
    throw new EditError(
      'unavailable_target',
      `${afterNodeId} no longer exists`
    );
  return {
    afterNodeId,
    kind: 'child_gap',
    parentId,
    runs: rangeGuard(nestedTypeAt(sharedRoot, index), at, at),
  };
}

function gapGuard(
  sharedRoot: Y.XmlText,
  editor: Editor,
  afterBlockId: string | null
): GuardTarget {
  const index =
    afterBlockId === null ? 0 : requireBlock(editor, afterBlockId)[1] + 1;
  return {
    afterBlockId,
    kind: 'gap',
    runs: rangeGuard(sharedRoot, index, index),
  };
}

/**
 * Apply commands to a material document. Each command validates against the
 * document as the earlier commands left it. A failing command leaves the
 * isolated document partially applied; callers discard it and roll back.
 */
export function applyMaterialCommands(
  document: Y.Doc,
  commands: DocumentCommand[]
): EditOutcome {
  if (!commands.length) throw new EditError('invalid_input', 'no commands');
  const { editor, sharedRoot } = openHeadlessEditor(document);
  const inverse: DocumentCommand[] = [];
  const guardTargets: Array<() => GuardTarget> = [];
  const removedCardIds: string[] = [];
  const insertedCardIds: string[] = [];
  try {
    Editor.withoutNormalizing(editor, () => {
      for (const command of commands) {
        switch (command.type) {
          case 'replace_text': {
            if (!command.blockId) {
              throw new EditError(
                'invalid_input',
                'replace_text on a material needs target_id'
              );
            }
            const [block, index] = requireBlock(editor, command.blockId);
            if (hasMedia(block) && Node.string(block as never).length === 0) {
              throw new EditError(
                'unsupported_operation',
                'this block holds media, not text'
              );
            }
            const current = Node.string(block as never);
            const span = resolveSpan(current, command);
            const start = pointAt(editor, [index], span.offset);
            const end = pointAt(editor, [index], span.offset + span.length);
            if (span.length > 0) {
              Transforms.delete(editor, { at: { anchor: start, focus: end } });
            }
            if (command.text)
              Transforms.insertText(editor, command.text, { at: start });
            inverse.unshift({
              blockId: command.blockId,
              expectedText: command.text,
              offset: span.offset,
              text: command.expectedText,
              type: 'replace_text',
            });
            const id = command.blockId;
            guardTargets.push(() => blockGuard(sharedRoot, editor, id));
            break;
          }
          case 'insert_block': {
            if (!command.blocks.length)
              throw new EditError('invalid_input', 'insert_block needs blocks');
            for (const block of command.blocks)
              assertNodeShape(block, 'insert_block');
            const index =
              command.afterBlockId === null
                ? 0
                : requireBlock(editor, command.afterBlockId)[1] + 1;
            for (const block of command.blocks) {
              if (
                topLevelEntry(
                  editor,
                  (node) => stableId(node) === stableId(block)
                )
              ) {
                throw new EditError(
                  'stale_target',
                  `block id ${stableId(block)} already exists`
                );
              }
            }
            Transforms.insertNodes(editor, command.blocks as never, {
              at: [index],
            });
            for (const block of [...command.blocks].reverse()) {
              inverse.unshift({
                blockId: stableId(block),
                expectedText: Node.string(block as never),
                type: 'remove_block',
              });
            }
            for (const block of command.blocks) {
              const id = stableId(block);
              guardTargets.push(() => blockGuard(sharedRoot, editor, id));
            }
            break;
          }
          case 'remove_block': {
            const [block, index] = requireBlock(editor, command.blockId);
            if (Node.string(block as never) !== command.expectedText) {
              throw new EditError(
                'stale_target',
                `block ${command.blockId} changed`
              );
            }
            if (hasMedia(block)) {
              throw new EditError(
                'unsupported_operation',
                'blocks holding media cannot be removed by an edit'
              );
            }
            if ((editor.children as unknown as PlateNode[]).length === 1) {
              throw new EditError(
                'unsupported_operation',
                'a material must keep at least one block'
              );
            }
            const before = (editor.children as unknown as PlateNode[])
              .slice(0, index)
              .map(stableId);
            const previous = before.at(-1) ?? null;
            Transforms.removeNodes(editor, { at: [index] });
            inverse.unshift({
              afterBlockId: previous,
              blocks: [block],
              type: 'insert_block',
            });
            // A later command in this call may remove the anchor too; the
            // gap is then guarded after the nearest block that survived.
            guardTargets.push(() =>
              gapGuard(
                sharedRoot,
                editor,
                surviving(before, (id) =>
                  Boolean(
                    topLevelEntry(editor, (node) => stableId(node) === id)
                  )
                )
              )
            );
            break;
          }
          case 'replace_child': {
            assertNodeShape(command.node, 'replace_child');
            const [parent, parentIndex] = requireParent(
              editor,
              command.parentType
            );
            const at = childIndex(parent, command.nodeId);
            if (at < 0)
              throw new EditError(
                'unavailable_target',
                `${command.nodeId} no longer exists`
              );
            if (stableId(command.node) !== command.nodeId) {
              throw new EditError(
                'invalid_input',
                'replacement must keep the node id'
              );
            }
            const current = (parent.children as PlateNode[])[at];
            Transforms.removeNodes(editor, { at: [parentIndex, at] });
            Transforms.insertNodes(editor, command.node as never, {
              at: [parentIndex, at],
            });
            inverse.unshift({
              node: current,
              nodeId: command.nodeId,
              parentType: command.parentType,
              type: 'replace_child',
            });
            const parentId = stableId(parent);
            const nodeId = command.nodeId;
            guardTargets.push(() =>
              childGuard(sharedRoot, editor, parentId, nodeId)
            );
            break;
          }
          case 'insert_child': {
            assertNodeShape(command.node, 'insert_child');
            const [parent, parentIndex] = requireParent(
              editor,
              command.parentType
            );
            if (childIndex(parent, stableId(command.node)) >= 0) {
              throw new EditError(
                'stale_target',
                `${stableId(command.node)} already exists`
              );
            }
            const at =
              command.afterNodeId === null
                ? 0
                : childIndex(parent, command.afterNodeId) + 1;
            if (at <= 0 && command.afterNodeId !== null) {
              throw new EditError(
                'unavailable_target',
                `${command.afterNodeId} no longer exists`
              );
            }
            Transforms.insertNodes(editor, command.node as never, {
              at: [parentIndex, at],
            });
            inverse.unshift({
              nodeId: stableId(command.node),
              parentType: command.parentType,
              type: 'remove_child',
            });
            if (command.parentType === 'flashcards')
              insertedCardIds.push(stableId(command.node));
            const parentId = stableId(parent);
            const nodeId = stableId(command.node);
            guardTargets.push(() =>
              childGuard(sharedRoot, editor, parentId, nodeId)
            );
            break;
          }
          case 'remove_child': {
            const [parent, parentIndex] = requireParent(
              editor,
              command.parentType
            );
            const at = childIndex(parent, command.nodeId);
            if (at < 0)
              throw new EditError(
                'unavailable_target',
                `${command.nodeId} no longer exists`
              );
            const children = parent.children as PlateNode[];
            if (children.length === 1) {
              throw new EditError(
                'unsupported_operation',
                `a ${command.parentType} block must keep one item`
              );
            }
            const current = children[at];
            const before = children.slice(0, at).map(stableId);
            const previous = before.at(-1) ?? null;
            Transforms.removeNodes(editor, { at: [parentIndex, at] });
            inverse.unshift({
              afterNodeId: previous,
              node: current,
              parentType: command.parentType,
              type: 'insert_child',
            });
            if (command.parentType === 'flashcards')
              removedCardIds.push(command.nodeId);
            const parentId = stableId(parent);
            guardTargets.push(() =>
              childGapGuard(
                sharedRoot,
                editor,
                parentId,
                surviving(
                  before,
                  (id) => childIndex(requireBlock(editor, parentId)[0], id) >= 0
                )
              )
            );
            break;
          }
          case 'set_property': {
            const [node, index] = requireParent(editor, command.nodeType);
            const current =
              typeof node[command.property] === 'string'
                ? String(node[command.property])
                : '';
            if (current !== command.expectedValue) {
              throw new EditError(
                'stale_target',
                `${command.nodeType}.${command.property} changed`
              );
            }
            Transforms.setNodes(
              editor,
              { [command.property]: command.value } as never,
              {
                at: [index],
              }
            );
            inverse.unshift({
              expectedValue: command.value,
              nodeType: command.nodeType,
              property: command.property,
              type: 'set_property',
              value: command.expectedValue,
            });
            const nodeId = stableId(node);
            guardTargets.push(() => blockGuard(sharedRoot, editor, nodeId));
            break;
          }
          default:
            throw new EditError('unsupported_operation', 'unsupported command');
        }
      }
    });
    YjsEditor.flushLocalChanges(editor);
    // Guards describe the committed state, so they are read after the flush.
    // A node a later command in this call removed needs no guard of its own:
    // that removal left a gap guard over the same region.
    const captured: GuardTarget[] = [];
    for (const target of guardTargets) {
      try {
        captured.push(target());
      } catch (error) {
        if (
          !(error instanceof EditError && error.code === 'unavailable_target')
        )
          throw error;
      }
    }
    const guards = dedupeGuards(captured);
    return { guards, insertedCardIds, inverse, removedCardIds };
  } finally {
    if (YjsEditor.connected(editor)) YjsEditor.disconnect(editor);
  }
}

function dedupeGuards(guards: GuardTarget[]): GuardTarget[] {
  const seen = new Set<string>();
  const out: GuardTarget[] = [];
  for (const guard of guards) {
    const key =
      guard.kind === 'block'
        ? `block:${guard.blockId}`
        : guard.kind === 'gap'
          ? `gap:${guard.afterBlockId ?? ''}`
          : guard.kind === 'child'
            ? `child:${guard.parentId}:${guard.nodeId}`
            : guard.kind === 'child_gap'
              ? `child_gap:${guard.parentId}:${guard.afterNodeId ?? ''}`
              : guard.kind === 'text'
                ? `text:${guard.offset}:${guard.length}`
                : `office:${guard.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(guard);
  }
  return out;
}

/**
 * Where a remembered span sits now: at its stored offset when the text still
 * matches there, else at its unique occurrence (earlier edits moved it), else
 * nowhere. An empty span can only be trusted at its offset.
 */
function anchorSpan(
  current: string,
  offset: number,
  expected: string
): number | null {
  if (current.slice(offset, offset + expected.length) === expected)
    return offset;
  if (!expected || countOccurrences(current, expected) !== 1) return null;
  return current.indexOf(expected);
}

function resolveSpan(
  current: string,
  command: { expectedText: string; offset?: number }
): { offset: number; length: number } {
  if (command.expectedText.length > MAX_TEXT_EDIT_CHARS) {
    throw new EditError('invalid_input', 'expected text is too long');
  }
  if (typeof command.offset === 'number') {
    const offset = anchorSpan(current, command.offset, command.expectedText);
    if (offset === null)
      throw new EditError('stale_target', 'the edited span changed');
    return { length: command.expectedText.length, offset };
  }
  if (!command.expectedText) {
    throw new EditError(
      'invalid_input',
      'expected_text must not be empty; include surrounding text'
    );
  }
  const occurrences = countOccurrences(current, command.expectedText);
  if (occurrences === 0) {
    throw new EditError(
      'stale_target',
      'expected text was not found in the target'
    );
  }
  if (occurrences > 1) {
    throw new EditError(
      'invalid_input',
      `expected text occurs ${occurrences} times; include more context`
    );
  }
  return {
    length: command.expectedText.length,
    offset: current.indexOf(command.expectedText),
  };
}

/** Recompute each guarded region on the current document and compare. */
export function verifyMaterialGuards(document: Y.Doc, guards: GuardTarget[]) {
  const { editor, sharedRoot } = openHeadlessEditor(document);
  try {
    for (const guard of guards) {
      let now: GuardRun[];
      try {
        now =
          guard.kind === 'block'
            ? blockGuard(sharedRoot, editor, guard.blockId).runs
            : guard.kind === 'gap'
              ? gapGuard(sharedRoot, editor, guard.afterBlockId).runs
              : guard.kind === 'child'
                ? childGuard(sharedRoot, editor, guard.parentId, guard.nodeId)
                    .runs
                : guard.kind === 'child_gap'
                  ? childGapGuard(
                      sharedRoot,
                      editor,
                      guard.parentId,
                      guard.afterNodeId
                    ).runs
                  : [];
      } catch (error) {
        if (error instanceof EditError) {
          // biome-ignore lint/style/useErrorCause: the cause is forwarded through EditError's options.
          throw new EditError(
            'stale_target',
            'an edited target no longer exists',
            { cause: error }
          );
        }
        throw error;
      }
      if (!guardsEqual(now, guard.runs)) {
        throw new EditError(
          'stale_target',
          'an edited target changed since this edit'
        );
      }
    }
  } finally {
    if (YjsEditor.connected(editor)) YjsEditor.disconnect(editor);
  }
}

/* ------------------------------------------------------------ text sources */

export interface TextEditOutcome {
  guards: GuardTarget[];
  inverse: DocumentCommand[];
}

/** Apply replace_text commands to a raw Y.Text source. */
export function applyTextCommands(
  document: Y.Doc,
  commands: DocumentCommand[]
): TextEditOutcome {
  if (!commands.length) throw new EditError('invalid_input', 'no commands');
  const text = document.getText('source');
  const inverse: DocumentCommand[] = [];
  const spans: Array<{ offset: number; length: number }> = [];
  document.transact(() => {
    for (const command of commands) {
      if (command.type !== 'replace_text') {
        throw new EditError(
          'unsupported_operation',
          'text sources support replace_text only'
        );
      }
      if (command.text.length > MAX_TEXT_EDIT_CHARS) {
        throw new EditError('invalid_input', 'replacement text is too long');
      }
      const current = text.toString();
      const span = resolveSpan(current, command);
      // Earlier spans keep describing the final text: those after this
      // replacement shift by its length change, overlaps are refused.
      const delta = command.text.length - span.length;
      for (const earlier of spans) {
        if (earlier.offset >= span.offset + span.length)
          earlier.offset += delta;
        else if (earlier.offset + earlier.length > span.offset)
          throw new EditError('invalid_input', 'commands overlap');
      }
      if (span.length) text.delete(span.offset, span.length);
      if (command.text) text.insert(span.offset, command.text);
      inverse.unshift({
        expectedText: command.text,
        offset: span.offset,
        text: command.expectedText,
        type: 'replace_text',
      });
      spans.push({ length: command.text.length, offset: span.offset });
    }
  });
  const current = text.toString();
  const guards: GuardTarget[] = spans.map((span) => ({
    kind: 'text',
    length: span.length,
    offset: span.offset,
    runs: textSpanGuard(text, span.offset, span.length),
    text: current.slice(span.offset, span.offset + span.length),
  }));
  return { guards, inverse };
}

/** A replaced span guards its own runs; a pure deletion needs a neighbour to be observable. */
function textSpanGuard(text: Y.Text, offset: number, length: number) {
  return rangeGuard(text, offset, offset + length, length ? 0 : 1);
}

export function verifyTextGuards(document: Y.Doc, guards: GuardTarget[]) {
  const text = document.getText('source');
  const current = text.toString();
  for (const guard of guards) {
    if (guard.kind !== 'text')
      throw new EditError('stale_target', 'guard does not fit a text source');
    const offset = anchorSpan(current, guard.offset, guard.text);
    if (
      offset === null ||
      !guardsEqual(textSpanGuard(text, offset, guard.length), guard.runs)
    ) {
      throw new EditError(
        'stale_target',
        'the edited text changed since this edit'
      );
    }
  }
}

/* ---------------------------------------------------------------- inspect */

export interface InspectedBlock {
  children?: Array<{ id: string; type: string; text: string }>;
  id: string;
  properties?: Record<string, string>;
  text: string;
  type: string;
}

/** Editable view of a material: top-level blocks with ids and flattened text. */
export function inspectMaterial(document: Y.Doc): InspectedBlock[] {
  const root = document.get('content', Y.XmlText);
  const value = (
    yTextToSlateElement(root) as unknown as { children: PlateNode[] }
  ).children;
  return value.map((block) => {
    const out: InspectedBlock = {
      id: stableId(block),
      text: Node.string(block as never),
      type: String(block.type ?? ''),
    };
    if (block.type === 'quiz' || block.type === 'flashcards') {
      out.children = ((block.children as PlateNode[]) ?? []).map((child) => ({
        id: stableId(child),
        text: Node.string(child as never),
        type: String(child.type ?? ''),
      }));
    }
    if (block.type === 'mermaid' && typeof block.source === 'string') {
      out.properties = { source: block.source };
    }
    if (hasMedia(block)) out.properties = { ...out.properties, media: 'true' };
    return out;
  });
}

const OFFICE_ERROR =
  /^(invalid_input|stale_target|unavailable_target|unsupported_operation): (.*)$/s;

/** Engine refusals cross the worker boundary as `<code>: message` strings. */
export function officeError(error: unknown): unknown {
  const match =
    error instanceof Error ? OFFICE_ERROR.exec(error.message) : null;
  return match ? new EditError(match[1] as EditErrorCode, match[2]) : error;
}

/**
 * Item runs at one engine-reported location. Stories are Y.Text values under
 * a root map (`stories`, `pptx:stories`); XLSX cells are entries of a nested
 * `contents` map, where every value ever written for the key counts.
 */
function officeRuns(
  document: Y.Doc,
  path: string[],
  range?: [number, number]
): GuardRun[] {
  let map: Y.Map<unknown> = document.getMap(path[0]);
  for (const key of path.slice(1, -1)) {
    const next = map.get(key);
    if (!(next instanceof Y.Map))
      throw new EditError('stale_target', 'the edited location is gone');
    map = next;
  }
  const key = path.at(-1);
  if (key === undefined) throw new EditError('invalid_input', 'empty path');
  if (range) {
    const text = map.get(key);
    if (!(text instanceof Y.Text))
      throw new EditError('stale_target', 'the edited story is gone');
    // A paragraph with text guards its own runs; an empty one needs a neighbour.
    return rangeGuard(text, range[0], range[1], range[1] > range[0] ? 0 : 1);
  }
  const runs: GuardRun[] = [];
  for (
    let item = map._map.get(key) ?? null;
    item !== null;
    item = item.left as Y.Item | null
  ) {
    const run: GuardRun = {
      client: item.id.client,
      clock: item.id.clock,
      len: item.length,
    };
    if (item.deleted) run.deleted = true;
    else if (item.content instanceof Y.ContentType)
      run.nested = fullGuard(item.content.type);
    runs.unshift(run);
  }
  return runs;
}

function officeDocument(state: Uint8Array): Y.Doc {
  const document = new Y.Doc({ gc: false });
  Y.applyUpdate(document, state);
  return document;
}

export function officeGuards(
  state: Uint8Array,
  targets: Array<{ id: string; path: string[]; range?: [number, number] }>
): GuardTarget[] {
  const document = officeDocument(state);
  try {
    return targets.map((target) => ({
      id: target.id,
      kind: 'office',
      path: target.path,
      ...(target.range ? { range: target.range } : {}),
      runs: officeRuns(document, target.path, target.range),
    }));
  } finally {
    document.destroy();
  }
}

/**
 * Story offsets move when earlier paragraphs change, so each guard is checked
 * at the location the engine reports for its stable id now, not the stored
 * one. A target the engine no longer finds is stale.
 */
export function verifyOfficeGuards(
  state: Uint8Array,
  guards: GuardTarget[],
  located: Array<{ id: string; path: string[]; range?: [number, number] }>
) {
  const document = officeDocument(state);
  try {
    for (const guard of guards) {
      if (guard.kind !== 'office')
        throw new EditError(
          'stale_target',
          'guard does not fit an Office source'
        );
      const target = located.find((item) => item.id === guard.id);
      if (!target)
        throw new EditError('stale_target', 'an edited target is gone');
      if (
        !guardsEqual(
          officeRuns(document, target.path, target.range),
          guard.runs
        )
      )
        throw new EditError(
          'stale_target',
          'the edited content changed since this edit'
        );
    }
  } finally {
    document.destroy();
  }
}
