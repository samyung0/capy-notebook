import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { api } from '@/api/client';
import type { Material } from '@/api/types';
import {
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
 * under MSW (their rooms do), and the load-test notes, whose rooms reseed the
 * same state (bench/editor/scripts/open-paint.mjs): a copy of a reset room would
 * merge back into it. */
const keepsCopies = (materialId: string) =>
  !USE_MSW ||
  materialId.startsWith('mock-scenario-') ||
  import.meta.env.VITE_LOAD_TEST_SEED === 'true';

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

/** What a page keeps of a room: its seed (undefined until read), and its row's
 * label when this person keeps copies at all. */
export interface RoomCopy {
  keep?: CopyLabel;
  seed: RoomSeed | null | undefined;
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
    if (!(owner && materialId)) return;
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

/** The last material read kept on this device for an item (not a note, whose
 * copy is its room's): it paints before its read answers. Undefined until the
 * store answered, or forever without an `owner` yet. */
export function useMaterialCopy(
  materialId: string,
  owner: string | null | undefined
) {
  const [copy, setCopy] = useState<Material | null>();
  useEffect(() => {
    if (!owner) return;
    let current = true;
    if (!keepsCopies(materialId)) {
      setCopy(null);
      return;
    }
    void (async () => {
      const read = await readDeviceCopy(owner, materialId, 'read');
      if (!current) return;
      try {
        setCopy(
          read
            ? (JSON.parse(new TextDecoder().decode(read.state)) as Material)
            : null
        );
      } catch {
        setCopy(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [materialId, owner]);
  return copy;
}

/** Keeps the latest read of `material` on this device, on hide and as the page
 * leaves it, when it differs from what is stored. */
export function useKeepMaterialCopy(
  material: Material | undefined,
  owner: string | null | undefined,
  stored: Material | null | undefined
) {
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (!(material && owner && keepsCopyOf(material))) return;
    written.current ??= stored ? JSON.stringify(stored) : null;
    void prepareDeviceCopies(owner);
    const write = () => {
      const text = JSON.stringify(material);
      if (text === written.current) return;
      written.current = text;
      void storeDeviceCopy(
        {
          ...copyLabel(material, owner),
          document: 'read',
          materialId: material.id,
          room: '',
          version: 0,
        },
        new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') write();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', write);
    return () => {
      write();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', write);
    };
  }, [material, owner, stored]);
}

interface Keep {
  /** Nothing of this device's is unsent. */
  clean: () => boolean;
  owner: string;
  /** What the row says now. */
  row: () => Omit<DeviceCopyRow, 'format' | 'size'>;
  /** It starts from a copy: nothing to write until it changes. */
  seeded: boolean;
}

/**
 * Writes `doc` as its device copy when the tab hides or goes and whenever
 * `stop` runs, only if it changed since it was seeded or last written and only
 * while clean. One encode (30-80 ms on a near-limit note), on no typing path.
 */
export function keepDeviceCopy(
  doc: Y.Doc,
  { clean, owner, row, seeded }: Keep
) {
  let changed = !seeded;
  let stopped = false;
  void prepareDeviceCopies(owner);
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
