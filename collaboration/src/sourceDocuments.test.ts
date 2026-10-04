import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { signCollaborationToken, verifyCollaborationToken } from './auth.js';
import {
  attachDocumentContributorTracker,
  documentContributors,
  roomSnapshot,
} from './contributors.js';
import * as officeRuntime from './officeRuntime.js';
import {
  effectTokens,
  rebuildState,
  SourceDocumentStore,
  SourceRequestError,
  type SourceSession,
  SourceStateRebuildError,
  seedChange,
  textEffects,
  textSeed,
  textState,
  trimEffect,
} from './sourceDocuments.js';
import { lostSourceAccess, sourceSaveRefused } from './storeFailure.js';

const REFRESH_CANDIDATE_PATH = /\/refresh-candidate$/;
const SHA256 = /^[a-f0-9]{64}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('per-update authorization needs only a current access verdict', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const sources = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
  await sources.assertConnectionAccess('source:file_1:epoch:3', 'u_1', 'write');
  expect(fetch).toHaveBeenCalledWith(
    'http://api/internal/collaboration/files/file_1/access?actorId=u_1&epoch=3&edit=true',
    expect.objectContaining({
      headers: expect.objectContaining({ 'X-Collaboration-Secret': 'secret' }),
    })
  );
});

test('a discard that threw unsaved state away moves the file past its epoch', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const sources = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
  await sources.resetEpoch('source:file_1:epoch:3');
  expect(fetch).toHaveBeenCalledWith(
    'http://api/internal/collaboration/files/file_1/epoch-reset',
    expect.objectContaining({ body: '{"epoch":3}', method: 'POST' })
  );
});

test('source tokens bind their epoch and cannot join a material room', () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    access: 'read' as const,
    exp: now + 100,
    iat: now,
    jti: 'test',
    room: 'source:f_1:epoch:2',
    schema: 2,
    sub: 'u_1',
  };
  const token = signCollaborationToken('secret', claims);
  expect(verifyCollaborationToken(token, 'secret', claims.room).access).toBe(
    'read'
  );
  expect(() =>
    verifyCollaborationToken(token, 'secret', 'source:f_1:epoch:1')
  ).toThrow();
  expect(() =>
    verifyCollaborationToken(token, 'secret', 'material:m_1:schema:2')
  ).toThrow();
});

test('text effects retain Unicode, exact line endings, removals and undo cancellation', () => {
  expect(textEffects('a\r\n😀z', 'a\r\n😁z')).toMatchObject([
    { after: '😁', before: '😀', label: 'Text at UTF-16 offset 3' },
  ]);
  expect(textEffects('a\r\n', '')).toMatchObject([
    { after: '', before: 'a\r\n', operation: 'remove' },
  ]);
  expect(textEffects('same', 'same')).toEqual([]);
});

test('Office text effects keep the changed span with 40 characters of context', () => {
  const [head, tail] = ['a'.repeat(50), 'z'.repeat(50)];
  const effect = {
    after: `${head}NEW${tail}`,
    before: `${head}old${tail}`,
    id: 'p',
    kind: 'text',
    label: 'Paragraph',
    operation: 'replace',
  } as const;
  expect(trimEffect(effect)).toMatchObject({
    after: `…${head.slice(10)}NEW${tail.slice(10)}…`,
    before: `…${head.slice(10)}old${tail.slice(10)}…`,
  });
  // A cut never splits a surrogate pair; an addition is its own change.
  const emoji = '😀'.repeat(30);
  expect(
    trimEffect({ ...effect, after: `${emoji}ay`, before: `${emoji}ax` }).before
  ).toBe(`…${'😀'.repeat(20)}ax`);
  expect(
    trimEffect({ ...effect, after: `ya${emoji}`, before: `xa${emoji}` }).before
  ).toBe(`xa${'😀'.repeat(20)}…`);
  const added = { ...effect, before: undefined, operation: 'add' } as const;
  expect(trimEffect(added)).toBe(added);
  // A move keeps its text: it carries none and weighs nothing.
  const moved = trimEffect({
    ...effect,
    after: head,
    before: head,
    operation: 'move',
  });
  expect(moved).toEqual({
    id: 'p',
    kind: 'text',
    label: 'Paragraph',
    operation: 'move',
  });
  expect(effectTokens([moved, { ...moved, kind: 'image' }])).toBe(0);
});

test('an owner at the ingest-job limit rotates the file back, other refusals park it', async () => {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.includes('UNION ALL')
      ? [
          { checkpoint: '3', file_id: 'f_busy', user_id: 'u_1' },
          { checkpoint: '5', file_id: 'f_broke', user_id: 'u_1' },
        ]
      : [],
  }));
  const sources = new SourceDocumentStore(
    { query } as unknown as Pool,
    'http://api',
    'secret'
  );
  vi.spyOn(sources, 'request').mockImplementation((fileId: string) =>
    Promise.reject(
      new SourceRequestError(fileId === 'f_busy' ? 429 : 402, 'refused')
    )
  );
  await sources.scheduleRefreshes();
  const written = (column: string) =>
    query.mock.calls
      .filter(([sql]) => sql.includes(`SET ${column}=`))
      .map(([, params]) => params);
  expect(written('refresh_error')).toEqual([['f_broke', '5', 'refused']]);
  // The refused file rotates behind other due files instead of parking.
  expect(written('last_refresh_requested_at')).toEqual([['f_busy']]);
});

