import { forgetPersistedQueries } from '@/api/queryPersistence';
import { deleteAccountDrafts } from './editDrafts';
import { claimSourceCache } from './sourceCache';
import { claimUndoPayloads } from './undoPayloads';

/**
 * What this browser keeps for the signed-in account beside the query cache:
 * the source bytes (sourceCache.ts) and the agent Undo payloads, which hold
 * document content (undoPayloads.ts). Claimed when the account is known,
 * before any read: another account's, or anyone's once signed out (`null`),
 * are deleted (r1 M1).
 */
export async function claimAccountData(owner: string | null): Promise<void> {
  await Promise.all([claimSourceCache(owner), claimUndoPayloads(owner)]);
}

/**
 * The browser where an account's deletion is confirmed clears what it kept
 * for it (Q315, Epo 2026-10-24): the account's unsent edit drafts, the stored
 * query cache, the source bytes and the agent Undo payloads. Another
 * account's drafts in this browser stay. A store that cannot be cleared is
 * left to the sign-out that follows.
 */
export async function clearAccountData(userId: string): Promise<void> {
  await Promise.all([
    deleteAccountDrafts(userId).catch(() => undefined),
    forgetPersistedQueries(),
    claimAccountData(null),
  ]);
}
