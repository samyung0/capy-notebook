import { beforeEach, expect, it, vi } from 'vitest';

// Capy's vitest has no DOM, so the hook runs under a minimal hooks runtime:
// state and refs by call order, an effect when its deps change.
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let next = 0;
  return {
    begin() {
      next = 0;
    },
    get: (at: number) => slots[at],
    reset() {
      slots.length = 0;
      next = 0;
    },
    set(at: number, value: unknown) {
      slots[at] = value;
    },
    slot<T>(initial: () => T): [number, T] {
      const at = next++;
      if (!(at in slots)) slots[at] = initial();
      return [at, slots[at] as T];
    },
  };
});
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useEffect: (effect: () => undefined | (() => void), deps?: unknown[]) => {
    const [at, last] = hooks.slot<unknown[] | null>(() => null);
    if (last && deps?.every((dep, i) => Object.is(dep, last[i]))) return;
    hooks.set(at, deps ?? []);
    effect();
  },
  useState: <T>(initial: T) => {
    const [at, value] = hooks.slot(() => initial);
    return [value, (next: T) => hooks.set(at, next)];
  },
}));
const stored = vi.hoisted(() => ({
  held: [] as { name: string }[],
  // Locks this tab holds now, and those another tab takes between this
  // tab's query and its request.
  locks: new Set<string>(),
  reports: [] as unknown[][],
  rows: [] as unknown[],
  taken: [] as string[],
}));
vi.mock('@/lib/editIncidents', async (load) => ({
  ...(await load<typeof import('@/lib/editIncidents')>()),
  editIncidentReporter:
    () =>
    (...report: unknown[]) =>
      stored.reports.push(report),
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  deleteDrafts: vi.fn(async () => undefined),
  dropExpiredGroup: vi.fn(),
  readDrafts: vi.fn(async () => stored.rows),
}));

import * as Y from 'yjs';
import {
  DRAFT_EXPIRY_MS,
  dropExpiredGroup,
  type EditDraft,
} from '@/lib/editDrafts';
import { useNoteDrafts } from './noteDrafts';
import { pieceRow } from './pieceRows';

const ROOM = 'material:m_1:schema:1';

// Web Locks as the browser has them: the copy sessions open tabs record,
// and a request `ifAvailable` that another tab's lock refuses.
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    query: async () => ({ held: stored.held }),
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: { name: string } | null) => unknown
    ) => {
      if (stored.taken.includes(name)) return callback(null);
      stored.locks.add(name);
      await callback({ name });
      stored.locks.delete(name);
    },
  },
});

const draft = (id: string, extra: Partial<EditDraft>): EditDraft => ({
  data: new Uint8Array(),
  id,
  key: 'u_1:material:m_1',
  kind: 'update',
  lineage: ROOM,
  savedAt: Date.now(),
  seq: 1,
  session: id,
  ...extra,
});

const render = () => {
  hooks.begin();
  return useNoteDrafts('m_1', 'u_1:material:m_1', ROOM, 0);
};

beforeEach(() => {
  hooks.reset();
  stored.held = [];
  stored.locks.clear();
  stored.reports = [];
  stored.taken = [];
});

// Q326: an opening note applies its accepted sessions' rows and leaves a
// never-accepted session's rows with a stored token to the draft send.
it("applies accepted sessions' rows and leaves never-accepted ones with a token to the draft send", async () => {
  const accepted = draft('a:1', { accepted: true });
  const pending = draft('b:1', { grants: ['t'] });
  stored.rows = [accepted, pending];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    current: [accepted],
    pending: [pending],
    sources: [],
  });
});

// Q251: a group whose last edit is over 7 days old becomes pieces once the
// room synced, never applied raw and never shown copy-only. Fails if the
// expired group is applied (current) or dropped as it opens.
it('makes an expired group a source of pieces, never applied or dropped', async () => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'old');
  const old = draft('a:state', {
    accepted: true,
    data: Y.encodeStateAsUpdate(doc),
    kind: 'state',
    savedAt: Date.now() - DRAFT_EXPIRY_MS - 1,
  });
  stored.rows = [old];
  vi.mocked(dropExpiredGroup).mockClear();
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  const drafts = render();
  expect(drafts?.current).toEqual([]);
  expect(drafts?.sources).toMatchObject([{ rows: [old], source: 'expired' }]);
  expect(dropExpiredGroup).not.toHaveBeenCalled();
});