test('a delayed source store merges a newer durable replica before saving', async () => {
  const base = new Y.Doc();
  base.getText('source').insert(0, 'base');
  const seed = Y.encodeStateAsUpdate(base);
  const left = new Y.Doc(),
    right = new Y.Doc();
  Y.applyUpdate(left, seed);
  Y.applyUpdate(right, seed);
  left.getText('source').insert(4, ' A');
  right.getText('source').insert(0, 'B ');
  left
    .getMap('__capy_pending_contributors')
    .set('author', { access: 'write', nonce: 'n', userId: 'u_1' });
  const session: SourceSession = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: createHash('sha256').update('base').digest('hex'),
    checkpoint: 8,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    indexedCheckpoint: 0,
    netTokens: 0,
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'https://unused',
    state: Buffer.from(Y.encodeStateAsUpdate(right)).toString('base64'),
    stateSeedSHA256: null,
    workspaceId: 'ws',
  };
  const store = new SourceDocumentStore({} as Pool, 'http://unused', 'secret');
  vi.spyOn(store, 'session').mockResolvedValue(session);
  // The indexed baseline is the base's text.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('base'))
  );
  let persisted = '';
  vi.spyOn(store, 'request').mockImplementation(
    async (_file, _endpoint, body) => {
      const input = body as {
        state: string;
        expectedCheckpoint: number;
        actorIds: string[];
      };
      expect(input.expectedCheckpoint).toBe(8);
      expect(input.actorIds).toEqual(['u_1']);
      persisted = textState(Buffer.from(input.state, 'base64'));
      return { ...session, checkpoint: 9 };
    }
  );
  const saved = await store.store(session.room, roomSnapshot(left));
  expect(persisted).toBe('B base A');
  expect(saved.checkpoint).toBe(9);
  base.destroy();
  left.destroy();
  right.destroy();
});

test.each([204, 409])(
  'source export normalizes the ETag and handles finalize status %i',
  async (status) => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '\uFEFFa\r\nb');
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    doc.destroy();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (url.includes('refresh-candidate?'))
          return Response.json({
            baseRevision: 1,
            baseSourceSHA256: 'sha',
            baseSourceURL: 'http://base',
            checkpoint: 2,
            epoch: 1,
            fileId: 'f_1',
            format: 'text',
            jobId: 'job_1',
            leaseToken: 'lease',
            sourceBlobPath: 'candidate',
            state,
            stateSeedSHA256: null,
            uploadHeaders: {},
            uploadURL: 'http://upload',
          });
        if (url === 'http://upload') {
          expect(Buffer.from(init!.body as Uint8Array).toString('utf8')).toBe(
            '\uFEFFa\r\nb'
          );
          return new Response(null, {
            headers: { etag: '"candidate-etag"' },
            status: 200,
          });
        }
        const body = JSON.parse(String(init!.body));
        if (url.endsWith('/refresh-failure')) {
          expect(body).toEqual({
            error: 'Source refresh-candidate failed (409)',
            jobId: 'job_1',
            leaseToken: 'lease',
            stale: false,
          });
          return new Response(null, { status: 204 });
        }
        expect(url).toMatch(REFRESH_CANDIDATE_PATH);
        expect(body).toMatchObject({
          checkpoint: 2,
          epoch: 1,
          leaseToken: 'lease',
          sourceETag: 'candidate-etag',
        });
        expect(body).not.toHaveProperty('seedBytes');
        expect(body.sourceSHA256).toMatch(SHA256);
        return new Response(null, { status });
      })
    );
    const store = new SourceDocumentStore(
      {} as Pool,
      'http://gateway',
      'secret'
    );
    const exported = store.exportCandidate('f_1', 'job_1');
    if (status === 204) {
      await expect(exported).resolves.toBeUndefined();
      expect(calls).toHaveLength(3);
    } else {
      await expect(exported).rejects.toThrow(
        'Source refresh-candidate failed (409)'
      );
      expect(calls).toHaveLength(4);
    }
  }
);

