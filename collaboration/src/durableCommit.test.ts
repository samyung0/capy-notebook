import { expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  attachDocumentContributorTracker,
  documentContributors,
} from './contributors.js';
import { durableCommit } from './persistence.js';

function origin(userId: string) {
  return {
    connection: {
      context: {
        access: 'write',
        expiresAt: Number.MAX_SAFE_INTEGER,
        tokenId: 'token',
        userId,
      },
    },
    source: 'connection',
  };
}

test('a live-merged edit stores no contributor markers but leaves the room its own', () => {
  const live = new Y.Doc();
  attachDocumentContributorTracker(live, 'instance-a', () => 'nonce-a');
  live.transact(
    () => live.getText('content').insert(0, 'typed'),
    origin('u_b')
  );
  expect(documentContributors(live)).toHaveLength(1);
  const liveState = Y.encodeStateAsUpdate(live);

  const merged = new Y.Doc();
  Y.applyUpdate(merged, liveState);
  merged.getText('content').insert(5, ' by the agent');
  const { state, update } = durableCommit(merged, liveState);

  const durable = new Y.Doc();
  Y.applyUpdate(durable, state);
  expect(durable.getText('content').toString()).toBe('typed by the agent');
  expect(documentContributors(durable)).toEqual([]);

  Y.applyUpdate(live, update, 'service-edit');
  expect(live.getText('content').toString()).toBe('typed by the agent');
  expect(documentContributors(live)).toHaveLength(1);
});

test('without a live room the durable state is the delta', () => {
  const merged = new Y.Doc();
  merged.getText('content').insert(0, 'alone');
  const { state, update } = durableCommit(merged);
  expect(update).toBe(state);
});
