import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import { SourceDocumentStore, type SourceSession } from './sourceDocuments.js';
import { SourceHandoff } from './sourceHandoff.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const session: SourceSession = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: 'sha',
    checkpoint: 7,
    epoch: 1,
    fileId: 'f',
    format: 'docx',
    indexedCheckpoint: 0,
    indexedState: '',
    netTokens: 0,
    pendingEffects: [],
    room: 'source:f:epoch:1',
    sourceURL: 'https://unused',
    state: '',
    workspaceId: 'ws',
  };
  const connection = {
    context: { access: 'write' },
    onClose: vi.fn(),
    readOnly: false,
    socketId: 'socket',
  };
  const document = {
    broadcastStateless: vi.fn(),
    getConnections: () => [connection],
    name: session.room,
  } as unknown as Document;
  const host = {
    closeConnections: vi.fn(),
    documents: new Map([[session.room, document]]),
    unloadDocument: vi.fn().mockResolvedValue(undefined),
  };
  const redis = {
    expire: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
  };
  const pool = {
    query: vi.fn().mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM files')
        ? [{ user_id: 'u' }]
        : [{ published: false }],
    })),
  };
  const sources = new SourceDocumentStore(
    pool as unknown as Pool,
    'http://unused',
    'secret'
  );
  vi.spyOn(sources, 'session').mockResolvedValue(session);
  const persist = vi.fn().mockResolvedValue(undefined);
  const handoff = new SourceHandoff(
    'instance',
    redis as unknown as Redis,
    pool as unknown as Pool,
    host as unknown as Hocuspocus,
    sources,
    async () => new Set(['instance']),
    persist
  );
  const event = {
    checkpoint: 7,
    epoch: 1,
    fileId: 'f',
    id: 'handoff',
    room: session.room,
    type: 'prepare',
  };
  return {
    connection,
    document,
    event,
    handoff,
    host,
    persist,
    pool,
    redis,
    session,
    sources,
  };
}

test('handoff requires a clean receipt for the matching epoch, checkpoint and socket', async () => {
  const f = setup();
  const preparing = f.handoff.handle(JSON.stringify(f.event));
  const ready = { checkpoint: 7, clean: true, epoch: 1, id: 'handoff' };
  expect(
    f.handoff.ready(f.session.room, 'socket', { ...ready, clean: false })
  ).toBe(false);
  expect(
    f.handoff.ready(f.session.room, 'socket', { ...ready, checkpoint: 6 })
  ).toBe(false);
  expect(f.handoff.ready(f.session.room, 'other', ready)).toBe(false);
  expect(f.handoff.ready(f.session.room, 'socket', ready)).toBe(true);
  await preparing;
  expect(f.persist).toHaveBeenCalledWith(f.document);
  expect(f.redis.hset).toHaveBeenCalledWith(
    'capy:source-handoff:handoff',
    'instance',
    'ready'
  );
  await f.handoff.handle(JSON.stringify({ ...f.event, type: 'cancel' }));
});

test('a lost coordinator completes an already-published epoch through the watchdog', async () => {
  vi.useFakeTimers();
  const f = setup();
  const preparing = f.handoff.handle(JSON.stringify(f.event));
  f.handoff.ready(f.session.room, 'socket', {
    checkpoint: 7,
    clean: true,
    epoch: 1,
    id: 'handoff',
  });
  f.connection.readOnly = true;
  await preparing;
  vi.mocked(f.sources.session).mockResolvedValue({ ...f.session, epoch: 2 });
  await vi.advanceTimersByTimeAsync(125_000);
  expect(f.host.closeConnections).toHaveBeenCalledWith(f.session.room);
  expect(f.document.broadcastStateless).toHaveBeenLastCalledWith(
    expect.stringContaining('"type":"source-epoch-changed"')
  );
  expect(f.host.unloadDocument).toHaveBeenCalledWith(f.document);
});

test('a lost coordinator cancels an unpublished handoff and restores editing', async () => {
  vi.useFakeTimers();
  const f = setup();
  const preparing = f.handoff.handle(JSON.stringify(f.event));
  f.handoff.ready(f.session.room, 'socket', {
    checkpoint: 7,
    clean: true,
    epoch: 1,
    id: 'handoff',
  });
  f.connection.readOnly = true;
  await preparing;
  await vi.advanceTimersByTimeAsync(125_000);
  expect(f.connection.readOnly).toBe(false);
  expect(f.document.broadcastStateless).toHaveBeenLastCalledWith(
    expect.stringContaining('"type":"source-handoff-cancel"')
  );
  expect(f.host.closeConnections).not.toHaveBeenCalled();
});

test('publication retry uses the durable fenced receipt before checking the new epoch', async () => {
  const f = setup();
  vi.mocked(f.sources.session).mockResolvedValue({ ...f.session, epoch: 2 });
  f.pool.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM files')
      ? [{ user_id: 'u' }]
      : [{ published: true }],
  }));
  vi.spyOn(f.sources, 'request').mockResolvedValue({ epoch: 2 });
  const input = {
    attemptId: 3,
    checkpoint: 7,
    epoch: 1,
    fileId: 'f',
    jobId: 'job',
    leaseToken: 'lease',
  };
  await expect(f.handoff.publish(input)).resolves.toEqual({ epoch: 2 });
  expect(f.sources.request).toHaveBeenCalledWith(
    'f',
    'publish',
    expect.objectContaining(input)
  );
  expect(f.redis.publish).not.toHaveBeenCalled();
});
