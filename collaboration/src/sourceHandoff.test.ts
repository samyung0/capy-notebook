/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The publication contract helper runs only inside these tests. */
import { readFileSync } from 'node:fs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { type Document, type Hocuspocus, Server } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import * as Y from 'yjs';
import {
  SourceDocumentStore,
  SourceRequestError,
  type SourceSession,
} from './sourceDocuments.js';
import {
  OFFICE_EDITING_PAUSED_REASON,
  PUBLICATION_HOLD_MARKER,
  SOURCE_PUBLISHING_REASON,
  SourceHandoff,
  SourcePublishingError,
} from './sourceHandoff.js';

const publicationSchema = parse(
  readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8')
).components.schemas.SourceRefreshPublish as {
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  required: string[];
};

const rebuildSchema = parse(
  readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8')
).components.schemas.SourceRebuild as typeof publicationSchema;

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

function setup(publicationHold = false) {
  const session: SourceSession = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: 'sha',
    checkpoint: 7,
    epoch: 1,
    fileId: 'f',
    format: 'docx',
    indexedCheckpoint: 0,
    netTokens: 0,
    pendingEffects: [],
    room: 'source:f:epoch:1',
    sourceURL: 'https://unused',
    state: '',
    stateSeedSHA256: null,
    workspaceId: 'ws',
  };
  const connection = {
    context: { access: 'write' },
    onClose: vi.fn(),
    readOnly: false,
    socketId: 'socket',
    webSocket: { close: vi.fn() },
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
  // A maintenance (system) job: its Office publication hands the room off.
  const pool = {
    query: vi.fn().mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM files')
        ? [{ user_id: 'u' }]
        : [{ published: false, system: true }],
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
    persist,
    publicationHold
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

test('the maintenance pause flushes the room, persists and closes its writers', async () => {
  const f = setup();
  const writer = Object.assign(f.connection, { close: vi.fn() });
  const viewer = {
    ...f.connection,
    close: vi.fn(),
    context: { access: 'read' },
    readOnly: true,
    socketId: 'viewer',
  };
  Object.assign(f.document, { getConnections: () => [writer, viewer] });
  const paused = f.handoff.pause(f.document);
  expect(f.document.broadcastStateless).toHaveBeenCalledWith(
    expect.stringContaining('"type":"source-handoff-prepare"')
  );
  expect(
    f.handoff.ready(f.session.room, 'socket', {
      checkpoint: 0,
      clean: true,
      epoch: 1,
      id: `pause:${f.session.room}`,
    })
  ).toBe(true);
  await expect(paused).resolves.toBe(true);
  expect(f.persist).toHaveBeenCalledWith(f.document);
  expect(f.document.broadcastStateless).toHaveBeenLastCalledWith(
    JSON.stringify({ epoch: 1, fileId: 'f', type: 'source-editing-paused' })
  );
  expect(writer.close).toHaveBeenCalledWith(
    expect.objectContaining({ reason: OFFICE_EDITING_PAUSED_REASON })
  );
  expect(viewer.close).not.toHaveBeenCalled();
});

test('a pause whose persist fails closes its writers without claiming they were saved', async () => {
  const f = setup();
  const writer = Object.assign(f.connection, { close: vi.fn() });
  f.persist.mockRejectedValue(new Error('checkpoint failed'));
  const paused = f.handoff.pause(f.document);
  f.handoff.ready(f.session.room, 'socket', {
    checkpoint: 0,
    clean: true,
    epoch: 1,
    id: `pause:${f.session.room}`,
  });
  await expect(paused).resolves.toBe(false);
  expect(f.document.broadcastStateless).not.toHaveBeenCalledWith(
    expect.stringContaining('source-editing-paused')
  );
  expect(writer.close).toHaveBeenCalledOnce();
});

test('a silent writer is disconnected after the window and the pause still persists', async () => {
  vi.useFakeTimers();
  const f = setup();
  Object.assign(f.connection, { close: vi.fn() });
  const paused = f.handoff.pause(f.document);
  await vi.advanceTimersByTimeAsync(10_100);
  await expect(paused).resolves.toBe(true);
  expect(f.connection.webSocket.close).toHaveBeenCalledWith(
    4408,
    'Source handoff timed out'
  );
  expect(f.persist).toHaveBeenCalledOnce();
});

test('a publication prepare during a pause waits for it instead of resetting it', async () => {
  const f = setup();
  let closed = false;
  Object.assign(f.connection, {
    close: vi.fn(() => {
      closed = true;
    }),
  });
  Object.assign(f.document, {
    getConnections: () => (closed ? [] : [f.connection]),
  });
  const paused = f.handoff.pause(f.document);
  const preparing = f.handoff.handle(JSON.stringify(f.event));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Still the pause's flush: the publication did not replace its entry.
  expect(
    f.handoff.ready(f.session.room, 'socket', {
      checkpoint: 0,
      clean: true,
      epoch: 1,
      id: `pause:${f.session.room}`,
    })
  ).toBe(true);
  await expect(paused).resolves.toBe(true);
  await preparing;
  expect(f.persist).toHaveBeenCalledTimes(2);
  expect(f.redis.hset).toHaveBeenCalledWith(
    'capy:source-handoff:handoff',
    'instance',
    'ready'
  );
  await f.handoff.handle(JSON.stringify({ ...f.event, type: 'cancel' }));
});

// One mocked Redis serves the coordinator and this instance, so a
// publication runs from prepare to the completed epoch.
function publishThroughRoom(f: ReturnType<typeof setup>) {
  const acknowledgments: Record<string, string> = {};
  let lockId = '';
  Object.assign(f.redis, {
    del: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(async () => lockId),
    hgetall: vi.fn(async () => acknowledgments),
    hset: vi.fn(async (_key: string, instance: string, value: string) => {
      acknowledgments[instance] = value;
      return 1;
    }),
    publish: vi.fn(async (_channel: string, raw: string) => {
      void f.handoff.handle(raw);
      return 1;
    }),
    set: vi.fn(async (_key: string, id: string) => {
      lockId = id;
      return 'OK';
    }),
  });
  vi.spyOn(f.sources, 'rebasePublication').mockResolvedValue({
    netTokens: 0,
    pendingEffects: [],
    rebasedState: 'state',
    rebasedStateSeedSHA256: 'a'.repeat(64),
  });
  vi.spyOn(f.sources, 'request').mockResolvedValue({ epoch: 2 });
  return f.handoff.publish({
    attemptId: 1,
    checkpoint: 7,
    epoch: 1,
    fileId: 'f',
    jobId: 'job',
    leaseToken: 'lease',
  });
}

test('a silent editor is disconnected after the window and the publication completes', async () => {
  vi.useFakeTimers();
  const f = setup();
  const published = publishThroughRoom(f);
  await vi.advanceTimersByTimeAsync(10_100);
  await expect(published).resolves.toEqual({ epoch: 2 });
  // Like a disconnect: the client reconnects into the new epoch, and unsaved
  // changes land in recovery.
  expect(f.connection.webSocket.close).toHaveBeenCalledWith(
    4408,
    'Source handoff timed out'
  );
  expect(f.persist).toHaveBeenCalledOnce();
  expect(f.document.broadcastStateless).toHaveBeenLastCalledWith(
    expect.stringContaining('"type":"source-epoch-changed"')
  );
});

test('with a ready and a silent editor, only the silent one is closed', async () => {
  vi.useFakeTimers();
  const f = setup();
  const answered = {
    ...f.connection,
    onClose: vi.fn(),
    socketId: 'answered',
    webSocket: { close: vi.fn() },
  };
  Object.assign(f.document, {
    getConnections: () => [f.connection, answered],
  });
  const published = publishThroughRoom(f);
  const broadcast = vi.mocked(f.document.broadcastStateless);
  await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
  const { id } = JSON.parse(broadcast.mock.calls[0][0]) as { id: string };
  expect(
    f.handoff.ready(f.session.room, 'answered', {
      checkpoint: 7,
      clean: true,
      epoch: 1,
      id,
    })
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(10_100);
  await expect(published).resolves.toEqual({ epoch: 2 });
  expect(f.connection.webSocket.close).toHaveBeenCalledWith(
    4408,
    'Source handoff timed out'
  );
  expect(answered.webSocket.close).not.toHaveBeenCalled();
});

test('an editor that disconnects during the handoff no longer fails the publication', async () => {
  vi.useFakeTimers();
  const f = setup();
  const published = publishThroughRoom(f);
  await vi.waitFor(() => expect(f.connection.onClose).toHaveBeenCalled());
  for (const [closed] of f.connection.onClose.mock.calls) closed();
  await vi.advanceTimersByTimeAsync(100);
  await expect(published).resolves.toEqual({ epoch: 2 });
  expect(f.connection.webSocket.close).not.toHaveBeenCalled();
  expect(f.persist).toHaveBeenCalledOnce();
});

test('the coordinator waits for an acknowledgement delayed by a slow persist', async () => {
  vi.useFakeTimers();
  const f = setup();
  // Like a persist queued behind a running save of a large workbook.
  f.persist.mockImplementation(
    () => new Promise((resolve) => setTimeout(resolve, 40_000))
  );
  const published = publishThroughRoom(f);
  await vi.advanceTimersByTimeAsync(50_100);
  await expect(published).resolves.toEqual({ epoch: 2 });
});

test('an editor refused during a publication receives the publishing reason', async () => {
  const server = new Server({
    address: '127.0.0.1',
    async onAuthenticate() {
      throw new SourcePublishingError();
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  const provider = new HocuspocusProvider({
    document: new Y.Doc(),
    name: 'source:f:epoch:1',
    token: 'token',
    url: server.webSocketURL,
  });
  try {
    const reason = await new Promise<string>((resolve) =>
      provider.on('authenticationFailed', (event: { reason: string }) =>
        resolve(event.reason)
      )
    );
    expect(reason).toBe(SOURCE_PUBLISHING_REASON);
  } finally {
    provider.destroy();
    await server.destroy();
  }
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
  await vi.advanceTimersByTimeAsync(185_000);
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
  await vi.advanceTimersByTimeAsync(185_000);
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

test('text publication retains newer edits against the exported text', async () => {
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
  f.pool.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM files')
      ? [{ user_id: 'u' }]
      : sql.includes('source_refresh_candidates')
        ? [{ state: state('Exam Monday') }]
        : [{ published: false }],
  }));
  let published:
    | {
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
      netTokens: 0,
      pendingEffects: [],
      rebasedState: `state${session.checkpoint}`,
      rebasedStateSeedSHA256: 'a'.repeat(64),
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
      netTokens: 0,
      pendingEffects: [],
      rebasedState: 'state8',
      rebasedStateSeedSHA256: 'a'.repeat(64),
    },
    {
      ...receipt,
      expectedLatestCheckpoint: 9,
      netTokens: 0,
      pendingEffects: [],
      rebasedState: 'state9',
      rebasedStateSeedSHA256: 'a'.repeat(64),
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

test.each([
  [true, ['report [hold-publication].docx', 'report.docx'], 'waits'],
  [true, ['report [hold-publication].docx'], 'fails after 60 s'],
  [false, ['report [hold-publication].docx'], 'ignores the marker'],
])('the UAT publication hold (on: %s, names %j) %s', async (on, names) => {
  vi.useFakeTimers();
  const f = setup(on);
  const held: string[] = [];
  f.pool.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT name FROM files')) {
      const name = names[Math.min(held.length, names.length - 1)];
      held.push(name);
      return { rows: [{ name }] };
    }
    return {
      rows: sql.includes('FROM files')
        ? [{ user_id: 'u' }]
        : [{ published: false, system: true }],
    };
  });
  // The handoff lock is taken only once the hold ends.
  const lock = vi.fn(async () => null);
  Object.assign(f.redis, { set: lock });
  const publishing = f.handoff
    .publish({
      attemptId: 1,
      checkpoint: 7,
      epoch: 1,
      fileId: 'f',
      jobId: 'job',
      leaseToken: 'lease',
    })
    .catch((error: unknown) => error);
  // Names are read every 500 ms.
  await vi.advanceTimersByTimeAsync(400);
  if (on) expect(lock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  const error = await publishing;
  if (on && names.length === 1) {
    expect(error).toMatchObject({
      message: 'Publication hold timed out',
      status: 503,
    });
    expect(lock).not.toHaveBeenCalled();
  } else {
    // Past the hold, the busy lock answers 503 as usual.
    expect(error).toMatchObject({ message: 'Source handoff already running' });
    expect(lock).toHaveBeenCalledOnce();
  }
  // Off, the name is never read; on, it is read until the marker is gone.
  if (!on) expect(held).toEqual([]);
  else if (names.length > 1) expect(held).toEqual(names);
  else
    expect(held.every((name) => name.includes(PUBLICATION_HOLD_MARKER))).toBe(
      true
    );
});

const owner = (f: ReturnType<typeof setup>, extra: Record<string, unknown>) =>
  f.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM files')) return { rows: [{ user_id: 'u' }] };
    if (sql.includes("'paidBy'")) return { rows: [{ system: false }] };
    if (sql.includes('rebuild_pending AS pending'))
      return { rows: [{ pending: extra.pending ?? false }] };
    if (sql.includes('source_refresh_candidates'))
      return {
        rows: [
          { state: Buffer.from('captured'), state_seed_sha256: 'a'.repeat(64) },
        ],
      };
    return { rows: [{ published: false }] };
  });

const publicationInput = {
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

test('an owner Office publication defers: no lock or handoff, effects against the capture', async () => {
  const f = setup();
  owner(f, {});
  f.session.checkpoint = 8;
  vi.mocked(f.sources.session).mockImplementation(async () => ({
    ...f.session,
  }));
  const lock = vi.fn();
  Object.assign(f.redis, { set: lock });
  vi.spyOn(f.sources, 'stateOf').mockResolvedValue(new Uint8Array([1]));
  const effects = vi
    .spyOn(f.sources, 'effects')
    .mockImplementation(async (session) => [
      {
        after: `after${session.checkpoint}`,
        before: 'a',
        id: 'p',
        kind: 'text',
        label: 'Paragraph',
        operation: 'replace',
      },
    ]);
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
      return { epoch: 1 };
    });
  await expect(f.handoff.publish(publicationInput)).resolves.toEqual({
    epoch: 1,
  });
  // Editors keep their document: no room lock, no prepare, no epoch change.
  expect(lock).not.toHaveBeenCalled();
  expect(f.document.broadcastStateless).not.toHaveBeenCalled();
  expect(
    effects.mock.calls.map(([session]) => [
      session.checkpoint,
      session.rebuildPending,
      session.publishedState,
      session.publishedStateSeedSHA256,
    ])
  ).toEqual([
    [8, true, Buffer.from('captured').toString('base64'), 'a'.repeat(64)],
    [9, true, Buffer.from('captured').toString('base64'), 'a'.repeat(64)],
  ]);
  const { fileId: _fileId, ...receipt } = publicationInput;
  expect(publish.mock.calls.map((call) => call[2])).toEqual([
    expect.objectContaining({
      ...receipt,
      deferred: true,
      expectedLatestCheckpoint: 8,
    }),
    expect.objectContaining({
      ...receipt,
      deferred: true,
      expectedLatestCheckpoint: 9,
      pendingEffects: [expect.objectContaining({ after: 'after9' })],
    }),
  ]);
});

test('a deferred publication with no later save carries no effects', async () => {
  const f = setup();
  owner(f, {});
  const effects = vi.spyOn(f.sources, 'effects');
  const publish = vi.spyOn(f.sources, 'request').mockResolvedValue({});
  await f.handoff.publish(publicationInput);
  expect(effects).not.toHaveBeenCalled();
  expect(publish.mock.calls[0][2]).toMatchObject({
    deferred: true,
    netTokens: 0,
    pendingEffects: [],
  });
});

function rebuildSetup() {
  const f = setup();
  // Nobody has the room open on this instance.
  f.host.documents.clear();
  owner(f, { pending: true });
  Object.assign(f.session, {
    checkpoint: 9,
    indexedCheckpoint: 7,
    publishedSourceSHA256: 'b'.repeat(64),
    publishedSourceURL: 'https://published',
    rebuildPending: true,
  });
  const order: string[] = [];
  let lockId = '';
  let lockMs = 0;
  Object.assign(f.redis, {
    del: vi.fn(),
    eval: vi.fn(async () => {
      order.push('unlock');
    }),
    hgetall: vi.fn(async () => ({ instance: 'idle' })),
    set: vi.fn(async (_key: string, id: string, _px: 'PX', ms: number) => {
      order.push('lock');
      lockId = id;
      lockMs = ms;
      return 'OK';
    }),
  });
  f.redis.publish.mockImplementation(async (_channel: string, raw: string) => {
    order.push(JSON.parse(raw).type);
    return 1;
  });
  const rebase = vi
    .spyOn(f.sources, 'rebuildPublication')
    .mockImplementation(async () => {
      order.push('rebase');
      return {
        netTokens: 1,
        pendingEffects: [],
        rebasedState: 'rebased',
        rebasedStateSeedSHA256: 'c'.repeat(64),
      };
    });
  const request = vi
    .spyOn(f.sources, 'request')
    .mockImplementation(async (_file, endpoint) => {
      order.push(endpoint);
    });
  return {
    ...f,
    lockId: () => lockId,
    lockMs: () => lockMs,
    order,
    rebase,
    request,
  };
}

test('a rebuild rebases first, then locks only to confirm the room is empty and swap', async () => {
  const f = rebuildSetup();
  await expect(f.handoff.rebuild('f')).resolves.toBe(true);
  expect(f.order).toEqual([
    'rebase',
    'lock',
    'probe',
    'rebuild',
    'complete',
    'unlock',
  ]);
  // The body the gateway's strict schema takes.
  const body = f.request.mock.calls[0][2] as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(
    expect.arrayContaining(rebuildSchema.required)
  );
  expect(
    Object.keys(body).filter(
      (field) => !Object.hasOwn(rebuildSchema.properties, field)
    )
  ).toEqual([]);
  expect(f.request).toHaveBeenCalledWith(
    'f',
    'rebuild',
    {
      epoch: 1,
      expectedCheckpoint: 9,
      netTokens: 1,
      pendingEffects: [],
      publishedSourceSHA256: 'b'.repeat(64),
      state: 'rebased',
      stateSeedSHA256: 'c'.repeat(64),
    },
    expect.any(Number)
  );
  // The swap is abandoned while the room is still locked.
  const timeout = f.request.mock.calls[0][3] as number;
  expect(timeout + 2000).toBeLessThan(f.lockMs());
});

test('a probe answer read late gives the rebuild up before the swap', async () => {
  vi.useFakeTimers();
  // Past the probe window, and past the lock itself.
  for (const lateMs of [3000, 31_000]) {
    const f = rebuildSetup();
    Object.assign(f.redis, {
      hgetall: vi.fn(async () => {
        vi.setSystemTime(Date.now() + lateMs);
        return { instance: 'idle' };
      }),
    });
    await expect(f.handoff.rebuild('f')).resolves.toBe(false);
    expect(f.order).toEqual(['rebase', 'lock', 'probe', 'unlock']);
  }
});

test('a rebuild waits while anyone has the room open, here or elsewhere', async () => {
  // Open on this instance: no rebase, no lock.
  let f = rebuildSetup();
  f.host.documents.set(f.session.room, f.document);
  await expect(f.handoff.rebuild('f')).resolves.toBe(false);
  expect(f.order).toEqual([]);
  // Open on another instance: it answers busy and nothing swaps.
  f = rebuildSetup();
  Object.assign(f.redis, {
    hgetall: vi.fn(async () => ({ instance: 'idle', other: 'busy' })),
  });
  await expect(f.handoff.rebuild('f')).resolves.toBe(false);
  expect(f.order).toEqual(['rebase', 'lock', 'probe', 'unlock']);
  // A save or publication in between: the gateway refuses the swap.
  f = rebuildSetup();
  f.request.mockRejectedValue(new SourceRequestError(409, 'stale'));
  await expect(f.handoff.rebuild('f')).resolves.toBe(false);
  expect(f.order).toEqual(['rebase', 'lock', 'probe', 'unlock']);
  // Nothing pending: not even a session read.
  f = rebuildSetup();
  owner(f, { pending: false });
  await expect(f.handoff.rebuild('f')).resolves.toBe(false);
  expect(f.sources.session).not.toHaveBeenCalled();
});

test('the probe answers busy while a socket authenticates for the room', async () => {
  const f = setup();
  f.host.documents.clear();
  const probe = (id: string) =>
    f.handoff.handle(
      JSON.stringify({ fileId: 'f', id, room: f.session.room, type: 'probe' })
    );
  const done = f.handoff.join(f.session.room, 'joining');
  await probe('first');
  expect(f.redis.hset).toHaveBeenLastCalledWith(
    'capy:source-handoff:first',
    'instance',
    'busy'
  );
  done();
  await probe('second');
  expect(f.redis.hset).toHaveBeenLastCalledWith(
    'capy:source-handoff:second',
    'instance',
    'idle'
  );
});

test('a room still saving is in use: loaded with no connection, or a store pending here', async () => {
  // Loaded with nobody left: a store may still be running before it unloads.
  let f = rebuildSetup();
  f.host.documents.set(f.session.room, {
    ...f.document,
    getConnections: () => [],
  } as unknown as Document);
  await expect(f.handoff.rebuild('f')).resolves.toBe(false);
  expect(f.order).toEqual([]);
  // A failed store waiting for its retry holds edits nobody saved yet.
  f = rebuildSetup();
  const pending = new SourceHandoff(
    'instance',
    f.redis as unknown as Redis,
    f.pool as unknown as Pool,
    f.host as unknown as Hocuspocus,
    f.sources,
    async () => new Set(['instance']),
    f.persist,
    false,
    () => undefined,
    (room) => room === f.session.room
  );
  await expect(pending.rebuild('f')).resolves.toBe(false);
  await pending.handle(
    JSON.stringify({
      fileId: 'f',
      id: 'store',
      room: f.session.room,
      type: 'probe',
    })
  );
  expect(f.redis.hset).toHaveBeenLastCalledWith(
    'capy:source-handoff:store',
    'instance',
    'busy'
  );
});

test('during the maintenance pause a viewer left in the room does not hold the rebuild', async () => {
  const f = rebuildSetup();
  const viewer = { ...f.connection, readOnly: true };
  f.host.documents.set(f.session.room, {
    ...f.document,
    getConnections: () => [viewer],
  } as unknown as Document);
  const query = f.pool.query.getMockImplementation();
  f.pool.query.mockImplementation(async (sql: string, ...rest: unknown[]) =>
    sql.includes('office_editing_pause')
      ? { rows: [{ paused: true }] }
      : query?.(sql, ...rest)
  );
  // Every instance answers the pause's writers-only probe.
  f.redis.publish.mockImplementation(async (_channel: string, raw: string) => {
    const event = JSON.parse(raw);
    f.order.push(event.type);
    if (event.type === 'probe') {
      expect(event.writersOnly).toBe(true);
      await f.handoff.handle(raw);
    }
    return 1;
  });
  Object.assign(f.redis, {
    hgetall: vi.fn(async () => {
      const [, , answer] = f.redis.hset.mock.lastCall ?? [];
      return { instance: answer };
    }),
  });
  await expect(f.handoff.rebuild('f')).resolves.toBe(true);
  expect(f.redis.hset).toHaveBeenLastCalledWith(
    expect.any(String),
    'instance',
    'idle'
  );
});
