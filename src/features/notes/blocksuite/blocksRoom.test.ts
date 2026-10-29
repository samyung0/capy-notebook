import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ItemRoomSnapshot } from '@/features/collaboration/itemRoom';
import type { MaterialValue } from '@/features/materials/document';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import { draftKey, readDrafts } from '@/lib/editDrafts';
import {
  join,
  mockBlocksRoom,
  registerMockCollaborationProvider,
  setCollaborationReachable,
} from '@/mocks/collaboration';
import * as db from '@/mocks/db';
import { createBlocksRoom } from './blocksRoom';
import { BLOCKS_ROOT, blocksValue, canonical } from './layout';

vi.mock('@/api/auth', () => ({ USE_MSW: true }));
vi.mock('@/features/notes/plugins', () => ({ MaterialKit: [] }));
vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  getMaterialCollaborationToken: async (materialId: string) => ({
    access: 'write',
    expiresAt: 0,
    room: `material:${materialId}`,
    token: 'mock-collaboration-token',
    url: 'mock://collaboration',
  }),
}));

// The drafts worker, run in this process (as editDrafts.test.ts runs it).
class InProcessWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: DraftReply }) => void) | null = null;
  store = import('@/lib/draftStore');
  postMessage(message: DraftMessage) {
    const copy = structuredClone(message);
    void this.store.then(({ handleDraftMessage }) =>
      handleDraftMessage(copy, (answer) =>
        this.onmessage?.({ data: structuredClone(answer) })
      )
    );
  }
  terminate() {}
}
vi.stubGlobal('Worker', InProcessWorker);

const ACTOR = 'user-blocks-drafts';
const VALUE: MaterialValue = [
  { children: [{ text: 'Title' }], id: 'title', type: 'h1' },
  { children: [{ text: 'base' }], id: 'body', type: 'p' },
  { children: [{ text: 'tail' }], id: 'tail', type: 'p' },
];

beforeAll(registerMockCollaborationProvider);
afterEach(() => {
  setCollaborationReachable(true);
  vi.unstubAllEnvs();
});

let materials = 0;
/** A note in the blocks layout, its mock room seeded from VALUE. */
function blocksNote() {
  vi.stubEnv('VITE_DOCUMENT_LAYOUT', 'blocks');
  const material = {
    ...db.materials[0],
    // MSW keeps drafts only for scenario materials (editDrafts `stored`).
    id: `mock-scenario-blocks-drafts-${materials++}`,
    kind: 'note' as const,
  };
  db.materials.push(material);
  return material.id;
}

function open(materialId: string, onReplace = () => {}) {
  const opened = createBlocksRoom(materialId, VALUE, {
    actorId: ACTOR,
    onReplace,
  });
  void opened.room.start();
  return opened.room;
}

function until(
  room: {
    getSnapshot: () => ItemRoomSnapshot;
    subscribe: (l: () => void) => () => void;
  },
  check: (snapshot: ItemRoomSnapshot) => boolean
) {
  return new Promise<void>((resolve) => {
    if (check(room.getSnapshot())) return resolve();
    const stop = room.subscribe(() => {
      if (!check(room.getSnapshot())) return;
      stop();
      resolve();
    });
  });
}

const stored = (materialId: string) =>
  readDrafts(draftKey(ACTOR, 'material', materialId));

/** Polls until `read` holds (the drafts worker and receipts are async). */
async function eventually(read: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('never held');
}

function text(doc: Y.Doc, block: string) {
  const yBlock = doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT).get(block);
  return yBlock?.get('prop:text') as Y.Text;
}

/** Another editor of the note, headless, in its mock room. */
function peer(materialId: string) {
  const document = new Y.Doc();
  const leave = join(mockBlocksRoom(materialId, VALUE), {
    document,
    origin: {},
  });
  return { document, leave };
}

it('is ready once the room synced, holding the seed and nothing of its own', async () => {
  const room = open(blocksNote());
  await until(room, ({ synced }) => synced);
  expect(room.getSnapshot()).toMatchObject({
    access: 'write',
    status: 'saved',
  });
  expect(blocksValue(room.doc)).toEqual(canonical(VALUE));
  // Every struct is the seed's: the tab wrote nothing while joining.
  expect([
    ...Y.decodeStateVector(Y.encodeStateVector(room.doc)).keys(),
  ]).not.toContain(room.doc.clientID);
  room.destroy();
});