test.each([
  [undefined, false],
  [new SourceRequestError(409, 'Source candidate changed'), true],
  [
    new SourceRequestError(
      422,
      'Office rebase: a change at stories/body:4 touches content the export wrote differently'
    ),
    true,
  ],
  [new SourceRequestError(422, 'Source publish failed (422)'), false],
  [new SourceRequestError(503, 'Source handoff already running'), false],
])(
  'an owner export-only candidate publishes through the handoff after finalize (failure %s)',
  async (failure, stale) => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'text');
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    doc.destroy();
    const refused: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('refresh-candidate?'))
          return Response.json({
            baseSourceSHA256: 'sha',
            baseSourceURL: 'http://base',
            checkpoint: 2,
            epoch: 1,
            format: 'text',
            leaseToken: 'lease',
            state,
            uploadHeaders: {},
            uploadURL: 'http://upload',
          });
        if (url === 'http://upload')
          return new Response(null, { headers: { etag: '"etag"' } });
        if (url.endsWith('/refresh-failure'))
          refused.push(JSON.parse(String(init!.body)));
        return new Response(null, { status: 204 });
      })
    );
    const publish = vi.fn(async () => {
      if (failure) throw failure;
    });
    const store = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
    const exported = store.exportCandidate('f_1', 'job_1', publish);
    await (failure
      ? expect(exported).rejects.toBe(failure)
      : expect(exported).resolves.toBeUndefined());
    expect(publish).toHaveBeenCalledWith({
      attemptId: 1,
      checkpoint: 2,
      contentHash: '',
      contentId: '',
      epoch: 1,
      fileId: 'f_1',
      jobId: 'job_1',
      leaseToken: 'lease',
      sourceETag: 'etag',
    });
    // A superseded publication (409) or a refused rebase returns the export
    // to the scheduler (stale); any other refusal parks the file until its
    // next save.
    expect(refused).toHaveLength(failure ? 1 : 0);
    if (failure) expect(refused[0]).toMatchObject({ stale });
  }
);

test('an image replacement keeps a caption only for the same actual bytes', async () => {
  const bytes = Buffer.from('base');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes))
  );
  const old: officeRuntime.NetEffect = {
    assetRef: { format: 'docx', id: 'image', kind: 'image' },
    caption: 'Old image caption',
    id: 'image',
    imageSHA256: 'old-bytes',
    kind: 'image',
    label: 'Image',
    operation: 'replace',
  };
  const unchanged = { ...old, caption: undefined };
  const replacement = { ...old, caption: undefined, imageSHA256: 'new-bytes' };
  // The indexed baseline derives from seed(base) once, then is cached.
  vi.spyOn(officeRuntime, 'runOffice')
    .mockResolvedValueOnce({
      baseSha256: '',
      format: 'docx',
      schemaVersion: 1,
      state: new Uint8Array([0]),
    })
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([unchanged])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([replacement]);
  const session = {
    baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    format: 'docx',
    pendingEffects: [old],
    sourceURL: 'http://base',
  } as SourceSession;
  const store = new SourceDocumentStore({} as Pool, 'http://gateway', 'secret');
  expect((await store.effects(session, new Uint8Array([1])))[0].caption).toBe(
    'Old image caption'
  );
  expect(
    (await store.effects(session, new Uint8Array([2])))[0].caption
  ).toBeUndefined();
});

test('a source edit retries from freshly loaded state after a checkpoint CAS conflict', async () => {
  const store = new SourceDocumentStore({} as Pool, 'http://gateway', 'secret');
  const stateOf = (text: string) => {
    const document = new Y.Doc();
    document.getText('source').insert(0, text);
    return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
  };
  // A saved state always has its base SHA bound.
  const base = {
    access: 'write',
    baseSourceSHA256: 'sha',
    epoch: 1,
    format: 'text',
  } as SourceSession;
  // The second bootstrap sees what another replica committed meanwhile.
  vi.spyOn(store, 'session')
    .mockResolvedValueOnce({
      ...base,
      checkpoint: 3,
      state: stateOf('old text'),
    })
    .mockResolvedValueOnce({
      ...base,
      checkpoint: 4,
      state: stateOf('older text here'),
    });
  vi.spyOn(store, 'effects').mockResolvedValue([]);
  const bodies: Array<{
    expectedCheckpoint: number;
    operation: { inverse: { commands: Array<{ offset: number }> } };
  }> = [];
  vi.spyOn(store, 'request').mockImplementation((async (
    _file: string,
    _action: string,
    body: (typeof bodies)[number]
  ) => {
    bodies.push(body);
    if (bodies.length === 1) throw new SourceRequestError(409, 'stale');
    return { ...base, checkpoint: 5, operation: { operationId: 'op_1' } };
  }) as never);
  const result = await store.applyEdit({
    actorUserId: 'u1',
    commands: [{ expectedText: 'text', text: 'TEXT', type: 'replace_text' }],
    fileId: 'f_1',
    operation: {
      actorUserId: 'u1',
      id: 'op_1',
      requestHash: 'h',
      toolVersion: 1,
    },
  });
  expect(bodies.map((body) => body.expectedCheckpoint)).toEqual([3, 4]);
  // The span was re-resolved on the fresh state, not re-merged from attempt one.
  expect(bodies[0].operation.inverse.commands[0].offset).toBe(4);
  expect(bodies[1].operation.inverse.commands[0].offset).toBe(6);
  expect(result.receipt.operationId).toBe('op_1');
});

