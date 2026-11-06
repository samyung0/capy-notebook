import 'fake-indexeddb/auto';
import { get, set } from 'idb-keyval';
import { expect, it, vi } from 'vitest';
import {
  localDrawingDraft,
  localUndoPayload,
  saveLocalDrawingDraft,
} from './localDb';

const deleteAccountDrafts = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./editDrafts', () => ({ deleteAccountDrafts }));

import { claimAccountData, clearAccountData } from './accountData';
import { claimUndoPayloads, keepUndoPayloads } from './undoPayloads';

// Q315 (Epo 2026-10-24; privacy): the browser where an account's deletion is
// confirmed clears what it kept for it: the account's drafts (and only its
// own), the stored query cache and the agent Undo payloads. Fails if one of
// them stays.
it("clears the account's drafts and caches when its deletion is confirmed", async () => {
  await claimUndoPayloads('user_a');
  keepUndoPayloads([
    {
      actorUserId: 'u_1',
      documentId: 'mat_1',
      epoch: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      mac: 'f'.repeat(64),
      operationId: 'op_kept',
      updates: { content: 'dW5kbw==' },
    },
  ]);
  await set('capy-query-cache', { buster: 'x' });
  await vi.waitFor(async () =>
    expect(await localUndoPayload('op_kept')).toBeDefined()
  );
  await clearAccountData('u_a');
  expect(deleteAccountDrafts).toHaveBeenCalledWith('u_a');
  expect(await get('capy-query-cache')).toBeUndefined();
  expect(await localUndoPayload('op_kept')).toBeUndefined();
});

// A drawing answer still being drawn stays with its account: the same account
// signing in again keeps it, another account or a sign-out deletes it.
it('keeps a drawing draft for its account only', async () => {
  await claimAccountData('u_a');
  await saveLocalDrawingDraft({
    doc: 'Ym9hcmQ=',
    key: 'quiz:qz_1:p1',
    savedAt: new Date().toISOString(),
  });
  await claimAccountData('u_a');
  expect(await localDrawingDraft('quiz:qz_1:p1')).toBeDefined();
  await claimAccountData('u_b');
  expect(await localDrawingDraft('quiz:qz_1:p1')).toBeUndefined();
});
