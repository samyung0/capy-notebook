import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { signCollaborationToken, verifyCollaborationToken } from './auth.js';
import * as officeRuntime from './officeRuntime.js';
import {
  SourceDocumentStore,
  type SourceSession,
  textEffects,
  textState,
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

test('source tokens bind their epoch and cannot make Plate read tokens', () => {
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
  const plate = { ...claims, room: 'material:m_1:schema:2' };
  expect(() =>
    verifyCollaborationToken(
      signCollaborationToken('secret', plate),
      'secret',
      plate.room
    )
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
    indexedCheckpoint: 0,
    indexedState: Buffer.from(seed).toString('base64'),
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

test('source export accepts the gateway empty finalize response without discarding queued work', async () => {
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
      expect(url).toMatch(REFRESH_CANDIDATE_PATH);
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({
        checkpoint: 2,
        epoch: 1,
        leaseToken: 'lease',
        seed: state,
        sourceETag: '"candidate-etag"',
      });
      expect(body.sourceSHA256).toMatch(SHA256);
      return new Response(null, { status: 204 });
    })
  );
  const store = new SourceDocumentStore({} as Pool, 'http://gateway', 'secret');
  await expect(store.exportCandidate('f_1', 'job_1')).resolves.toBeUndefined();
  expect(calls).toHaveLength(3);
});

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
    .mockResolvedValueOnce([unchanged])
    .mockResolvedValueOnce([replacement]);
  const session = {
    baseSourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    format: 'docx',
    indexedState: 'AA==',
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