test('a NULL state loads seed(base), a save without edits stores nothing, and the first edit reports the seed', async () => {
  const bytes = Buffer.from('﻿base text');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const store = new SourceDocumentStore({} as Pool, 'http://gateway', 'secret');
  const session = {
    access: 'write',
    baseSourceSHA256: '',
    checkpoint: 0,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'http://base',
    state: null,
  } as unknown as SourceSession;
  vi.spyOn(store, 'session').mockResolvedValue(session);
  vi.spyOn(
    store as unknown as { base: () => Promise<Buffer> },
    'base'
  ).mockResolvedValue(bytes);
  const request = vi
    .spyOn(store, 'request')
    .mockResolvedValue({ checkpoint: 1 });
  // Loading, and agent inspect, read the seed and persist nothing.
  expect((await store.inspect('f_1', 'u1')).text).toBe('﻿base text');
  const room = new Y.Doc();
  attachDocumentContributorTracker(room, 'instance');
  const loaded = await store.load(session.room, room, 'u1');
  expect(loaded.baseSourceSHA256).toBe(sha);
  expect(request).not.toHaveBeenCalled();
  // Every instance seeds the same lineage, so replicas merge without
  // duplication. A writer's sync with nothing new still leaves its marker;
  // saving it stores nothing and answers with the current checkpoint.
  const writer = {
    connection: { context: { access: 'write', userId: 'u1' } },
    source: 'connection',
  };
  const other = new Y.Doc();
  await store.load(session.room, other, 'u2');
  Y.applyUpdate(room, Y.encodeStateAsUpdate(other), writer);
  expect(room.getText('source').toString()).toBe('﻿base text');
  expect(documentContributors(room)).toHaveLength(1);
  expect(await store.store(session.room, roomSnapshot(room))).toMatchObject({
    checkpoint: 0,
  });
  expect(request).not.toHaveBeenCalled();
  // One edit makes the next save store the state and its seed size; effects
  // run against the baseline derived from the base.
  room.transact(
    () => room.getText('source').insert(room.getText('source').length, '!'),
    writer
  );
  await store.store(session.room, roomSnapshot(room));
  expect(request).toHaveBeenCalledWith(
    'f_1',
    'checkpoint',
    expect.objectContaining({
      baseSourceSHA256: sha,
      pendingEffects: [expect.objectContaining({ after: '!', before: '' })],
      seedBytes: textSeed(bytes).byteLength,
    })
  );
  room.destroy();
  other.destroy();
});

