/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The publication contract helper runs only inside these tests. */
import { readFileSync } from 'node:fs';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import * as Y from 'yjs';
import {
  decodeBaseline,
  encodeBaseline,
  SourceDocumentStore,
  SourceRequestError,
  type SourceSession,
} from './sourceDocuments.js';
import { SourceHandoff } from './sourceHandoff.js';

const publicationSchema = parse(
  readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8')
).components.schemas.SourceRefreshPublish as {
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  required: string[];
};

function assertPublicationFields(body: unknown) {
  expect(body).toBeTypeOf('object');
  const fields = Object.keys(body as Record<string, unknown>);
  expect(publicationSchema.additionalProperties).toBe(false);
  expect(fields).toEqual(expect.arrayContaining(publicationSchema.required));
  expect(
    fields.filter(
      (field) => !Object.hasOwn(publicationSchema.properties, field)
    )
  ).toEqual([]);
}

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
    indexedBaseline: '',
    indexedCheckpoint: 0,
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
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      expect(url).toBe('http://unused/internal/collaboration/files/f/publish');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertPublicationFields(body);
      expect(body).toMatchObject({
        attemptId: 3,
        checkpoint: 7,
        epoch: 1,
        jobId: 'job',
        leaseToken: 'lease',
      });
      return Response.json({ epoch: 2 });
    });
  const input = {
    attemptId: 3,
    checkpoint: 7,
    contentHash: 'hash',
    contentId: 'content',
    epoch: 1,
    fileId: 'f',
    jobId: 'job',
    leaseToken: 'lease',
    sourceETag: 'etag',
  };
  await expect(f.handoff.publish(input)).resolves.toEqual({ epoch: 2 });
  expect(request).toHaveBeenCalledOnce();
  expect(f.redis.publish).not.toHaveBeenCalled();
});

test('text publication advances the semantic baseline while retaining newer edits', async () => {
  const f = setup();
  const state = (text: string) => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, text);
    const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    return bytes;
  };
  f.session.format = 'text';
  f.session.checkpoint = 8;
  f.session.state = state('Exam Tuesday').toString('base64');
  f.session.indexedBaseline = encodeBaseline({
    format: 'text',
    text: 'Exam Friday',
    version: 1,
  });
  f.pool.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM files')
      ? [{ user_id: 'u' }]
      : sql.includes('source_refresh_candidates')
        ? [{ state: state('Exam Monday') }]
        : [{ published: false }],
  }));
  let published:
    | {
        indexedBaseline: string;
        pendingEffects: unknown;
        expectedLatestCheckpoint: number;
      }
    | undefined;
  vi.spyOn(f.sources, 'request').mockImplementation(
    async (_file, _endpoint, body) => {
      assertPublicationFields(body);
      published = body as typeof published;
      return f.session;
    }
  );
  await f.handoff.publish({
    attemptId: 1,
    checkpoint: 7,
    contentHash: 'hash',
    contentId: 'content',
    epoch: 1,
    fileId: 'f',
    jobId: 'job',
    leaseToken: 'lease',
    sourceETag: 'etag',
  });
  expect(decodeBaseline(published!.indexedBaseline, 'text')).toEqual({
    format: 'text',
    text: 'Exam Monday',
    version: 1,
  });
  expect(published!.pendingEffects).toMatchObject([
    { after: 'Tues', before: 'Mon', operation: 'replace' },
  ]);
  expect(published!.expectedLatestCheckpoint).toBe(8);
  expect(f.host.closeConnections).not.toHaveBeenCalled();
});

// No connected editors: publication still has to fence saves from other processes.
test('Office publication rebases a later save and retries only rebase when another save wins CAS', async () => {
  const f = setup();
  let lockId = '';
  Object.assign(f.redis, {
    del: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(async () => lockId),
    hgetall: vi.fn(async () => ({ instance: 'ready' })),
    set: vi.fn(async (_key: string, id: string) => {
      lockId = id;
      return 'OK';
    }),
  });
  f.session.checkpoint = 8;
  vi.mocked(f.sources.session).mockImplementation(async () => ({
    ...f.session,
  }));
  const rebase = vi
    .spyOn(f.sources, 'rebasePublication')
    .mockImplementation(async (session) => ({
      indexedBaseline: 'baseline7',
      netTokens: 0,
      pendingEffects: [],
      rebasedState: `state${session.checkpoint}`,
    }));
  const publish = vi
    .spyOn(f.sources, 'request')
    .mockImplementation(async (_file, _endpoint, body) => {
      assertPublicationFields(body);
      if (
        (body as { expectedLatestCheckpoint: number })
          .expectedLatestCheckpoint === 8
      ) {
        f.session.checkpoint = 9;
        throw new SourceRequestError(409, 'Source checkpoint changed');
      }
      return { epoch: 2 };
    });
  const input = {
    attemptId: 1,
    checkpoint: 7,
    contentHash: 'hash',
    contentId: 'content',
    epoch: 1,
    fileId: 'f',
    jobId: 'job',
    leaseToken: 'lease',
    sourceETag: 'etag',
  };
  await expect(f.handoff.publish(input)).resolves.toEqual({ epoch: 2 });
  expect(rebase).toHaveBeenCalledTimes(2);
  const { fileId: _fileId, ...receipt } = input;
  expect(publish.mock.calls.map((call) => call[2])).toEqual([
    {
      ...receipt,
      expectedLatestCheckpoint: 8,
      indexedBaseline: 'baseline7',
      netTokens: 0,
      pendingEffects: [],
      rebasedState: 'state8',
    },
    {
      ...receipt,
      expectedLatestCheckpoint: 9,
      indexedBaseline: 'baseline7',
      netTokens: 0,
      pendingEffects: [],
      rebasedState: 'state9',
    },
  ]);
  expect(f.redis.publish).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.stringContaining('"type":"complete"')
  );
});

test('a busy Office handoff is retryable without discarding its parsed candidate', async () => {
  const f = setup();
  Object.assign(f.redis, { set: vi.fn(async () => null) });
  const rebase = vi.spyOn(f.sources, 'rebasePublication');
  await expect(
    f.handoff.publish({
      attemptId: 1,
      checkpoint: 7,
      epoch: 1,
      fileId: 'f',
      jobId: 'job',
      leaseToken: 'lease',
    })
  ).rejects.toMatchObject({ status: 503 });
  expect(rebase).not.toHaveBeenCalled();
});
