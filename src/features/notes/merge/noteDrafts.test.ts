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
const stored = vi.hoisted(() => ({ rows: [] as unknown[] }));
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

beforeEach(() => hooks.reset());

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
  const live = draft('l:1', { accepted: true, session: 'l' });
  stored.rows = [refused, moved, live];
  render();
  await vi.waitFor(() => expect(render()).not.toBeNull());
  const drafts = render();
  expect(drafts?.current).toEqual([live]);
  expect(
    drafts?.sources.map(({ rows, source }) => [rows[0].id, source])
  ).toEqual([
    ['r:state', 'refused'],
    ['m:state', 'changed'],
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