test('Office rebase uses the captured state and latest saved state, stores the result as its change over seed(export) and retains captions by media hash', async () => {
  const oldSource = Buffer.from('old package'),
    newSource = Buffer.from('parsed package');
  const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const imageSHA256 = 'a'.repeat(64);
  // seed(base), and the captured and saved states as changes over it.
  const base = new Y.Doc();
  base.clientID = 5;
  base.getMap('pptx:slides').set('slide', 'base');
  const baseSeed = Y.encodeStateAsUpdate(base);
  base.clientID = 9;
  base.getMap('pptx:slides').set('slide', 'captured');
  const captured = Y.encodeStateAsUpdate(
    base,
    Y.encodeStateVectorFromUpdate(baseSeed)
  );
  base.getMap('pptx:slides').set('slide', 'saved');
  const saved = Y.encodeStateAsUpdate(
    base,
    Y.encodeStateVectorFromUpdate(baseSeed)
  );
  base.destroy();
  const session: SourceSession = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: digest(oldSource),
    checkpoint: 11,
    epoch: 1,
    fileId: 'f',
    format: 'pptx',
    indexedCheckpoint: 0,
    netTokens: 0,
    pendingEffects: [
      {
        caption: 'A saved caption',
        id: 'old-id',
        imageSHA256,
        kind: 'image',
        label: 'Picture',
        operation: 'add',
      },
    ],
    room: 'source:f:epoch:1',
    sourceURL: 'http://old-source',
    state: Buffer.from(saved).toString('base64'),
    stateSeedSHA256: digest(baseSeed),
    workspaceId: 'ws',
  };
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        {
          source_sha256: digest(newSource),
          state: Buffer.from(captured),
          state_seed_sha256: digest(baseSeed),
        },
      ],
    })),
  };
  const sources = new SourceDocumentStore(
    pool as unknown as Pool,
    'http://api',
    'secret'
  );
  const request = vi
    .spyOn(sources, 'request')
    .mockResolvedValue({ sourceURL: 'http://new-source' });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url === session.sourceURL ? oldSource : newSource)
    )
  );
  const [head, tail] = ['a'.repeat(50), 'z'.repeat(50)];
  // seed(export), and the rebased state: that seed plus a later edit.
  const exported = new Y.Doc();
  exported.clientID = 7;
  exported.getMap('pptx:slides').set('slide', 'seeded');
  const seed = Y.encodeStateAsUpdate(exported);
  exported.clientID = 11;
  exported.getMap('pptx:slides').set('later', 'edit');
  const rebased = Y.encodeStateAsUpdate(exported);
  const change = Y.encodeStateAsUpdate(
    exported,
    Y.encodeStateVectorFromUpdate(seed)
  );
  exported.destroy();
  const rebase = {
    effects: [
      {
        id: 'new-id',
        imageSHA256,
        kind: 'image',
        label: 'Picture',
        operation: 'add',
      },
      {
        after: `${head}NEW${tail}`,
        before: `${head}old${tail}`,
        id: 'text-id',
        kind: 'text',
        label: 'Paragraph',
        operation: 'replace',
      },
    ],
    state: rebased,
  };
  const runtime = vi
    .spyOn(officeRuntime, 'runOffice')
    .mockImplementation((async (name: string, ...args: unknown[]) =>
      name === 'seedOffice'
        ? {
            state: oldSource.equals(args[1] as Uint8Array) ? baseSeed : seed,
          }
        : rebase) as typeof officeRuntime.runOffice);
  const result = await sources.rebasePublication(session, {
    checkpoint: 10,
    epoch: 1,
    jobId: 'job',
    leaseToken: 'lease',
  });
  expect(request).toHaveBeenCalledWith(
    'f',
    'refresh-source?jobId=job&leaseToken=lease'
  );
  expect(runtime).toHaveBeenCalledWith(
    'rebaseOffice',
    oldSource,
    expect.objectContaining({ state: rebuildState(baseSeed, captured) }),
    expect.objectContaining({ state: rebuildState(baseSeed, saved) }),
    newSource
  );
  expect(runtime).toHaveBeenCalledWith('seedOffice', 'pptx', newSource);
  expect(result).toMatchObject({
    rebasedState: Buffer.from(change).toString('base64'),
    rebasedStateSeedSHA256: digest(seed),
  });
  // Rebased text effects are trimmed, and netTokens counts the trimmed text.
  expect(result.pendingEffects).toMatchObject([
    { caption: 'A saved caption', id: 'new-id' },
    {
      after: `…${head.slice(10)}NEW${tail.slice(10)}…`,
      before: `…${head.slice(10)}old${tail.slice(10)}…`,
      id: 'text-id',
    },
  ]);
  expect(result.netTokens).toBe(effectTokens(result.pendingEffects));
  runtime.mockClear();
  request.mockClear();
  const same = await sources.rebasePublication(
    { ...session, checkpoint: 10 },
    { checkpoint: 10, epoch: 1, jobId: 'job', leaseToken: 'lease' }
  );
  // No save after the capture: the state goes back to NULL, meaning
  // seed(export).
  expect(same).toEqual({ netTokens: 0, pendingEffects: [] });
  expect(runtime).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test('only an engine refusal ends a publication rebase with a 422; any other engine error stays a 500', async () => {
  const oldSource = Buffer.from('old package');
  const newSource = Buffer.from('parsed package');
  const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const base = new Y.Doc();
  base.clientID = 5;
  base.getMap('stories').set('body', 'seeded');
  const seed = Y.encodeStateAsUpdate(base);
  base.clientID = 9;
  base.getMap('stories').set('body', 'saved');
  const saved = Y.encodeStateAsUpdate(
    base,
    Y.encodeStateVectorFromUpdate(seed)
  );
  base.destroy();
  const sources = new SourceDocumentStore(
    {
      query: vi.fn(async () => ({
        rows: [
          {
            source_sha256: digest(newSource),
            state: Buffer.from(saved),
            state_seed_sha256: digest(seed),
          },
        ],
      })),
    } as unknown as Pool,
    'http://api',
    'secret'
  );
  vi.spyOn(sources, 'request').mockResolvedValue({
    sourceURL: 'http://new-source',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url === 'http://old-source' ? oldSource : newSource)
    )
  );
  const publish = (message: string) => {
    vi.spyOn(officeRuntime, 'runOffice').mockImplementation((async (
      name: string
    ) => {
      if (name === 'seedOffice') return { state: seed };
      throw new officeRuntime.OfficeEngineError(message);
    }) as typeof officeRuntime.runOffice);
    return sources
      .rebasePublication(
        {
          baseSourceSHA256: digest(oldSource),
          checkpoint: 11,
          epoch: 1,
          fileId: 'f',
          format: 'docx',
          pendingEffects: [],
          sourceURL: 'http://old-source',
          state: Buffer.from(saved).toString('base64'),
          stateSeedSHA256: digest(seed),
        } as unknown as SourceSession,
        { checkpoint: 10, epoch: 1, jobId: 'job', leaseToken: 'lease' }
      )
      .catch((error: unknown) => error);
  };
  const refused = await publish(
    'Office rebase: a change at stories/body:4 touches content the export wrote differently'
  );
  expect(refused).toBeInstanceOf(SourceRequestError);
  expect(refused).toMatchObject({ status: 422 });
  // A timeout or trap is not a refusal: the server answers 500 and the
  // refresh job retries it.
  const failed = await publish('Office rebaseOffice timed out');
  expect(failed).toBeInstanceOf(officeRuntime.OfficeEngineError);
  expect(failed).not.toBeInstanceOf(SourceRequestError);
});

