import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { signCollaborationToken, verifyCollaborationToken } from './auth.js';
import * as officeRuntime from './officeRuntime.js';
import {
  effectTokens,
  encodeBaseline,
  SourceDocumentStore,
  SourceRequestError,
  type SourceSession,
  textEffects,
  textSeed,
  textState,
  trimEffect,
} from './sourceDocuments.js';

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
    baseSourceSHA256: 'sha',
    checkpoint: 8,
    epoch: 1,
    fileId: 'f_1',
    format: 'text',
    indexedBaseline: encodeBaseline({
      format: 'text',
      text: 'base',
      version: 1,
    }),
    indexedCheckpoint: 0,
    netTokens: 0,
    pendingEffects: [],
    room: 'source:f_1:epoch:1',
    sourceURL: 'https://unused',
    state: Buffer.from(Y.encodeStateAsUpdate(right)).toString('base64'),
    workspaceId: 'ws',
  };
  const store = new SourceDocumentStore({} as Pool, 'http://unused', 'secret');
  vi.spyOn(store, 'session').mockResolvedValue(session);
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
  const saved = await store.store(session.room, left);
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
          seedBytes: Buffer.from(state, 'base64').byteLength,
          sourceETag: 'candidate-etag',
        });
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
    // A superseded publication (409) returns the export to the scheduler
    // (stale); any other refusal parks the file until its next save.
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
  vi.spyOn(officeRuntime, 'runOffice')
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([unchanged])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([replacement]);
  const session = {
    baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    format: 'docx',
    indexedBaseline: encodeBaseline({
      entries: [],
      format: 'docx',
      version: 1,
    }),
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
  const base = { access: 'write', epoch: 1, format: 'text' } as SourceSession;
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

test('a NULL state loads seed(base) and saves nothing until the first save reports the seed', async () => {
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
    indexedBaseline: null,
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
  const loaded = await store.load(session.room, room, 'u1');
  expect(loaded.baseSourceSHA256).toBe(sha);
  expect(request).not.toHaveBeenCalled();
  // Every instance seeds the same lineage, so replicas merge without duplication.
  const other = new Y.Doc();
  await store.load(session.room, other, 'u2');
  Y.applyUpdate(room, Y.encodeStateAsUpdate(other));
  expect(room.getText('source').toString()).toBe('﻿base text');
  // The first save stores the state and its seed size; effects run against
  // the baseline derived from the base.
  room.getText('source').insert(room.getText('source').length, '!');
  room
    .getMap('__capy_pending_contributors')
    .set('author', { access: 'write', nonce: 'n', userId: 'u1' });
  await store.store(session.room, room);
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

test('Office rebase uses the captured state and latest saved state, retaining captions by media hash', async () => {
  const oldSource = Buffer.from('old package'),
    newSource = Buffer.from('parsed package');
  const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const imageSHA256 = 'a'.repeat(64);
  const session: SourceSession = {
    access: 'write',
    baseRevision: 1,
    baseSourceSHA256: digest(oldSource),
    checkpoint: 11,
    epoch: 1,
    fileId: 'f',
    format: 'pptx',
    indexedBaseline: '',
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
    state: Buffer.from('saved11').toString('base64'),
    workspaceId: 'ws',
  };
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        { source_sha256: digest(newSource), state: Buffer.from('captured10') },
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
  const runtime = vi.spyOn(officeRuntime, 'runOffice').mockResolvedValue({
    baseline: [],
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
    state: Buffer.from('rebased11'),
  });
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
    expect.objectContaining({ state: Buffer.from('captured10') }),
    expect.objectContaining({ state: Buffer.from('saved11') }),
    newSource
  );
  expect(result).toMatchObject({
    indexedBaseline: encodeBaseline({
      entries: [],
      format: 'pptx',
      version: 1,
    }),
    rebasedState: Buffer.from('rebased11').toString('base64'),
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
  // No save after the capture: the state and baseline go back to NULL, meaning
  // seed(export) and its derived baseline.
  expect(same).toEqual({ netTokens: 0, pendingEffects: [] });
  expect(runtime).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