describe('offline', () => {
  it('stays editable, stores its edits and converges with a peer once back', async () => {
    const id = blocksNote();
    const room = open(id);
    await until(room, ({ synced }) => synced);
    const other = peer(id);
    // A first edit the room stored: this session is accepted (Q326).
    text(room.doc, 'body').insert(4, ' saved');
    await eventually(async () => (await stored(id)).length === 0);

    setCollaborationReachable(false);
    await until(room, ({ offline }) => offline === 'offline');
    expect(room.getSnapshot()).toMatchObject({
      status: 'offline',
      synced: true,
    });
    text(room.doc, 'body').insert(10, ' offline');
    text(other.document, 'tail').insert(0, 'peer ');
    await eventually(async () =>
      (await stored(id)).some((row) => row.kind === 'update')
    );
    expect(text(other.document, 'body').toString()).toBe('base saved');

    setCollaborationReachable(true);
    await until(room, ({ offline, status }) => !offline && status === 'saved');
    expect(text(room.doc, 'tail').toString()).toBe('peer tail');
    expect(text(other.document, 'body').toString()).toBe('base saved offline');
    expect(blocksValue(room.doc)).toEqual(blocksValue(other.document));
    // The receipt deleted what it covered.
    await eventually(async () => (await stored(id)).length === 0);
    other.leave();
    room.destroy();
  });

  it('restores its stored edits in the next open and sends them once the room is back', async () => {
    const id = blocksNote();
    const first = open(id);
    await until(first, ({ synced }) => synced);
    text(first.doc, 'body').insert(4, ' saved');
    await eventually(async () => (await stored(id)).length === 0);
    setCollaborationReachable(false);
    await until(first, ({ offline }) => offline === 'offline');
    text(first.doc, 'body').insert(10, ' kept');
    await eventually(async () =>
      (await stored(id)).some((row) => row.kind === 'update')
    );
    // A reload while the service is still down.
    first.destroy();

    const second = open(id);
    await eventually(async () => second.getSnapshot().status === 'connecting');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.getSnapshot().synced).toBe(false);
    setCollaborationReachable(true);
    await until(second, ({ status, synced }) => synced && status === 'saved');
    expect(text(second.doc, 'body').toString()).toBe('base saved kept');
    const other = peer(id);
    expect(text(other.document, 'body').toString()).toBe('base saved kept');
    await eventually(async () => (await stored(id)).length === 0);
    other.leave();
    second.destroy();
  });
});

/*
 * Seeded rounds: the editor and a peer write while the editor's network
 * comes and goes and the tab reloads; once back, both hold every write once.
 * CI runs the fixed range below, so a red run always replays; a longer run
 * by hand widens it (`BLOCKS_DRAFTS_SEEDS=2000`, `BLOCKS_DRAFTS_FIRST_SEED`).
 * A seed that fails becomes its own named case in `rounds that once failed`
 * (none yet), never left to fall inside the range.
 */
const SEEDS = Number(process.env.BLOCKS_DRAFTS_SEEDS ?? 20);
const FIRST_SEED = Number(process.env.BLOCKS_DRAFTS_FIRST_SEED ?? 0);
const STEPS = 12;
const BLOCKS = ['title', 'body', 'tail'];

/** mulberry32: the same picks for a seed on every run. */
function picker(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n) as number;
  };
}

/** One round, and what its end state holds (its context names the seed
 * and every step). */
async function round(seed: number) {
  const pick = picker(seed);
  const id = blocksNote();
  const other = peer(id);
  const written: string[] = [];
  const log: string[] = [];
  let reachable = true;
  let room = open(id);
  let accepted = false;
  // A session's first edit the room stored: its later rows reopen applied
  // (Q326; the mock's rows carry no token, so a never-accepted session's
  // rows would open copy-only, as decided).
  const accept = async () => {
    await until(room, ({ synced, offline }) => synced && !offline);
    write(room.doc, 'editor');
    await eventually(async () => (await stored(id)).length === 0);
    accepted = true;
  };
  const write = (doc: Y.Doc, who: string) => {
    const marker = `[${who}${written.length}]`;
    const target = text(doc, BLOCKS[pick(BLOCKS.length)]);
    const at = pick(2) ? target.length : 0;
    target.insert(at, marker);
    written.push(marker);
    log.push(`${who} ${marker}@${at ? 'end' : 'start'}`);
  };
  await accept();
  for (let step = 0; step < STEPS; step++) {
    switch (pick(4)) {
      case 0:
        if (room.getSnapshot().synced) write(room.doc, 'editor');
        break;
      case 1:
        write(other.document, 'peer');
        break;
      case 2:
        reachable = !reachable;
        log.push(reachable ? 'online' : 'offline');
        setCollaborationReachable(reachable);
        if (reachable && !accepted) await accept();
        else if (!reachable && room.getSnapshot().synced)
          await until(room, ({ offline }) => offline !== null);
        break;
      default:
        log.push('reload');
        room.destroy();
        room = open(id);
        accepted = false;
        if (reachable) await accept();
        else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  setCollaborationReachable(true);
  if (!accepted) await accept();
  await until(room, ({ status }) => status === 'saved');
  await eventually(async () => (await stored(id)).length === 0);
  const editor = blocksValue(room.doc);
  const all = JSON.stringify(editor);
  const result = {
    context: `seed ${seed}: ${log.join(', ')}`,
    // Each write's count in the editor's note: once.
    counts: written.map(
      (marker) => `${marker} ${all.split(marker).length - 1}`
    ),
    editor,
    peer: blocksValue(other.document),
    recovery: room.getSnapshot().recovery,
    written,
  };
  other.leave();
  room.destroy();
  return result;
}

describe('seeded offline rounds', () => {
  it.each(Array.from({ length: SEEDS }, (_, index) => FIRST_SEED + index))(
    'seed %i converges with nothing lost or doubled',
    async (seed) => {
      const { context, counts, editor, peer, recovery, written } =
        await round(seed);
      expect(recovery, context).toBeNull();
      expect(editor, context).toEqual(peer);
      expect(counts, context).toEqual(written.map((marker) => `${marker} 1`));
    }
  );
});
