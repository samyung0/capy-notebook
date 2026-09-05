import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { CollaborationAccess, CollaborationContext } from './auth.js';

const CONTRIBUTORS_ROOT = '__capy_pending_contributors';
const CONTRIBUTOR_MARKER_KEYS = ['access', 'nonce', 'userId'] as const;
const MAX_CONTRIBUTOR_KEY_BYTES = 512;
const MAX_CONTRIBUTOR_NONCE_BYTES = 128;
const MAX_CONTRIBUTOR_USER_ID_BYTES = 255;

export interface DocumentContributor {
  access: Exclude<CollaborationAccess, 'comment'>;
  key: string;
  nonce: string;
  userId: string;
}

type TransactionOrigin = {
  connection?: { context?: CollaborationContext };
  context?: CollaborationContext;
  source?: string;
};

function writableContext(origin: unknown): CollaborationContext | null {
  if (!origin || typeof origin !== 'object') return null;
  const transactionOrigin = origin as TransactionOrigin;
  const context =
    transactionOrigin.source === 'connection'
      ? transactionOrigin.connection?.context
      : transactionOrigin.source === 'local'
        ? transactionOrigin.context
        : undefined;
  if (
    !context?.userId ||
    (context.access !== 'write' && context.access !== 'shrink')
  ) {
    return null;
  }
  return context;
}

function contributorValue(value: unknown): Omit<DocumentContributor, 'key'> {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid collaboration contributor marker');
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (
    keys.length !== CONTRIBUTOR_MARKER_KEYS.length ||
    keys.some((key, index) => key !== CONTRIBUTOR_MARKER_KEYS[index]) ||
    (marker.access !== 'write' && marker.access !== 'shrink') ||
    typeof marker.nonce !== 'string' ||
    marker.nonce.length === 0 ||
    Buffer.byteLength(marker.nonce, 'utf8') > MAX_CONTRIBUTOR_NONCE_BYTES ||
    typeof marker.userId !== 'string' ||
    marker.userId.length === 0 ||
    Buffer.byteLength(marker.userId, 'utf8') > MAX_CONTRIBUTOR_USER_ID_BYTES
  ) {
    throw new Error('invalid collaboration contributor marker');
  }
  return {
    access: marker.access,
    nonce: marker.nonce,
    userId: marker.userId,
  };
}

function markerSnapshot(document: Y.Doc) {
  return [...document.getMap<unknown>(CONTRIBUTORS_ROOT).entries()]
    .map(([key, value]) => {
      if (
        key.length === 0 ||
        Buffer.byteLength(key, 'utf8') > MAX_CONTRIBUTOR_KEY_BYTES
      ) {
        throw new Error('invalid collaboration contributor marker');
      }
      return { key, ...contributorValue(value) };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function documentContributors(document: Y.Doc): DocumentContributor[] {
  return markerSnapshot(document);
}

/**
 * Contributor markers are server-owned authorization metadata. A client may
 * observe them through Yjs sync, but its update must not add, replace, or
 * remove them.
 */
export function assertUpdatePreservesContributors(
  document: Y.Doc,
  update: Uint8Array
) {
  const before = JSON.stringify(markerSnapshot(document));
  const candidate = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    if (JSON.stringify(markerSnapshot(candidate)) !== before) {
      throw new Error('client update changed collaboration metadata');
    }
  } finally {
    candidate.destroy();
  }
}

/**
 * Yjs invokes this listener inside the same transaction that applies the
 * editor update. The marker therefore travels with that update across Redis;
 * a peer can never receive the content without its actor provenance.
 */
export function attachDocumentContributorTracker(
  document: Y.Doc,
  instanceId: string,
  nonce: () => string = randomUUID
) {
  document.on('beforeTransaction', (transaction: Y.Transaction) => {
    const context = writableContext(transaction.origin);
    if (!context) return;
    const key = `${instanceId}:${context.access}:${Buffer.from(context.userId).toString('base64url')}`;
    document.getMap<unknown>(CONTRIBUTORS_ROOT).set(key, {
      access: context.access,
      nonce: nonce(),
      userId: context.userId,
    });
  });
}

/** Remove only the marker generations represented by a committed snapshot. */
export function clearDocumentContributors(
  document: Y.Doc,
  contributors: readonly DocumentContributor[]
) {
  if (contributors.length === 0) return;
  document.transact(
    () => {
      const markers = document.getMap<unknown>(CONTRIBUTORS_ROOT);
      for (const contributor of contributors) {
        const current = markers.get(contributor.key);
        try {
          if (contributorValue(current).nonce === contributor.nonce) {
            markers.delete(contributor.key);
          }
        } catch {
          // Missing or malformed markers are handled by the next store. Do not
          // erase a newer generation merely because this snapshot committed.
        }
      }
    },
    { skipStoreHooks: true, source: 'local' }
  );
}

/** Delete claimed markers from the durable snapshot, retaining Yjs tombstones. */
export function removeDocumentContributors(
  document: Y.Doc,
  contributors: readonly DocumentContributor[]
) {
  const markers = document.getMap<unknown>(CONTRIBUTORS_ROOT);
  for (const contributor of contributors) markers.delete(contributor.key);
}
