import { afterEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({
  deletes: [] as unknown[][],
  puts: [] as unknown[][],
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  deleteDrafts: vi.fn(async (rows: unknown[]) => {
    stored.deletes.push(rows);
  }),
  putDrafts: vi.fn(async (rows: unknown[]) => {
    stored.puts.push(rows);
  }),
}));

import { DRAFT_EXPIRY_MS, type EditDraft } from '@/lib/editDrafts';
import {
  COPY_WRITE_MS,
  deleteOnceStored,
  holdCopy,
  insertsMany,
  noteCopies,
  recordCopy,
  takeOverCopy,
} from './copyDraft';

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
  stored.deletes.length = 0;
  stored.puts.length = 0;
});

describe('noteCopies', () => {
  it('shows the newest live copy, merges older ones before it, and splits expired copies and unreadable rows', () => {
    const now = Date.now();
    const copy = {
      base: [p('a', 'A')],
      mine: [p('a', 'A typed')],
      revision: 3,
    };
    const older = copyRow('older', copy, { savedAt: now - 2000 });
    const newer = copyRow('newer', copy, { savedAt: now - 1000 });
    const expired = copyRow('x', copy, {
      savedAt: now - DRAFT_EXPIRY_MS - 1,
    });
    const broken = { ...copyRow('y', copy), data: new Uint8Array([123]) };
    const yjs = { ...copyRow('u', copy), kind: 'update' as const };
    const read = noteCopies(
      [newer, older, expired, broken, yjs],
      new Set(),
      now
    );
    expect(read.copies.adopted?.row).toBe(newer);
    expect(read.copies.adopted?.copy).toEqual(copy);
    expect(read.copies.others.map(({ row }) => row)).toEqual([older]);
    expect(read.expired).toEqual([{ copy, row: expired }]);
    expect(read.unreadable).toEqual([broken]);
  });

  // Review r1 M1: an open tab owns the copy it records; another tab neither
  // adopts nor merges it. Without Web Locks nothing is adopted.
  it('leaves alone a copy another open tab records, and adopts none without Web Locks', () => {
    const copy = {
      base: [p('a', 'A')],
      mine: [p('a', 'A typed')],
      revision: 3,
    };
    const now = Date.now();
    const open = copyRow('open', copy, { savedAt: now - 1000 });
    const closed = copyRow('closed', copy, { savedAt: now - 2000 });
    const read = noteCopies([open, closed], new Set(['open']), now);
    expect(read.copies.adopted?.row).toBe(closed);
    expect(read.copies.others).toEqual([]);
    const unknown = noteCopies([open, closed], null, now);
    expect(unknown.copies.adopted).toBeNull();
    expect(unknown.copies.others.map(({ row }) => row)).toEqual([closed, open]);
  });
});

// Merge view review r1 Q-L4: the tab's copy lock is named by its session
// and held until the release.
describe('holdCopy', () => {
  it('holds capy-copy:<session> until released', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const asked: string[] = [];
    let held: Promise<unknown> = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, callback: () => Promise<unknown>) => {
          asked.push(name);
          held = callback();
          return held;
        },
      },
    });
    try {
      const release = holdCopy('s1');
      expect(asked).toEqual(['capy-copy:s1']);
      let released = false;
      void held.then(() => {
        released = true;
      });
      await Promise.resolve();
      expect(released).toBe(false);
      release();
      await vi.waitFor(() => expect(released).toBe(true));
    } finally {
      if (original) Object.defineProperty(navigator, 'locks', original);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });
});

// Merge view review r2 L5 (Q421): the editor asks for its own lock before
// the adoption's lock goes, so no other tab takes the row between them.
it('takes over the adopted copy with its own request first', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const order: string[] = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string) => {
        order.push(`request ${name}`);
        return new Promise(() => {});
      },
    },
  });
  try {
    takeOverCopy('s1', () => order.push('adoption released'));
    expect(order).toEqual(['request capy-copy:s1', 'adoption released']);
  } finally {
    if (original) Object.defineProperty(navigator, 'locks', original);
    else Reflect.deleteProperty(navigator, 'locks');
  }
});

// Merge view review r2 L4 (Q421): a paste of text writes the typing before
// it first, as a pasted block does; a keystroke does not.
it('counts an edit inserting more than one character as a paste', () => {
  const at = { offset: 0, path: [0, 0] };
  expect(insertsMany([{ ...at, text: 'a', type: 'insert_text' }])).toBe(false);
  expect(insertsMany([{ ...at, text: 'a log', type: 'insert_text' }])).toBe(
    true
  );
  expect(
    insertsMany([{ node: p('b', ''), path: [1], type: 'insert_node' }])
  ).toBe(true);
});

