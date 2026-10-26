import type { MaterialValue } from '@/features/materials/document';
import type { DraftRef } from '@/lib/draftStore';
import { DRAFT_EXPIRY_MS, type EditDraft, putDrafts } from '@/lib/editDrafts';

/**
 * A note shown from its saved copy before its room joins stays editable (Q229,
 * Epo 2026-10-24): its edits are kept on this device as a `copy` draft row,
 * JSON holding what the copy started from (`base`, the projection, and its
 * `revision`) and the edited value (`mine`). The editor merges it block by
 * block at the room's first sync (blockMerge.ts); a reopened note shows the
 * newest one's edited value and goes on with its row. Blocks both sides
 * changed become the merge view's pieces. Copy rows expire 7 days after they
 * were written, as other drafts do, and then become pieces whole, never
 * merged; no sweep sends them.
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

/** A note's live copy rows: the newest, which its editor shows and goes on
 * with (`adopted`), and older ones (another tab's), merged before it. */
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

/**
 * Splits a note's copy rows: the live ones (`copies`), those past the 7-day
 * expiry (`expired`, which become pieces) and rows that cannot be read
 * (`unreadable`).
 */
export function noteCopies(rows: EditDraft[], now = Date.now()) {
  const live: StoredCopy[] = [];
  const expired: StoredCopy[] = [];
  const unreadable: EditDraft[] = [];
  for (const row of rows) {
    if (row.kind !== 'copy') continue;
    const copy = parse(row) as NoteCopy | null;
    if (!copy) unreadable.push(row);
    else if (now - row.savedAt > DRAFT_EXPIRY_MS) expired.push({ copy, row });
    else live.push({ copy, row });
  }
  live.sort((a, b) => a.row.savedAt - b.row.savedAt);
  const adopted = live.pop() ?? null;
  return {
    copies: adopted ? { adopted, others: live } : NO_COPIES,
    expired,
    unreadable,
  };
}

/** How often an edited copy is written at most. */
export const COPY_WRITE_MS = 1000;

/**
 * Records an editor's copy while it is edited before its room joins: the
 * edited value at most every COPY_WRITE_MS (`edited`), at once on `flush`.
 * It goes on with the adopted row (same id, a higher `seq`), so a reopened
 * copy has one row. `stop` ends it and names the row written, if any.
 */
export function recordCopy({
  adopted,
  base,
  key,
  lineage,
  revision,
}: {
  adopted: EditDraft | null;
  base: MaterialValue;
  key: string;
  lineage: string;
  revision: number;
}) {
  const session = adopted?.session ?? crypto.randomUUID();
  const id = adopted?.id ?? `${session}:copy`;
  let seq = adopted?.seq ?? 0;
  let written: DraftRef | null = adopted ? { id, key, seq } : null;
  // The base is the same in every write: encoded once.
  let baseJson: string | null = null;
  let latest: MaterialValue | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!latest || stopped) return;
    baseJson ??= JSON.stringify(base);
    const data = encoder.encode(
      `{"base":${baseJson},"mine":${JSON.stringify(latest)},"revision":${revision}}`
    );
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
    stop(): DraftRef | null {
      stopped = true;
      clearTimeout(timer);
      latest = null;
      return written;
    },
  };
}

export type CopyRecorder = ReturnType<typeof recordCopy>;
