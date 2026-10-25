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
  readDrafts: vi.fn(async () => stored.rows),
}));

import type { EditDraft } from '@/lib/editDrafts';
import { useNoteDrafts } from './NoteRecovery';

const ROOM = 'material:m_1:schema:1';

const draft = (id: string, extra: Partial<EditDraft>): EditDraft => ({
  data: new Uint8Array(),
  id,
  key: 'u_1:material:m_1',
  kind: 'update',
  lineage: ROOM,
  savedAt: 0,
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
    recovery: null,
  });
});
