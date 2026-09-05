import { Readable } from 'node:stream';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyCollaborationCommand } from './commands.js';
import {
  MAX_INTERNAL_COMMAND_BODY_BYTES,
  readInternalCommandJson,
} from './internalCommandRequest.js';

function documentWithValue(value: unknown[]) {
  const document = new Y.Doc();
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return document;
}

function value(document: Y.Doc) {
  return (
    yTextToSlateElement(document.get('content', Y.XmlText)) as {
      children: unknown[];
    }
  ).children;
}

describe('headless collaboration commands', () => {
  it('accepts two near-limit blocks but rejects oversized command bodies', async () => {
    const nearLimit = JSON.stringify({
      expectedBlock: 'a'.repeat(2 * 1024 * 1024 - 1024),
      replacementBlock: 'b'.repeat(2 * 1024 * 1024 - 1024),
    });
    await expect(
      readInternalCommandJson(Readable.from([nearLimit]))
    ).resolves.toBeDefined();
    const oversized = JSON.stringify({
      value: 'x'.repeat(MAX_INTERNAL_COMMAND_BODY_BYTES),
    });
    await expect(
      readInternalCommandJson(Readable.from([oversized]))
    ).rejects.toThrow('command body is too large');
  });

  it('replaces one stable block without replacing unrelated content', () => {
    const first = {
      children: [{ text: 'Keep me' }],
      id: 'first',
      type: 'p',
    };
    const quiz = {
      children: [{ children: [{ text: 'Old' }], id: 'q1', type: 'p' }],
      id: 'quiz',
      type: 'quiz',
    };
    const replacement = {
      ...quiz,
      children: [{ children: [{ text: 'New' }], id: 'q1', type: 'p' }],
    };
    const document = documentWithValue([first, quiz]);

    applyCollaborationCommand(document, {
      actorUserId: 'u_editor',
      expectedBlock: quiz,
      materialId: 'material-1',
      replacementBlock: replacement,
      room: 'material:material-1:schema:1',
      type: 'replace-block',
    });

    expect(value(document)).toEqual([first, replacement]);
  });

  it('rejects a stale block precondition', () => {
    const live = {
      children: [{ text: 'Concurrent' }],
      id: 'block',
      type: 'p',
    };
    const document = documentWithValue([live]);
    expect(() =>
      applyCollaborationCommand(document, {
        actorUserId: 'u_editor',
        expectedBlock: { ...live, children: [{ text: 'Old' }] },
        materialId: 'material-1',
        replacementBlock: { ...live, children: [{ text: 'Replacement' }] },
        room: 'material:material-1:schema:1',
        type: 'replace-block',
      })
    ).toThrow('changed concurrently');
  });
});
