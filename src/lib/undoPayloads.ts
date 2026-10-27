import { useEffect, useState } from 'react';
import type { UndoPayload } from '@/api/types';
import {
  claimLocalUndoPayloads,
  deleteLocalUndoPayloads,
  deleteLocalUndoPayloadsBefore,
  type LocalUndoPayload,
  localUndoPayload,
  localUndoPayloadsOwner,
  saveLocalUndoPayload,
} from './localDb';

/**
 * The chat keeps each agent step's Undo payload, exactly as the server sent
 * it, for a day from its agent edit (Epo 2026-10-21, Q385): in memory for this
 * tab, and in IndexedDB so the Undo survives a reload and the room closing.
 * IndexedDB that is blocked or missing (some private modes) leaves the memory
 * copy only. The payloads hold document content, so they are the signed-in
 * account's alone: another account or a sign-out deletes them (r1 M1), and
 * expired ones go when the account is claimed. A payload cannot apply across
 * a compaction, so once the browser sees its document in a newer lineage it
 * is dropped and its Undo hidden (Epo 2026-10-22, Q122).
 */

/** How long after its agent edit a payload is kept (the server's offer). */
export const UNDO_PAYLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The most one payload may hold, as the server bounds it (an 8 MiB update
 * in base64 and its envelope); a larger one is not kept. */
export const UNDO_PAYLOAD_MAX_CHARS = 12 * 1024 * 1024;

const kept = new Map<string, LocalUndoPayload>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function fresh(payload: LocalUndoPayload | undefined, now = Date.now()) {
  return payload && now < payload.issuedAt * 1000 + UNDO_PAYLOAD_LIFETIME_MS
    ? payload
    : undefined;
}

/** A payload as the server sends it: a step, document and actor id, an
 * epoch, its edit's time, base64 updates and a signature, within the size
 * bound. */
function valid(value: unknown): value is LocalUndoPayload {
  if (!value || typeof value !== 'object') return false;
  const {
    actorUserId,
    documentId,
    epoch,
    issuedAt,
    mac,
    operationId,
    updates,
  } = value as Record<string, unknown>;
  if (
    typeof operationId !== 'string' ||
    typeof actorUserId !== 'string' ||
    typeof documentId !== 'string' ||
    typeof mac !== 'string' ||
    typeof epoch !== 'number' ||
    typeof issuedAt !== 'number' ||
    !updates ||
    typeof updates !== 'object'
  )
    return false;
  let chars = 0;
  for (const update of Object.values(updates)) {
    if (typeof update !== 'string') return false;
    chars += update.length;
  }
  return chars <= UNDO_PAYLOAD_MAX_CHARS;
}

/** Drops one payload (or none) and every expired one from IndexedDB; a
 * storage failure leaves them to the next sweep. */
function drop(operationId: string | null) {
  deleteLocalUndoPayloads(
    operationId,
    (Date.now() - UNDO_PAYLOAD_LIFETIME_MS) / 1000
  ).catch(() => undefined);
}

/**
 * Runs when the signed-in account is known, before any read (r1 M1): the
 * payloads of another account (or all of them once signed out, `null`) are
 * deleted, here and in IndexedDB, and the account's expired ones go.
 */
export async function claimUndoPayloads(owner: string | null): Promise<void> {
  try {
    if (owner && (await localUndoPayloadsOwner()) === owner) {
      drop(null);
      return;
    }
    kept.clear();
    changed();
    await claimLocalUndoPayloads(owner);
  } catch {
    // Without IndexedDB nothing was stored.
    kept.clear();
    changed();
  }
}

/** Keeps the payloads a tool's end or an Undo's answer brought. */
export function keepUndoPayloads(payloads: readonly unknown[]) {
  for (const payload of payloads) {
    if (!valid(payload)) continue;
    const {
      actorUserId,
      documentId,
      epoch,
      issuedAt,
      mac,
      operationId,
      updates,
    } = payload;
    const record: LocalUndoPayload = {
      actorUserId,
      documentId,
      epoch,
      issuedAt,
      mac,
      operationId,
      updates,
    };
    kept.set(operationId, record);
    saveLocalUndoPayload(record).catch(() => undefined);
  }
  changed();
}

/** Forgets a used or refused step's payload. */
export function forgetUndoPayload(operationId: string) {
  kept.delete(operationId);
  drop(operationId);
  changed();
}

/** Drops the payloads of `documentId` made before lineage `epoch` (a
 * material's room schema, a source's epoch), here and in IndexedDB. */
export function retireUndoPayloads(documentId: string, epoch: number) {
  for (const [operationId, payload] of kept)
    if (payload.documentId === documentId && payload.epoch < epoch)
      kept.delete(operationId);
  deleteLocalUndoPayloadsBefore(documentId, epoch).catch(() => undefined);
  changed();
}

const ROOM_LINEAGE = /^(?:material|keys|source):([^:]+):(?:schema|epoch):(\d+)/;

/** A collaboration room name seen in a token or a session (`material:<id>:
 * schema:<n>`, a quiz's `keys:` room, `source:<id>:epoch:<n>`): its
 * document's older payloads go. */
export function sawRoom(room: string) {
  const found = ROOM_LINEAGE.exec(room);
  if (found) retireUndoPayloads(found[1], Number(found[2]));
}

/** The step's payload within its day; this tab's copy first, else
 * IndexedDB's. */
export async function undoPayload(
  operationId: string
): Promise<UndoPayload | undefined> {
  const now = Date.now();
  const held = fresh(kept.get(operationId), now);
  if (held) return held;
  kept.delete(operationId);
  let stored: LocalUndoPayload | undefined;
  try {
    stored = await localUndoPayload(operationId);
  } catch {
    return;
  }
  if (stored && !fresh(stored, now)) {
    drop(operationId);
    return;
  }
  if (stored) kept.set(operationId, stored);
  return stored;
}

/** The step's payload for a receipt (none for `undefined`), updated when one
 * is kept or forgotten. */
export function useUndoPayload(
  operationId: string | undefined
): UndoPayload | undefined {
  // This tab's copy at once, so a receipt shows its Undo without a flash.
  const [payload, setPayload] = useState<UndoPayload | undefined>(() =>
    operationId ? fresh(kept.get(operationId)) : undefined
  );
  useEffect(() => {
    if (!operationId) {
      setPayload(undefined);
      return;
    }
    let live = true;
    const read = () => {
      undoPayload(operationId).then((found) => {
        if (live) setPayload(found);
      });
    };
    read();
    listeners.add(read);
    return () => {
      live = false;
      listeners.delete(read);
    };
  }, [operationId]);
  return payload;
}
