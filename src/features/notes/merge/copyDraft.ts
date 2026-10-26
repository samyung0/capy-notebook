import type { MaterialValue } from '@/features/materials/document';
import type { DraftRef } from '@/lib/draftStore';
import {
  DRAFT_EXPIRY_MS,
  deleteDrafts,
  type EditDraft,
  putDrafts,
} from '@/lib/editDrafts';

/**
 * A note shown from its saved copy before its room joins stays editable (Q229,
 * Epo 2026-10-24): its edits are kept on this device as a `copy` draft row,
 * JSON holding what the copy started from (`base`, the projection, and its
 * `revision`) and the edited value (`mine`). The editor merges it block by
 * block at the room's first sync (blockMerge.ts); a reopened note shows the
 * newest one's edited value and goes on with its row. Each tab owns the row
 * it records (a Web Lock named by its session, review r1 M1): another tab
 * never adopts, merges or deletes it. Blocks both sides changed become the
 * merge view's pieces. Copy rows expire 7 days after they were written, as
 * other drafts do, and then become pieces whole, never merged; no sweep
 * sends them.
 */
export interface NoteCopy {
  base: MaterialValue;
  mine: MaterialValue;
  revision: number;
}

export interface StoredCopy {
  copy: NoteCopy;
  row: EditDraft;
}

/** A note's live copy rows no open tab records: the newest, which its
 * editor shows and goes on with (`adopted`), and older ones (closed tabs'),
 * merged before it. */
export interface NoteCopies {
  adopted: StoredCopy | null;
  others: StoredCopy[];
}

export const NO_COPIES: NoteCopies = { adopted: null, others: [] };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parse(row: EditDraft): Partial<NoteCopy> | null {
  try {
    const value = JSON.parse(decoder.decode(row.data)) as Partial<NoteCopy>;
    return Array.isArray(value.mine) && Array.isArray(value.base)
      ? value
      : null;
  } catch {
    return null;
  }
}

const LOCK = 'capy-copy:';

/** Holds the lock of the copy session `session` while this tab records it
 * (review r1 M1); returns its release. Without Web Locks it holds nothing. */
export function holdCopy(session: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void navigator.locks
    ?.request(`${LOCK}${session}`, () => held)
    .catch(() => undefined);
  return () => release();
}

/** The copy sessions open tabs record now; null without Web Locks, when
 * none can be told apart. */
export async function heldCopies(): Promise<Set<string> | null> {
  if (!navigator.locks) return null;
  const { held = [] } = await navigator.locks.query();
  return new Set(
    held.flatMap(({ name }) =>
      name?.startsWith(LOCK) ? [name.slice(LOCK.length)] : []
    )
  );
}

/**
 * Splits a note's copy rows, leaving out those an open tab records (`held`):
 * the live ones (`copies`), those past the 7-day expiry (`expired`, which
 * become pieces) and rows that cannot be read (`unreadable`). Without Web
 * Locks (`held` null) no row is adopted: each one merges as an older copy.
 */
export function noteCopies(
  rows: EditDraft[],
  held: Set<string> | null,
  now = Date.now()
) {
  const live: StoredCopy[] = [];
  const expired: StoredCopy[] = [];
  const unreadable: EditDraft[] = [];
  for (const row of rows) {
    if (row.kind !== 'copy' || held?.has(row.session)) continue;
    const copy = parse(row) as NoteCopy | null;
    if (!copy) unreadable.push(row);
    else if (now - row.savedAt > DRAFT_EXPIRY_MS) expired.push({ copy, row });
    else live.push({ copy, row });
  }
  live.sort((a, b) => a.row.savedAt - b.row.savedAt);
  const adopted = held ? (live.pop() ?? null) : null;
  return {
    copies: adopted || live.length ? { adopted, others: live } : NO_COPIES,
    expired,
    unreadable,
  };
}

/** How often an edited copy is written at most. */
export const COPY_WRITE_MS = 1000;

/**
 * Records an editor's copy while it is edited before its room joins: the
 * edited value at most every COPY_WRITE_MS (`edited`), at once on `flush`
 * and on `stop`, which ends it and names the row written, if any. It goes on
 * with the adopted row (same id, a higher `seq`), so a reopened copy has
 * one row. A copy grown past `limitBytes` over its base (the offline bound
 * drafts keep, review r1 L2) is not written: `onLimit` locks the editor, and
 * `kept` is the last value written (null when none was).
 */
export function recordCopy({
  adopted,
  base,
  key,
  limitBytes,
  lineage,
  onLimit,
  revision,
}: {
  adopted: StoredCopy | null;
  base: MaterialValue;
  key: string;
  limitBytes: number;
  lineage: string;
  onLimit: () => void;
  revision: number;
}) {
  const row = adopted?.row;
  const session = row?.session ?? crypto.randomUUID();
  const id = row?.id ?? `${session}:copy`;
  let seq = row?.seq ?? 0;
  let written: DraftRef | null = row ? { id, key, seq } : null;
  let kept: MaterialValue | null = adopted?.copy.mine ?? null;
  // The base is the same in every write: encoded once.
  let baseJson: string | null = null;
  let baseBytes = 0;
  let latest: MaterialValue | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let over = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!latest || stopped || over) return;
    if (baseJson === null) {
      baseJson = JSON.stringify(base);
      baseBytes = encoder.encode(baseJson).length;
    }
    const data = encoder.encode(
      `{"base":${baseJson},"mine":${JSON.stringify(latest)},"revision":${revision}}`
    );
    // What the copy holds beyond its base.
    if (data.length - 2 * baseBytes > limitBytes) {
      over = true;
      latest = null;
      onLimit();
      return;
    }
    kept = latest;
    latest = null;
    seq += 1;
    written = { id, key, seq };
    void putDrafts([
      {
        data,
        id,
        key,
        kind: 'copy',
        lineage,
        savedAt: Date.now(),
        seq,
        session,
      },
    ]).catch((error) => console.warn('Draft storage failed:', error));
  };
  return {
    edited(value: MaterialValue) {
      if (stopped) return;
      latest = value;
      timer ??= setTimeout(flush, COPY_WRITE_MS);
    },
    flush,
    get kept() {
      return kept;
    },
    /** Past the bound: the value to merge is `kept`, not the editor's. */
    get over() {
      return over;
    },
    session,
    /** Writes what is pending (a throwing merge keeps it, review r1 L6),
     * then ends. */
    stop(): DraftRef | null {
      flush();
      stopped = true;
      return written;
    },
  };
}

export type CopyRecorder = ReturnType<typeof recordCopy>;

/**
 * Deletes rows whose content `stored` writes elsewhere (the blocks a merge
 * left, pieces), only once that write resolved (review r1 M2, Q397): a
 * failed write keeps the rows for the next open and tells the user
 * (`onLost`, the lost-drafts notice). Resolves whether it was stored.
 */
export async function deleteOnceStored(
  stored: Promise<unknown>,
  rows: DraftRef[],
  onLost: () => void
) {
  try {
    await stored;
  } catch (error) {
    console.warn('Draft storage failed:', error);
    onLost();
    return false;
  }
  await deleteDrafts(rows).catch((error) =>
    console.warn('Draft storage failed:', error)
  );
  return true;
}
