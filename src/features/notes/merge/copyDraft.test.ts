import { afterEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({ puts: [] as unknown[][] }));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  putDrafts: vi.fn(async (rows: unknown[]) => {
    stored.puts.push(rows);
  }),
}));

import { DRAFT_EXPIRY_MS, type EditDraft } from '@/lib/editDrafts';
import { COPY_WRITE_MS, noteCopies, recordCopy } from './copyDraft';

/* Q229: a note's saved copy edited before its room joined is kept on the
 * device as a `copy` row of JSON. */

const KEY = 'u_1:material:m_1';
const ROOM = 'material:m_1:schema:1';
const p = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const decode = (row: EditDraft) =>
  JSON.parse(new TextDecoder().decode(row.data));

function copyRow(id: string, value: unknown, extra: Partial<EditDraft> = {}) {
  return {
    data: encode(value),
    id: `${id}:copy`,
    key: KEY,
    kind: 'copy',
    lineage: ROOM,
    savedAt: Date.now(),
    seq: 1,
    session: id,
    ...extra,
  } satisfies EditDraft;
}

afterEach(() => {
  vi.useRealTimers();
  stored.puts.length = 0;
});

describe('noteCopies', () => {
  it('shows the newest live copy, merges older ones before it, and splits conflicts, an expired copy and unreadable rows', () => {
    const now = Date.now();
    const copy = {
      base: [p('a', 'A')],
      mine: [p('a', 'A typed')],
      revision: 3,
    };
    const older = copyRow('older', copy, { savedAt: now - 2000 });
    const newer = copyRow('newer', copy, { savedAt: now - 1000 });
    const conflict = copyRow(
      'c',
      { mine: [p('b', 'B mine')] },
      { refused: true }
    );
    const expired = copyRow('x', copy, {
      savedAt: now - DRAFT_EXPIRY_MS - 1,
    });
    const broken = { ...copyRow('y', copy), data: new Uint8Array([123]) };
    const yjs = { ...copyRow('u', copy), kind: 'update' as const };
    const read = noteCopies(
      [newer, conflict, older, expired, broken, yjs],
      now
    );
    expect(read.copies.adopted?.row).toBe(newer);
    expect(read.copies.adopted?.copy).toEqual(copy);
    expect(read.copies.others.map(({ row }) => row)).toEqual([older]);
    expect(read.conflicts).toEqual({
      rows: [conflict],
      value: [p('b', 'B mine')],
    });
    expect(read.expired).toEqual({ row: expired, value: copy.mine });
    expect(read.unreadable).toEqual([broken]);
  });
});

describe('recordCopy', () => {
  it('writes the edited copy at most once a second, at once on flush, and stops with the row it wrote', async () => {
    vi.useFakeTimers();
    const recorder = recordCopy({
      adopted: null,
      base: [p('a', 'A')],
      key: KEY,
      lineage: ROOM,
      revision: 3,
    });
    recorder.edited([p('a', 'A t')]);
    recorder.edited([p('a', 'A ty')]);
    expect(stored.puts).toEqual([]);
    vi.advanceTimersByTime(COPY_WRITE_MS);
    expect(stored.puts).toHaveLength(1);
    const [first] = stored.puts[0] as EditDraft[];
    expect(first).toMatchObject({
      key: KEY,
      kind: 'copy',
      lineage: ROOM,
      seq: 1,
    });
    expect(decode(first)).toEqual({
      base: [p('a', 'A')],
      mine: [p('a', 'A ty')],
      revision: 3,
    });
    recorder.edited([p('a', 'A typed')]);
    recorder.flush();
    const [second] = stored.puts[1] as EditDraft[];
    expect(second).toMatchObject({ id: first.id, seq: 2 });
    expect(recorder.stop()).toEqual({ id: first.id, key: KEY, seq: 2 });
    recorder.edited([p('a', 'after')]);
    vi.advanceTimersByTime(COPY_WRITE_MS);
    expect(stored.puts).toHaveLength(2);
  });

  it('goes on with the copy it reopened: same row, a higher seq', () => {
    const adopted = copyRow('s', { base: [], mine: [] }, { seq: 4 });
    const recorder = recordCopy({
      adopted,
      base: [p('a', 'A')],
      key: KEY,
      lineage: ROOM,
      revision: 3,
    });
    expect(recorder.stop()).toEqual({ id: 's:copy', key: KEY, seq: 4 });
    const again = recordCopy({
      adopted,
      base: [p('a', 'A')],
      key: KEY,
      lineage: ROOM,
      revision: 3,
    });
    again.edited([p('a', 'A again')]);
    again.flush();
    expect(stored.puts[0]).toMatchObject([
      { id: 's:copy', seq: 5, session: 's' },
    ]);
  });
});
