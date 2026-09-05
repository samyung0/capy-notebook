import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  assertUpdatePreservesContributors,
  attachDocumentContributorTracker,
  clearDocumentContributors,
  documentContributors,
} from './contributors.js';

function origin(userId: string, access: 'shrink' | 'write' = 'write') {
  return {
    connection: {
      context: {
        access,
        expiresAt: Number.MAX_SAFE_INTEGER,
        tokenId: 'token',
        userId,
      },
    },
    source: 'connection',
  };
}

describe('durable collaboration contributors', () => {
  it('puts the actor marker in the same Yjs update as the content', () => {
    const document = new Y.Doc();
    const client = new Y.Doc();
    client.getText('content').insert(0, 'hello');
    attachDocumentContributorTracker(document, 'instance-a', () => 'nonce-a');
    let update: Uint8Array | undefined;
    document.on('update', (next) => {
      update = next;
    });

    Y.applyUpdate(document, Y.encodeStateAsUpdate(client), origin('u_a'));

    const peer = new Y.Doc();
    Y.applyUpdate(peer, update!);
    expect(peer.getText('content').toString()).toBe('hello');
    expect(documentContributors(peer)).toEqual([
      expect.objectContaining({
        access: 'write',
        nonce: 'nonce-a',
        userId: 'u_a',
      }),
    ]);
    client.destroy();
    document.destroy();
    peer.destroy();
  });

  it('rejects a client update that removes server-owned markers', () => {
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'instance-a', () => 'nonce-a');
    document.transact(
      () => document.getText('content').insert(0, 'a'),
      origin('u_a')
    );

    const attacker = new Y.Doc();
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
    const before = Y.encodeStateVector(attacker);
    const marker = documentContributors(attacker)[0];
    attacker.getMap('__capy_pending_contributors').delete(marker.key);
    const update = Y.encodeStateAsUpdate(attacker, before);

    expect(() => assertUpdatePreservesContributors(document, update)).toThrow(
      'client update changed collaboration metadata'
    );
    document.destroy();
    attacker.destroy();
  });

  it('rejects a client update that adds data to a server-owned marker', () => {
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'instance-a', () => 'nonce-a');
    document.transact(
      () => document.getText('content').insert(0, 'a'),
      origin('u_a')
    );

    const attacker = new Y.Doc();
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
    const before = Y.encodeStateVector(attacker);
    const marker = documentContributors(attacker)[0];
    attacker.getMap('__capy_pending_contributors').set(marker.key, {
      access: marker.access,
      junk: 'x'.repeat(100_000),
      nonce: marker.nonce,
      userId: marker.userId,
    });
    const update = Y.encodeStateAsUpdate(attacker, before);

    expect(() => assertUpdatePreservesContributors(document, update)).toThrow(
      'invalid collaboration contributor marker'
    );
    document.destroy();
    attacker.destroy();
  });

  it('rejects oversized marker values', () => {
    const document = new Y.Doc();
    document.getMap('__capy_pending_contributors').set('marker', {
      access: 'write',
      nonce: 'x'.repeat(129),
      userId: 'u_a',
    });

    expect(() => documentContributors(document)).toThrow(
      'invalid collaboration contributor marker'
    );
    document.destroy();
  });

  it('does not clear a newer contribution that arrived during a store', () => {
    const document = new Y.Doc();
    let nonce = 0;
    attachDocumentContributorTracker(document, 'instance-a', () =>
      String(++nonce)
    );
    document.transact(
      () => document.getText('content').insert(0, 'a'),
      origin('u_a')
    );
    const claimed = documentContributors(document);
    document.transact(
      () => document.getText('content').insert(1, 'b'),
      origin('u_a')
    );

    clearDocumentContributors(document, claimed);

    expect(documentContributors(document)).toEqual([
      expect.objectContaining({ nonce: '2', userId: 'u_a' }),
    ]);
    document.destroy();
  });
});
