import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { assertUpdatePreservesContributors } from './contributors.js';
import {
  inboundYjsUpdate,
  yjsUpdateContainsChanges,
} from './yjsUpdateMessage.js';

function varUint(value: number): number[] {
  const encoded: number[] = [];
  let remaining = value;
  for (;;) {
    const next = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    encoded.push(remaining === 0 ? next : next | 0x80);
    if (remaining === 0) return encoded;
  }
}

function writableFrame(
  update: Uint8Array,
  syncMessageType: 1 | 2,
  messageType: 0 | 4 = 0
): Uint8Array {
  const name = new TextEncoder().encode('material:mat_1:schema:1');
  return Uint8Array.from([
    ...varUint(name.length),
    ...name,
    ...varUint(messageType),
    ...varUint(syncMessageType),
    ...varUint(update.length),
    ...update,
  ]);
}

function contributorRemovalUpdate(): { document: Y.Doc; update: Uint8Array } {
  const document = new Y.Doc();
  document.getText('content').insert(0, 'A');
  const contributors = document.getMap('__capy_pending_contributors');
  contributors.set('instance:write:alice', {
    access: 'write',
    nonce: 'nonce-alice',
    userId: 'alice',
  });

  const attacker = new Y.Doc();
  Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
  attacker.getText('content').insert(1, 'B');
  attacker.getMap('__capy_pending_contributors').delete('instance:write:alice');
  return {
    document,
    update: Y.encodeStateAsUpdate(attacker, Y.encodeStateVector(document)),
  };
}

describe('inboundYjsUpdate', () => {
  it.each([1, 2] as const)(
    'extracts and validates writable sync subtype %i',
    (syncMessageType) => {
      const { document, update } = contributorRemovalUpdate();
      const extracted = inboundYjsUpdate(
        writableFrame(update, syncMessageType)
      );
      expect(extracted).toEqual(update);
      expect(() =>
        assertUpdatePreservesContributors(document, extracted!)
      ).toThrow('client update changed collaboration metadata');
    }
  );

  it.each([1, 2] as const)(
    'accepts legitimate content in writable sync subtype %i',
    (syncMessageType) => {
      const document = new Y.Doc();
      document.getMap('__capy_pending_contributors').set('alice', {
        access: 'write',
        nonce: 'nonce-alice',
        userId: 'alice',
      });
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
      client.getText('content').insert(0, 'accepted');
      const update = Y.encodeStateAsUpdate(
        client,
        Y.encodeStateVector(document)
      );
      const extracted = inboundYjsUpdate(
        writableFrame(update, syncMessageType, 4)
      );
      expect(() =>
        assertUpdatePreservesContributors(document, extracted!)
      ).not.toThrow();
    }
  );

  it('ignores sync-step-1, non-sync, and malformed frames', () => {
    const empty = new Uint8Array();
    const stepOne = writableFrame(empty, 1);
    stepOne[stepOne.length - 2] = 0;
    const nonSync = writableFrame(empty, 2);
    nonSync[nonSync.length - 3] = 3;

    expect(inboundYjsUpdate(stepOne)).toBeNull();
    expect(inboundYjsUpdate(nonSync)).toBeNull();
    expect(inboundYjsUpdate(Uint8Array.from([0x80]))).toBeNull();
  });

  it('distinguishes a read-only sync acknowledgement from client changes', () => {
    const document = new Y.Doc();
    document.getText('content').insert(0, 'durable');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
    const acknowledgement = Y.encodeStateAsUpdate(
      client,
      Y.encodeStateVector(document)
    );
    expect(yjsUpdateContainsChanges(document, acknowledgement)).toBe(false);

    client.getText('content').insert(7, ' change');
    const change = Y.encodeStateAsUpdate(client, Y.encodeStateVector(document));
    expect(yjsUpdateContainsChanges(document, change)).toBe(true);
  });
});
