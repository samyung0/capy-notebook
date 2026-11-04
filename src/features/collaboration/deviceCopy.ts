import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { api } from '@/api/client';
import type { Material } from '@/api/types';
import {
  claimSourceCache,
  type DeviceCopyRow,
  deviceCopyMaterials,
  dropDeviceCopies,
  prepareDeviceCopies,
  readDeviceCopy,
  storeDeviceCopy,
} from '@/lib/sourceCache';

/**
 * A device copy of an item (Epo 2026-11-04): the Yjs state its room confirmed,
 * kept in the same store and budget as the source bytes (`sourceCache.ts`), so
 * opening paints at once and the JOIN names what it holds, for the room to
 * answer the difference. It holds only confirmed state: written when nothing
 * is unsent, on hide and unmount, never per key, and dropped on any refusal, so
 * a discarded or refused edit never comes back. Everything keeps working
 * without it: a store can vanish at any time. Members keep copies, viewers
 * included, never someone who came through a link.
 */

/** A copy read for one open, its document already holding its state. */
export interface RoomSeed {
  doc: Y.Doc;
  room: string;
  row: DeviceCopyRow;
  version: number;
}

const SEED_ORIGIN = Symbol('seed');

/** Mock rooms reset on a reload, so only fixtures that outlive it keep copies
 * under MSW (their rooms do): a copy of a reset room would merge back into it. */
const keepsCopies = (materialId: string) =>
  !USE_MSW || materialId.startsWith('mock-scenario-');

/** Whether this person keeps copies of `material`: a member's. */
export const keepsCopyOf = ({
  id,
  isOwner,
  role,
}: Pick<Material, 'id' | 'isOwner' | 'role'>) =>
  keepsCopies(id) && (isOwner || !!role);

/** What a copy's row says beyond its room. */
export type CopyLabel = Pick<
  DeviceCopyRow,
  'kind' | 'owner' | 'standalone' | 'title'
>;

export const copyLabel = (
  material: Pick<Material, 'kind' | 'title' | 'workspaceId'>,
  owner: string
): CopyLabel => ({
  kind: material.kind,
  owner,
  standalone: !material.workspaceId,
  title: material.title,
});

/** The copy `owner` keeps, seeded into a new document; null without one or
 * when its bytes no longer read (it goes). */
export async function readRoomSeed(
  owner: string,
  materialId: string,
  document: DeviceCopyRow['document'] = 'content'
): Promise<RoomSeed | null> {
  if (!keepsCopies(materialId)) return null;
  // Under MSW no sign-in claims the store (AuthProvider).
  if (USE_MSW) await claimSourceCache(owner);
  const copy = await readDeviceCopy(owner, materialId, document);
  if (!copy) return null;
  const { state, ...row } = copy;
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state, SEED_ORIGIN);
  } catch {
    doc.destroy();
    void dropDeviceCopies(materialId, document);
    return null;
  }
  return { doc, room: row.room, row, version: row.version };
}

/** The copy of `materialId` read once for this mount: undefined until the read
 * settled, or forever without an `owner` yet. */
export function useRoomSeed(
  materialId: string,
  owner: string | null | undefined,
  document: DeviceCopyRow['document'] = 'content'
) {
  const [seed, setSeed] = useState<RoomSeed | null>();
  useEffect(() => {
    if (!owner) return;
    let current = true;
    void readRoomSeed(owner, materialId, document).then((read) => {
      if (current) setSeed(read);
      else read?.doc.destroy();
    });
    return () => {
      current = false;
    };
  }, [document, materialId, owner]);
  return seed;
}

interface Keep {
  /** Nothing of this device's is unsent. */
  clean: () => boolean;
  owner: string;
  /** What the row says now. */
  row: () => Omit<DeviceCopyRow, 'format' | 'size'>;
}

/**
 * Writes `doc` as its device copy when the tab hides or goes and whenever
 * `stop` runs, only if it changed since it was seeded or last written and only
 * while clean. One encode (30-80 ms on a near-limit note), on no typing path.
 */
export function keepDeviceCopy(doc: Y.Doc, { clean, owner, row }: Keep) {
  let changed = false;
  let stopped = false;
  // Under MSW no sign-in claims the store (AuthProvider).
  void (USE_MSW ? claimSourceCache(owner) : Promise.resolve()).then(() =>
    prepareDeviceCopies(owner)
  );
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin !== SEED_ORIGIN) changed = true;
  };
  const write = () => {
    if (!changed || stopped || !clean()) return;
    changed = false;
    void storeDeviceCopy(
      row(),
      Y.encodeStateAsUpdate(doc) as Uint8Array<ArrayBuffer>
    );
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') write();
  };
  doc.on('update', onUpdate);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', write);
  const stop = () => {
    stopped = true;
    doc.off('update', onUpdate);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', write);
  };
  return {
    /** The last write and the end of watching (a mount going). */
    close() {
      write();
      stop();
    },
    /** No more writes: the document holds what no copy may keep. */
    stop,
  };
}

/**
 * A copy of something this account can no longer read goes, once per page
 * load: a person who never connects to it again would keep it otherwise. Asked
 * in one request per 500 (the route's bound). Left for the next load when the
 * request fails.
 */
export async function sweepDeviceCopies(
  owner: string,
  readable: (ids: string[]) => Promise<string[]>
) {
  const ids = await deviceCopyMaterials(owner);
  for (let at = 0; at < ids.length; at += 500) {
    const asked = ids.slice(at, at + 500);
    const kept = new Set(await readable(asked));
    for (const id of asked) if (!kept.has(id)) await dropDeviceCopies(id);
  }
}

/** Runs the sweep once per page load per account, when the page is idle. */
export function useDeviceCopySweep(owner: string | undefined) {
  useEffect(() => {
    if (!owner || swept === owner) return;
    swept = owner;
    const run = () => {
      void sweepDeviceCopies(owner, async (ids) => {
        const answer = await api.post<{ ids: string[] }>(
          '/materials/readable',
          { ids }
        );
        return answer.ids;
      }).catch(() => undefined);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
    else setTimeout(run, 0);
  }, [owner]);
}

let swept: string | undefined;
