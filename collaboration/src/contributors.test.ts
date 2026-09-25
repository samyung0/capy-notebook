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
      'client update changed collaboration metadata'
    );
    document.destroy();
    attacker.destroy();
  });

  // The room writes each update's marker at the marker client's next clock,
  // inside the transaction that applies the update, so these crafted updates
  // name that marker before it exists.
  function roomWithMarker() {
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'instance-a');
    document.transact(
      () => document.getText('content').insert(0, 'a'),
      origin('u_a')
    );
    const markers = document.getMap('__capy_pending_contributors');
    const marker = [...markers._map.values()][0].id.client;
    // Writes under the marker client at the clocks the room writes next.
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(document));
    forger.clientID = marker;
    return { document, forger };
  }

  it('rejects a delete range over marker clocks the room has not written', () => {
    const { document, forger } = roomWithMarker();
    forger.getText('scratch').insert(0, 'xxxxx');
    forger.getText('scratch').delete(0, 5);
    const deletes = Y.encodeStateAsUpdate(forger, Y.encodeStateVector(forger));
    const attacker = new Y.Doc();
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
    const known = Y.encodeStateVector(attacker);
    attacker.getText('content').insert(1, 'b');
    const update = Y.mergeUpdates([
      Y.encodeStateAsUpdate(attacker, known),
      deletes,
    ]);

    // Applied, the range would erase this update's marker and every later one.
    expect(() => assertUpdatePreservesContributors(document, update)).toThrow(
      'client update changed collaboration metadata'
    );
    for (const doc of [document, forger, attacker]) doc.destroy();
  });

  it('rejects items at or after marker clocks the room has not written', () => {
    const { document, forger } = roomWithMarker();
    const known = Y.encodeStateVector(document);
    forger.getMap('__capy_pending_contributors').set('next', {
      access: 'write',
      nonce: 'stand-in',
      userId: 'u_attacker',
    });
    const attacker = new Y.Doc();
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(forger));
    const beforeForge = Y.encodeStateVector(attacker);
    attacker.getMap('__capy_pending_contributors').set('next', {
      access: 'write',
      nonce: 'forged',
      userId: 'u_victim',
    });
    // Its origin is the marker the room is about to write, so it would
    // replace that marker's value.
    const forged = Y.encodeStateAsUpdate(attacker, beforeForge);
    expect(() => assertUpdatePreservesContributors(document, forged)).toThrow(
      'client update changed collaboration metadata'
    );
    forger.getText('content').insert(1, 'zz');
    const underMarkerClient = Y.encodeStateAsUpdate(forger, known);
    expect(() =>
      assertUpdatePreservesContributors(document, underMarkerClient)
    ).toThrow('client update changed collaboration metadata');
    for (const doc of [document, forger, attacker]) doc.destroy();
  });

  it('accepts a resent state that already holds markers and their deletions', () => {
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'instance-a', () => 'nonce-a');
    document.transact(
      () => document.getText('content').insert(0, 'a'),
      origin('u_a')
    );
    clearDocumentContributors(document, documentContributors(document));
    document.transact(
      () => document.getText('content').insert(1, 'b'),
      origin('u_a')
    );
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document));

    expect(() =>
      assertUpdatePreservesContributors(document, Y.encodeStateAsUpdate(client))
    ).not.toThrow();
    document.destroy();
    client.destroy();
  });

  it('writes markers under one client id that a collision moves', () => {
    const document = new Y.Doc();
    const room = document.clientID;
    attachDocumentContributorTracker(document, 'instance-a');
    const updateClients: number[][] = [];
    document.on('update', (update: Uint8Array) => {
      updateClients.push([
        ...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client)),
      ]);
    });
    const editor = new Y.Doc();
    const edit = (text: string) => {
      const known = Y.encodeStateVector(document);
      editor.getText('content').insert(0, text);
      Y.applyUpdate(
        document,
        Y.encodeStateAsUpdate(editor, known),
        origin('u_a')
      );
    };
    edit('a');
    edit('b');
    const marker = updateClients[0].find((id) => id !== editor.clientID);
    expect(marker).toBeDefined();
    expect(marker).not.toBe(room);
    for (const clients of updateClients)
      expect(clients.sort()).toEqual([editor.clientID, marker!].sort());

    // Another writer under the marker id in the same transaction.
    document.transact(() => {
      document.clientID = marker!;
      document.getText('content').insert(0, 'x');
      document.clientID = room;
    }, origin('u_b'));
    edit('c');
    expect(updateClients.at(-1)).not.toContain(marker);
    expect(document.clientID).toBe(room);
    document.destroy();
    editor.destroy();
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