test('an Office state that names no seed is refused on every read, a candidate included', async () => {
  const sources = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
  const read = {
    baseSourceSHA256: 'a'.repeat(64),
    sourceURL: 'http://base',
    state: Buffer.from('whole').toString('base64'),
    stateSeedSHA256: null,
  };
  await expect(
    sources.stateOf({ ...read, format: 'pptx' })
  ).rejects.toBeInstanceOf(SourceStateRebuildError);
  // A text state is complete as stored.
  expect(
    Buffer.from(await sources.stateOf({ ...read, format: 'text' })).toString()
  ).toBe('whole');
  // A publication whose captured candidate names no seed never reaches the
  // engine.
  const [oldSource, newSource] = [Buffer.from('old'), Buffer.from('parsed')];
  const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const candidates = new SourceDocumentStore(
    {
      query: vi.fn(async () => ({
        rows: [
          {
            source_sha256: digest(newSource),
            state: Buffer.from('whole'),
            state_seed_sha256: null,
          },
        ],
      })),
    } as unknown as Pool,
    'http://api',
    'secret'
  );
  vi.spyOn(candidates, 'request').mockResolvedValue({
    sourceURL: 'http://new-source',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url === read.sourceURL ? oldSource : newSource)
    )
  );
  const runtime = vi.spyOn(officeRuntime, 'runOffice');
  await expect(
    candidates.rebasePublication(
      {
        ...read,
        baseSourceSHA256: digest(oldSource),
        checkpoint: 11,
        epoch: 1,
        fileId: 'f',
        format: 'docx',
        pendingEffects: [],
        stateSeedSHA256: 'c'.repeat(64),
      } as unknown as SourceSession,
      { checkpoint: 10, epoch: 1, jobId: 'job', leaseToken: 'lease' }
    )
  ).rejects.toBeInstanceOf(SourceStateRebuildError);
  expect(runtime).not.toHaveBeenCalled();
});

test('a save starts from the durable copy while the row names it, and reads the session again once it does not', async () => {
  const text = (value: string) => {
    const document = new Y.Doc();
    document.clientID = 0;
    document.getText('source').insert(0, value);
    return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
  };
  let row = 3;
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        { base_revision: '1', checkpoint: String(row), pending_effects: [] },
      ],
    })),
  } as unknown as Pool;
  // The baseline derives from the base, which the first save downloads.
  const bytes = Buffer.from('base');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes))
  );
  const store = new SourceDocumentStore(pool, 'http://gateway', 'secret');
  const session = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    checkpoint: 3,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'http://unused',
    state: text('base'),
    stateSeedSHA256: null,
  } as unknown as SourceSession;
  const sessions = vi.spyOn(store, 'session').mockResolvedValue(session);
  const saved: { expectedCheckpoint: number; state: string }[] = [];
  vi.spyOn(store, 'request').mockImplementation((async (
    _file: string,
    _endpoint: string,
    body: (typeof saved)[number]
  ) => {
    saved.push(body);
    row = body.expectedCheckpoint + 1;
    return { checkpoint: row };
  }) as never);
  const room = new Y.Doc();
  attachDocumentContributorTracker(room, 'instance');
  await store.load(session.room, room, 'u1');
  const writer = {
    connection: { context: { access: 'write', userId: 'u1' } },
    source: 'connection',
  };
  const type = (value: string) => {
    room.transact(() => room.getText('source').insert(0, value), writer);
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(room));
    return store.store(session.room, roomSnapshot(snapshot));
  };
  await type('A ');
  await type('B ');
  // Loading and the first save read the session; the second save started
  // from this instance's copy.
  expect(sessions).toHaveBeenCalledTimes(2);
  expect(saved.map((body) => body.expectedCheckpoint)).toEqual([3, 4]);
  // Another instance saved: the row names checkpoint 9, which is read again
  // and merged instead of overwritten.
  row = 9;
  const elsewhere = new Y.Doc();
  Y.applyUpdate(elsewhere, Buffer.from(text('base'), 'base64'));
  elsewhere.getText('source').insert(4, ' elsewhere');
  sessions.mockResolvedValue({
    ...session,
    checkpoint: 9,
    state: Buffer.from(Y.encodeStateAsUpdate(elsewhere)).toString('base64'),
  });
  await type('C ');
  expect(sessions).toHaveBeenCalledTimes(3);
  expect(saved[2].expectedCheckpoint).toBe(9);
  expect(textState(Buffer.from(saved[2].state, 'base64'))).toBe(
    'C B A base elsewhere'
  );
  room.destroy();
});

// A document merged over several saves (durable state, then the room) can keep
// adjacent deleted structs apart where a fresh document merges them; the
// content is the same, so the stored change must be accepted every time.
test('a state merged over several saves is stored as its change over the seed', () => {
  const seedDoc = new Y.Doc();
  seedDoc.clientID = 0;
  seedDoc.getMap('shapes').set('base', 1);
  const seed = Y.encodeStateAsUpdate(seedDoc);
  const room = new Y.Doc();
  room.clientID = 7;
  Y.applyUpdate(room, seed);
  const shapes = room.getMap<Y.Map<number>>('shapes');
  const replace = (key: string, x: number) => {
    const shape = new Y.Map<number>();
    shapes.set(key, shape);
    shape.set('x', x);
  };
  let durable = seed;
  let layouts = 0;
  const save = () => {
    const merged = new Y.Doc();
    Y.applyUpdate(merged, durable);
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(room));
    const state = Y.encodeStateAsUpdate(merged);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, state);
    const canonical = Y.encodeStateAsUpdate(fresh);
    if (!Buffer.from(state).equals(canonical)) layouts++;
    expect(
      Buffer.from(rebuildState(seed, seedChange(seed, state))).equals(canonical)
    ).toBe(true);
    durable = state;
    merged.destroy();
    fresh.destroy();
  };
  replace('a', 8);
  replace('b', 4);
  shapes.get('a')?.set('x', 3);
  replace('b', 5);
  save();
  shapes.get('b')?.set('x', 7);
  shapes.get('a')?.set('x', 5);
  save();
  replace('a', 2);
  save();
  save();
  // The case exists: some merged state differs from its fresh encoding.
  expect(layouts).toBeGreaterThan(0);
  room.destroy();
});