describe('recordCopy', () => {
  it('writes the edited copy at most once a second, at once on flush, and stops with the row it wrote', async () => {
    vi.useFakeTimers();
    const recorder = recordCopy({
      adopted: null,
      base: [p('a', 'A')],
      key: KEY,
      limitBytes: 1024,
      lineage: ROOM,
      onLimit: () => {},
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
    // Review r1 L6: stop writes what is pending, so a merge that throws
    // keeps the last second of typing.
    recorder.edited([p('a', 'A typed!')]);
    expect(recorder.stop()).toEqual({ id: first.id, key: KEY, seq: 3 });
    expect(decode((stored.puts[2] as EditDraft[])[0]).mine).toEqual([
      p('a', 'A typed!'),
    ]);
    recorder.edited([p('a', 'after')]);
    vi.advanceTimersByTime(COPY_WRITE_MS);
    expect(stored.puts).toHaveLength(3);
  });

  // Review r1 L2: the copy keeps the offline bound drafts keep.
  it('stops writing past its bound over the base, keeping the last value written', () => {
    const onLimit = vi.fn();
    const recorder = recordCopy({
      adopted: null,
      base: [p('a', 'A')],
      key: KEY,
      limitBytes: 64,
      lineage: ROOM,
      onLimit,
      revision: 3,
    });
    recorder.edited([p('a', 'A short')]);
    recorder.flush();
    recorder.edited([p('a', 'x'.repeat(100))]);
    recorder.flush();
    expect(onLimit).toHaveBeenCalledOnce();
    expect(stored.puts).toHaveLength(1);
    expect(recorder.over).toBe(true);
    expect(recorder.kept).toEqual([p('a', 'A short')]);
  });

  // Merge view review r1 Q-L5 (Q410): a paste past the bound drops only the
  // paste; the typing just before it was written first.
  it('writes the typing before an insert, so the bound drops only the insert', () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const recorder = recordCopy({
      adopted: null,
      base: [p('a', 'A')],
      key: KEY,
      limitBytes: 64,
      lineage: ROOM,
      onLimit,
      revision: 3,
    });
    recorder.edited([p('a', 'A typed')]);
    recorder.edited([p('a', 'A typed'), p('b', 'x'.repeat(100))], true);
    vi.advanceTimersByTime(COPY_WRITE_MS);
    expect(onLimit).toHaveBeenCalledOnce();
    expect(stored.puts).toHaveLength(1);
    expect(recorder.kept).toEqual([p('a', 'A typed')]);
  });

  // Merge view review r2 L2 (Q421): the copy's last edit, the adopted row's
  // write until this mount edits it, decides the expiry at the bind.
  it("keeps the copy's last edit", () => {
    const row = copyRow('s', { base: [], mine: [] }, { savedAt: 1000 });
    const recorder = recordCopy({
      adopted: { copy: { base: [], mine: [], revision: 3 }, row },
      base: [p('a', 'A')],
      key: KEY,
      limitBytes: 1024,
      lineage: ROOM,
      onLimit: () => {},
      revision: 3,
    });
    expect(recorder.editedAt).toBe(1000);
    recorder.edited([p('a', 'A typed')]);
    expect(recorder.editedAt).toBeGreaterThan(Date.now() - 1000);
    recorder.stop();
  });

  it('goes on with the copy it reopened: same row, a higher seq', () => {
    const row = copyRow('s', { base: [], mine: [] }, { seq: 4 });
    const adopted = { copy: { base: [], mine: [], revision: 3 }, row };
    const options = {
      adopted,
      base: [p('a', 'A')],
      key: KEY,
      limitBytes: 1024,
      lineage: ROOM,
      onLimit: () => {},
      revision: 3,
    };
    const recorder = recordCopy(options);
    expect(recorder.session).toBe('s');
    expect(recorder.stop()).toEqual({ id: 's:copy', key: KEY, seq: 4 });
    const again = recordCopy(options);
    again.edited([p('a', 'A again')]);
    again.flush();
    expect(stored.puts[0]).toMatchObject([
      { id: 's:copy', seq: 5, session: 's' },
    ]);
  });
});

// Review r1 M2: the rows go only once what they hold is stored elsewhere;
// a failed write keeps them and says the drafts were not kept.
describe('deleteOnceStored', () => {
  it('deletes the rows after the write, and keeps them when it fails', async () => {
    const rows = [{ id: 'r', key: KEY, seq: 1 }];
    const lost = vi.fn();
    await expect(deleteOnceStored(Promise.resolve(), rows, lost)).resolves.toBe(
      true
    );
    expect(stored.deletes).toEqual([rows]);
    await expect(
      deleteOnceStored(Promise.reject(new Error('quota')), rows, lost)
    ).resolves.toBe(false);
    expect(stored.deletes).toHaveLength(1);
    expect(lost).toHaveBeenCalledOnce();
  });
});
