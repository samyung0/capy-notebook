import { isDeepStrictEqual } from 'node:util';
import { YjsEditor } from '@slate-yjs/core';
import { Editor, Element, Transforms } from 'slate';
import type * as Y from 'yjs';
import { openHeadlessEditor } from './editCommands.js';

export interface ReplaceBlockCommand {
  actorUserId: string;
  expectedBlock: Record<string, unknown>;
  expectedRevision?: number;
  materialId: string;
  replacementBlock: Record<string, unknown>;
  room: string;
  type: 'replace-block';
}

export type CollaborationCommand = ReplaceBlockCommand;

function stableId(node: Record<string, unknown>): string {
  return typeof node.id === 'string' ? node.id.trim() : '';
}

function assertReplacement(command: ReplaceBlockCommand) {
  const expectedId = stableId(command.expectedBlock);
  const replacementId = stableId(command.replacementBlock);
  if (!expectedId || expectedId !== replacementId) {
    throw new Error('replacement must preserve a stable block ID');
  }
  if (
    command.expectedBlock.type !== command.replacementBlock.type ||
    typeof command.expectedBlock.type !== 'string'
  ) {
    throw new Error('replacement must preserve the block type');
  }
  if (!Array.isArray(command.replacementBlock.children)) {
    throw new Error('replacement block requires children');
  }
}

export function applyCollaborationCommand(
  document: Y.Doc,
  command: CollaborationCommand
) {
  if (command.type !== 'replace-block') {
    throw new Error('unsupported collaboration command');
  }
  assertReplacement(command);
  const { editor } = openHeadlessEditor(document);
  try {
    const expectedId = stableId(command.expectedBlock);
    const entry = Editor.nodes(editor, {
      at: [],
      match: (node) =>
        Element.isElement(node) &&
        (node as unknown as Record<string, unknown>).id === expectedId,
    }).next().value;
    if (!entry) throw new Error('target block no longer exists');
    const [current, path] = entry;
    if (
      command.expectedRevision !== undefined &&
      !isDeepStrictEqual(current, command.expectedBlock)
    ) {
      throw new Error('target block changed concurrently');
    }
    if (isDeepStrictEqual(current, command.replacementBlock)) {
      return;
    }
    if (!isDeepStrictEqual(current, command.expectedBlock)) {
      throw new Error('target block changed concurrently');
    }
    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: path });
      Transforms.insertNodes(editor, command.replacementBlock as never, {
        at: path,
      });
    });
    YjsEditor.flushLocalChanges(editor);
  } finally {
    if (YjsEditor.connected(editor)) YjsEditor.disconnect(editor);
  }
}

export function isCollaborationCommand(
  value: unknown
): value is CollaborationCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<CollaborationCommand>;
  return (
    command.type === 'replace-block' &&
    (command.expectedRevision === undefined ||
      (Number.isSafeInteger(command.expectedRevision) &&
        command.expectedRevision > 0)) &&
    typeof command.actorUserId === 'string' &&
    command.actorUserId.length > 0 &&
    typeof command.materialId === 'string' &&
    typeof command.room === 'string' &&
    !!command.expectedBlock &&
    typeof command.expectedBlock === 'object' &&
    !!command.replacementBlock &&
    typeof command.replacementBlock === 'object'
  );
}
