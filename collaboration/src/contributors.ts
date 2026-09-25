import { randomInt, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { CollaborationAccess, CollaborationContext } from './auth.js';

const CONTRIBUTORS_ROOT = '__capy_pending_contributors';
const CONTRIBUTOR_MARKER_KEYS = ['access', 'nonce', 'userId'] as const;
const MAX_CONTRIBUTOR_KEY_BYTES = 512;
const MAX_CONTRIBUTOR_NONCE_BYTES = 128;
const MAX_CONTRIBUTOR_USER_ID_BYTES = 255;

export interface DocumentContributor {
  access: Exclude<CollaborationAccess, 'comment' | 'read'>;
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
 * remove them. The check reads the decoded update against the room instead of
 * applying it to a copy: structs the room already holds are skipped, a new
 * struct may not sit in the marker map (named root, or an origin in it), and
 * the delete set may not cover a live marker.
 */
export function assertUpdatePreservesContributors(
  document: Y.Doc,
  update: Uint8Array
) {
  const markers = document.getMap<unknown>(CONTRIBUTORS_ROOT);
  const held = (client: number) => Y.getState(document.store, client);
  const inMarkers = (id: Y.ID | null) =>
    !!id &&
    id.clock < held(id.client) &&
    (Y.getItem(document.store, id) as Y.Item).parent === markers;
  const { structs, ds } = Y.decodeUpdate(update);
  for (const struct of structs) {
    if (
      !(struct instanceof Y.Item) ||
      struct.id.clock + struct.length <= held(struct.id.client)
    )
      continue;
    // Decoded items name a root parent by string; others resolve via origins.
    if (
      (struct.parent as unknown) === CONTRIBUTORS_ROOT ||
      inMarkers(struct.origin) ||
      inMarkers(struct.rightOrigin)
    )
      throw new Error('client update changed collaboration metadata');
  }
  for (const item of markers._map.values()) {
    if (!item.deleted && Y.isDeleted(ds, item.id))
      throw new Error('client update changed collaboration metadata');
  }
}

function freshClientId(document: Y.Doc) {
  let id: number;
  do id = randomInt(2 ** 32);
  while (id === document.clientID || document.store.clients.has(id));
  return id;
}

/**
 * Yjs invokes this listener inside the same transaction that applies the
 * editor update. The marker therefore travels with that update across Redis;
 * a peer can never receive the content without its actor provenance.
 *
 * Markers are written under a dedicated client id and the room's own id is
 * restored at once, so a remote transaction never advances the room's id
 * (which makes Yjs pick a new one and leave a fresh client per update). An
 * update that writes under the marker id moves the markers to a new one.
 */
export function attachDocumentContributorTracker(
  document: Y.Doc,
  instanceId: string,
  nonce: () => string = randomUUID
) {
  let markerClient = freshClientId(document);
  const written = new WeakMap<Y.Transaction, number>();
  document.on('beforeTransaction', (transaction: Y.Transaction) => {
    const context = writableContext(transaction.origin);
    if (!context) return;
    const key = `${instanceId}:${context.access}:${Buffer.from(context.userId).toString('base64url')}`;
    const roomClient = document.clientID;
    document.clientID = markerClient;
    try {
      document.getMap<unknown>(CONTRIBUTORS_ROOT).set(key, {
        access: context.access,
        nonce: nonce(),
        userId: context.userId,
      });
    } finally {
      document.clientID = roomClient;
    }
    written.set(transaction, Y.getState(document.store, markerClient));
  });
  document.on('afterTransactionCleanup', (transaction: Y.Transaction) => {
    const clock = written.get(transaction);
    if (
      clock !== undefined &&
      transaction.afterState.get(markerClient) !== clock
    )
      markerClient = freshClientId(document);
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