// A text publication moves the base (and indexed checkpoint) but not the
// checkpoint or epoch: the next save reads the session again, so effects are
// computed against the published text.
test('after a text publication a save reads the session again and counts only the new edit', async () => {
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const oldBase = Buffer.from('hello');
  const newBase = Buffer.from('A hello');
  let row = { base_revision: '1', checkpoint: '3', pending_effects: [] };
  const pool = {
    query: vi.fn(async () => ({ rows: [row] })),
  } as unknown as Pool;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url === 'http://old' ? oldBase : newBase)
    )
  );
  const store = new SourceDocumentStore(pool, 'http://gateway', 'secret');
  let session = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: sha(oldBase),
    checkpoint: 3,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    indexedCheckpoint: 0,
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'http://old',
    state: Buffer.from(textSeed(oldBase)).toString('base64'),
    stateSeedSHA256: null,
  } as unknown as SourceSession;
  const sessions = vi.spyOn(store, 'session').mockImplementation(async () => ({
    ...session,
    checkpoint: Number(row.checkpoint),
  }));
  const saved: {
    expectedCheckpoint: number;
    pendingEffects: { after?: string }[];
  }[] = [];
  vi.spyOn(store, 'request').mockImplementation((async (
    _file: string,
    _endpoint: string,
    body: (typeof saved)[number]
  ) => {
    saved.push(body);
    row = { ...row, checkpoint: String(body.expectedCheckpoint + 1) };
    return { checkpoint: body.expectedCheckpoint + 1 };
  }) as never);
  const room = new Y.Doc();
  attachDocumentContributorTracker(room, 'instance');
  await store.load(session.room, room, 'u1');
  const writer = {
    connection: { context: { access: 'write', userId: 'u1' } },
    source: 'connection',
  };
  const type = (value: string) => {
    room.transact(() => room.getText('source').insert(0, value), writer);
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(room));
    return store.store(session.room, roomSnapshot(snapshot));
  };
  await type('A ');
  const reads = sessions.mock.calls.length;
  // Checkpoint 4 publishes as "A hello" (source_refresh.go, text branch).
  row = { ...row, base_revision: '2' };
  session = {
    ...session,
    baseRevision: 2,
    baseSourceSHA256: sha(newBase),
    indexedCheckpoint: 4,
    sourceURL: 'http://new',
  };
  await type('B ');
  expect(sessions.mock.calls.length).toBe(reads + 1);
  expect(saved[1].pendingEffects.map((effect) => effect.after)).toEqual(['B ']);
  room.destroy();
});

// A replayed agent edit answers with the row's checkpoint and stores nothing,
// so its recomputed state must not stand in for the row on the next save.
// A replayed agent edit answers with a checkpoint (the row's, or a later one
// when another commit raced it) and stores nothing, so its recomputed state
// must not stand in for the row on the next save.
test.each([4, 5])(
  'a replayed agent edit answered with checkpoint %i leaves no durable copy behind',
  async (answered) => {
    const stateOf = (text: string) => {
      const document = new Y.Doc();
      document.clientID = 0;
      document.getText('source').insert(0, text);
      return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
    };
    const bytes = Buffer.from('text');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes))
    );
    const pool = {
      query: vi.fn(async () => ({
        // The row names the answered checkpoint, which a kept copy would match.
        rows: [
          {
            base_revision: '1',
            checkpoint: String(answered),
            pending_effects: [],
          },
        ],
      })),
    } as unknown as Pool;
    const store = new SourceDocumentStore(pool, 'http://gateway', 'secret');
    const session = {
      access: 'write',
      baseRevision: 1,
      baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
      checkpoint: 4,
      epoch: 1,
      fileId: 'f_1',
      format: 'text',
      pendingEffects: [],
      room: 'source:f_1:epoch:1',
      sourceURL: 'http://base',
      state: stateOf('text'),
      stateSeedSHA256: null,
    } as unknown as SourceSession;
    const sessions = vi.spyOn(store, 'session').mockResolvedValue(session);
    const request = vi.spyOn(store, 'request').mockResolvedValue({
      checkpoint: answered,
      operation: { operationId: 'op_1' },
    });
    await store.applyEdit({
      actorUserId: 'u1',
      commands: [{ expectedText: 'text', text: 'TEXT', type: 'replace_text' }],
      fileId: 'f_1',
      operation: {
        actorUserId: 'u1',
        id: 'op_1',
        requestHash: 'h',
        toolVersion: 1,
      },
    });
    const room = new Y.Doc();
    attachDocumentContributorTracker(room, 'instance');
    Y.applyUpdate(room, Buffer.from(session.state as string, 'base64'));
    room.transact(() => room.getText('source').insert(0, 'more '), {
      connection: { context: { access: 'write', userId: 'u1' } },
      source: 'connection',
    });
    request.mockResolvedValue({ checkpoint: 6 });
    await store.store(session.room, roomSnapshot(room));
    // The store read the session again instead of trusting the replayed state.
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(
      textState(
        Buffer.from(
          (request.mock.calls.at(-1)?.[2] as { state: string } | undefined)
            ?.state as string,
          'base64'
        )
      )
    ).toBe('more text');
    room.destroy();
  }
);

