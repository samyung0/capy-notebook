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
  reports: [] as unknown[][],
  rows: [] as unknown[],
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
  dropExpiredGroup: vi.fn(),
  readDrafts: vi.fn(async () => stored.rows),
}));

import * as Y from 'yjs';
import {
  DRAFT_EXPIRY_MS,
  dropExpiredGroup,
  type EditDraft,
} from '@/lib/editDrafts';
import { useNoteDrafts } from './NoteRecovery';

const ROOM = 'material:m_1:schema:1';

// Web Locks as the browser has them: the copy sessions open tabs record.
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    query: async () => ({ held: stored.held }),
    request: async () => undefined,
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
  stored.reports = [];
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
    recovery: null,
  });
});

// Late merge M5 (Epo 2026-10-24): rows whose last edit is over 7 days old
// open once, copy-only and marked too old, and go as they open.
it('opens an expired group once, copy-only, and drops it', async () => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'old');
  const old = draft('a:state', {
    accepted: true,
    data: Y.encodeStateAsUpdate(doc),
    kind: 'state',
    savedAt: Date.now() - DRAFT_EXPIRY_MS - 1,
  });
  stored.rows = [old];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    current: [],
    recovery: { expired: true, refused: false, rows: [old] },
  });
  expect(dropExpiredGroup).toHaveBeenCalledWith([old], expect.any(Function));
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
// the next editor, which shows it and merges it at the first sync.
it('hands the editor the copies it merges at the first sync', async () => {
  const copy = { base: [p('a', 'A')], mine: [p('a', 'A typed')], revision: 1 };
  const row = copyRow('s', copy, {});
  stored.rows = [row];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    copies: { adopted: { copy, row }, others: [] },
    recovery: null,
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
    recovery: null,
  });
  expect(stored.reports).toEqual([
    ['draft_unrestorable', 'unreadable', broken.data.byteLength],
  ]);
});

// Q229: blocks of the copy someone else changed too open copy-only under
// their own line; an expired copy opens once and goes. Fails if either
// reaches the editor's merge.
it('opens the blocks a merge left copy-only, then an expired copy once', async () => {
  const conflict = copyRow(
    'c',
    { mine: [p('b', 'B mine')] },
    { refused: true }
  );
  const expired = copyRow(
    'x',
    { base: [], mine: [p('a', 'Old')], revision: 1 },
    { savedAt: Date.now() - DRAFT_EXPIRY_MS - 1 }
  );
  vi.mocked(dropExpiredGroup).mockClear();
  stored.rows = [conflict, expired];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    copies: { adopted: null, others: [] },
    recovery: { conflict: true, rows: [conflict], value: [p('b', 'B mine')] },
  });
  expect(dropExpiredGroup).not.toHaveBeenCalled();
  hooks.reset();
  stored.rows = [expired];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  expect(render()).toMatchObject({
    recovery: { expired: true, rows: [expired], value: [p('a', 'Old')] },
  });
  expect(dropExpiredGroup).toHaveBeenCalledWith(
    [expired],
    expect.any(Function)
  );
});