// Q251: refused and other-lineage groups become sources too, all of them
// in one open, while the current rows still apply.
it('makes every refused and other-lineage group a source, applying the current rows', async () => {
  const state = (id: string, extra: Partial<EditDraft>) => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, id);
    return draft(id, {
      data: Y.encodeStateAsUpdate(doc),
      kind: 'state',
      ...extra,
    });
  };
  const refused = state('r:state', { refused: true, session: 'r' });
  const moved = state('m:state', {
    lineage: 'material:m_1:schema:0',
    session: 'm',
  });
  // Review r1 V-N4 (Q410): rows the service held as typing into a deleted
  // block (refused here by drawing on their own) say so.
  const hidden = state('h:state', {
    hidden: true,
    lineage: 'material:m_1:schema:2',
    refused: true,
    session: 'h',
  });
  const live = draft('l:1', { accepted: true, session: 'l' });
  stored.rows = [refused, moved, hidden, live];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  const drafts = render();
  expect(drafts?.current).toEqual([live]);
  expect(
    drafts?.sources.map(({ rows, source }) => [rows[0].id, source])
  ).toEqual([
    ['r:state', 'refused'],
    ['m:state', 'changed'],
    ['h:state', 'hidden'],
  ]);
});

const copyRow = (id: string, value: unknown, extra: Partial<EditDraft>) =>
  draft(`${id}:copy`, {
    data: new TextEncoder().encode(JSON.stringify(value)),
    kind: 'copy',
    session: id,
    ...extra,
  });
const p = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});

// Q229: a copy edited before the room joined, left by a closed tab, goes to
// the next editor, which shows it and merges it at the first sync; an
// expired copy becomes pieces whole; stored pieces show at once.
it('hands the editor its copies, its stored pieces and an expired copy as a source', async () => {
  const copy = { base: [p('a', 'A')], mine: [p('a', 'A typed')], revision: 1 };
  const row = copyRow('s', copy, {});
  const expired = copyRow('x', copy, {
    savedAt: Date.now() - DRAFT_EXPIRY_MS - 1,
  });
  const piece = {
    after: null,
    at: 1,
    block: 'a',
    mine: p('a', 'Mine'),
    source: 'refused' as const,
  };
  const stored_ = pieceRow('u_1:material:m_1', ROOM, piece, 2);
  stored.rows = [row, expired, stored_];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    copies: { adopted: { copy, row }, others: [] },
    pieces: [{ piece, row: stored_ }],
    sources: [{ copy, rows: [expired], source: 'expired' }],
  });
});

// Review r1 M1 and L4: a copy another open tab records is left to it; an
// unreadable one is dropped with the lost-drafts notice and reported.
it("leaves another open tab's copy alone and reports an unreadable one", async () => {
  const copy = { base: [p('a', 'A')], mine: [p('a', 'A typed')], revision: 1 };
  const open = copyRow('open', copy, {});
  const broken = { ...copyRow('broken', copy, {}), data: new Uint8Array([1]) };
  stored.rows = [open, broken];
  stored.held = [{ name: 'capy-copy:open' }];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    copies: { adopted: null, others: [] },
    sources: [],
  });
  expect(stored.reports).toEqual([
    ['draft_unrestorable', 'unreadable', broken.data.byteLength],
  ]);
});

// Merge view review r1 Q-L1 (Q410): a copy is adopted only once its lock is
// taken, if free, and that lock stays held until the editor takes over. A
// row another tab took after the query is that tab's: the next newest is
// adopted, and the taken one is neither shown nor merged here.
it('adopts a copy only with its lock, held until the editor takes it over', async () => {
  const copy = { base: [p('a', 'A')], mine: [p('a', 'A typed')], revision: 1 };
  const older = copyRow('older', copy, { savedAt: Date.now() - 2000 });
  const newer = copyRow('newer', copy, { savedAt: Date.now() - 1000 });
  stored.rows = [older, newer];
  stored.taken = ['capy-copy:newer'];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  const drafts = render();
  expect(drafts?.copies).toMatchObject({
    adopted: { row: older },
    others: [],
  });
  expect([...stored.locks]).toEqual(['capy-copy:older']);
  drafts?.copies.release();
  await vi.waitFor(() => expect(stored.locks.size).toBe(0));
});

// Q412, Q413: expiry comes first. An expired copy becomes pieces, even one
// an open tab still holds, and never merges; only the fresh copy of another
// closed tab is adopted, to merge at the bind.
it('makes an expired copy pieces and merges only the fresh copy of another closed tab', async () => {
  const copy = { base: [p('a', 'A')], mine: [p('a', 'A typed')], revision: 1 };
  const expired = copyRow('old', copy, {
    savedAt: Date.now() - DRAFT_EXPIRY_MS - 1,
  });
  const fresh = copyRow('fresh', copy, {});
  stored.rows = [expired, fresh];
  stored.held = [{ name: 'capy-copy:old' }];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    copies: { adopted: { row: fresh }, others: [] },
    sources: [{ copy, rows: [expired], source: 'expired' }],
  });
});