// A rebuild that cannot hold (a change missing from its seed) is an Office
// engine error: reported with drafts kept, never retried by the failed-store
// runner (server.ts storeSource).
test('a change that does not rebuild from its seed is an engine error', () => {
  const seedDoc = new Y.Doc();
  seedDoc.clientID = 0;
  seedDoc.getText('source').insert(0, 'seed');
  const seed = Y.encodeStateAsUpdate(seedDoc);
  const other = new Y.Doc();
  other.clientID = 0;
  other.getText('source').insert(0, 'another lineage');
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Y.encodeStateAsUpdate(other));
  edited.clientID = 9;
  edited.getText('source').insert(0, 'X');
  // The change refers to items only the other lineage has.
  const change = Y.encodeStateAsUpdate(
    edited,
    Y.encodeStateVectorFromUpdate(Y.encodeStateAsUpdate(other))
  );
  const refused = (() => {
    try {
      rebuildState(Y.encodeStateAsUpdate(new Y.Doc()), change);
    } catch (error) {
      return error;
    }
  })();
  expect(refused).toBeInstanceOf(SourceStateRebuildError);
  expect(refused).toBeInstanceOf(officeRuntime.OfficeEngineError);
  expect(() => seedChange(seed, Y.encodeStateAsUpdate(seedDoc))).not.toThrow();
  seedDoc.destroy();
  other.destroy();
  edited.destroy();
});

// A room that unloads forgets its durable copy: the next load starts over.
test('a forgotten room saves from a fresh session read', async () => {
  const bytes = Buffer.from('base');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes))
  );
  const pool = {
    query: vi.fn(async () => ({
      rows: [{ base_revision: '1', checkpoint: '3', pending_effects: [] }],
    })),
  } as unknown as Pool;
  const store = new SourceDocumentStore(pool, 'http://gateway', 'secret');
  const session = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    checkpoint: 3,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'http://base',
    state: Buffer.from(textSeed(bytes)).toString('base64'),
    stateSeedSHA256: null,
  } as unknown as SourceSession;
  const sessions = vi.spyOn(store, 'session').mockResolvedValue(session);
  vi.spyOn(store, 'request').mockResolvedValue({ checkpoint: 4 });
  const room = new Y.Doc();
  attachDocumentContributorTracker(room, 'instance');
  // Warm the base, so only the forgotten copy can send the save to a read.
  await store.seed(session);
  await store.load(session.room, room, 'u1');
  store.forget(session.room);
  room.transact(() => room.getText('source').insert(0, 'A '), {
    connection: { context: { access: 'write', userId: 'u1' } },
    source: 'connection',
  });
  await store.store(session.room, roomSnapshot(room));
  expect(sessions).toHaveBeenCalledTimes(2);
  room.destroy();
});

// An ended epoch is final but not lost access: the save is not retried, and
// a retry that finds a newer epoch reports epoch_changed, not a 403, so the
// browsers keep their drafts in recovery instead of dropping them.
test('a save over an ended epoch fails as epoch_changed without retrying', async () => {
  const store = new SourceDocumentStore({} as Pool, 'http://gateway', 'secret');
  const session = {
    access: 'write',
    baseSourceSHA256: 'sha',
    checkpoint: 3,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'http://base',
    state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64'),
  } as unknown as SourceSession;
  vi.spyOn(store, 'effects').mockResolvedValue([]);
  const room = new Y.Doc();
  attachDocumentContributorTracker(room, 'instance');
  const writer = {
    connection: { context: { access: 'write', userId: 'u1' } },
    source: 'connection',
  };
  room.transact(() => room.getText('source').insert(0, 'typed'), writer);

  // The gateway refuses the epoch: one attempt, no retry.
  vi.spyOn(store, 'session').mockResolvedValue(session);
  const ended = vi
    .spyOn(store, 'request')
    .mockRejectedValue(
      new SourceRequestError(409, 'Source epoch changed', 'epoch_changed')
    );
  await expect(
    store.store(session.room, roomSnapshot(room))
  ).rejects.toMatchObject({
    code: 'epoch_changed',
  });
  expect(ended).toHaveBeenCalledTimes(1);

  // A moved checkpoint retries, and the retry finds the next epoch.
  vi.spyOn(store, 'session')
    .mockResolvedValueOnce(session)
    .mockResolvedValueOnce({ ...session, epoch: 2 });
  vi.spyOn(store, 'request').mockRejectedValue(
    new SourceRequestError(409, 'Source checkpoint moved', 'checkpoint_moved')
  );
  const error = await store
    .store(session.room, roomSnapshot(room))
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'epoch_changed', status: 409 });
  expect(lostSourceAccess(error)).toBe(false);
  expect(sourceSaveRefused(error)).toBe(true);
  room.destroy();
});
