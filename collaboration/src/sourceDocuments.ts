import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import * as Y from 'yjs';
import { type CollaborationAccess, SOURCE_ROOM_PATTERN } from './auth.js';
import {
  documentContributors,
  removeDocumentContributors,
} from './contributors.js';
import {
  type NetEffect,
  type OfficeCheckpoint,
  runOffice,
  type SourceFormat,
} from './officeRuntime.js';

export const MAX_SOURCE_STATE_BYTES = 100 * 1024 * 1024;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/u;
const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export interface SourceSession {
  access: 'read' | 'write';
  baseRevision: number;
  baseSourceSHA256: string;
  checkpoint: number;
  epoch: number;
  fileId: string;
  format: SourceFormat;
  indexedCheckpoint: number;
  indexedState: string;
  netTokens: number;
  pendingEffects: NetEffect[];
  room: string;
  sourceURL: string;
  state: string;
  workspaceId: string;
}
export interface RefreshCandidate {
  baseRevision: number;
  baseSourceSHA256: string;
  baseSourceURL: string;
  checkpoint: number;
  epoch: number;
  fileId: string;
  format: SourceFormat;
  jobId: string;
  leaseToken: string;
  sourceBlobPath: string;
  state: string;
  uploadHeaders: Record<string, string>;
  uploadURL: string;
}
export class SourceRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sourceRoom(room: string) {
  const match = SOURCE_ROOM_PATTERN.exec(room);
  if (!match) throw new Error('Invalid source room');
  return { epoch: Number(match[2]), fileId: match[1] };
}

export function textState(state: Uint8Array) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    return document.getText('source').toString();
  } finally {
    document.destroy();
  }
}

export function textEffects(before: string, after: string): NetEffect[] {
  if (before === after) return [];
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;
  if (prefix > 0 && LOW_SURROGATE.test(before[prefix] ?? '')) prefix--;
  let endBefore = before.length,
    endAfter = after.length;
  while (
    endBefore > prefix &&
    endAfter > prefix &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  if (endBefore < before.length && LOW_SURROGATE.test(before[endBefore])) {
    endBefore++;
    endAfter++;
  }
  // Keep exact authored strings. A contiguous replacement is deliberately
  // simpler than a dirty-range planner and still describes the complete delta.
  const removed = before.slice(prefix, endBefore),
    inserted = after.slice(prefix, endAfter);
  return [
    {
      after: inserted,
      before: removed,
      id: createHash('sha256')
        .update(JSON.stringify([prefix, removed, inserted]))
        .digest('hex'),
      kind: 'text',
      label: `Text at UTF-16 offset ${prefix}`,
      operation: removed ? (inserted ? 'replace' : 'remove') : 'add',
    },
  ];
}

export function effectTokens(effects: NetEffect[]) {
  return effects.reduce((sum, effect) => {
    const text = `${effect.before ?? ''}${effect.after ?? ''}${effect.caption ?? ''}`;
    const cjk = [...text].filter((char) => CJK_CHARACTER.test(char)).length;
    return (
      sum +
      Math.ceil((text.length - cjk) / 4) +
      cjk +
      (effect.kind === 'text' ? 0 : 1)
    );
  }, 0);
}

export async function readSourceBytes(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error('Source download failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SOURCE_STATE_BYTES)
        throw new Error('Source exceeds the supported byte limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

export class SourceDocumentStore {
  private readonly bases = new Map<string, Buffer>();
  private baseBytes = 0;
  private readonly pool: Pool;
  private readonly apiURL: string;
  private readonly secret: string;
  constructor(pool: Pool, apiURL: string, secret: string) {
    this.pool = pool;
    this.apiURL = apiURL;
    this.secret = secret;
  }

  private async base(url: string, sha: string) {
    const cached = sha ? this.bases.get(sha) : undefined;
    if (cached) {
      this.bases.delete(sha);
      this.bases.set(sha, cached);
      return cached;
    }
    const bytes = await readSourceBytes(url);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (sha && actual !== sha) throw new Error('Source SHA mismatch');
    // Sessions authorize access before this lookup. Immutable byte identity
    // lets checkpoint comparisons reuse a bounded set of downloaded bases.
    const budget = 128 * 1024 * 1024;
    while (this.baseBytes + bytes.length > budget && this.bases.size) {
      const oldest = this.bases.keys().next().value!;
      this.baseBytes -= this.bases.get(oldest)!.length;
      this.bases.delete(oldest);
    }
    if (!this.bases.has(actual)) {
      this.bases.set(actual, bytes);
      this.baseBytes += bytes.length;
    }
    return bytes;
  }

  async request<T>(
    fileId: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(
      `${this.apiURL}/internal/collaboration/files/${encodeURIComponent(fileId)}/${endpoint}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Collaboration-Secret': this.secret,
        },
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      }
    );
    if (!response.ok)
      throw new SourceRequestError(
        response.status,
        `Source ${endpoint.split('?')[0]} failed (${response.status})`
      );
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async session(fileId: string, actorId: string) {
    return this.request<SourceSession>(
      fileId,
      `bootstrap?actorId=${encodeURIComponent(actorId)}`
    );
  }

  async assertConnectionAccess(
    room: string,
    actorId: string,
    access: CollaborationAccess
  ) {
    const { fileId, epoch } = sourceRoom(room);
    await this.request<void>(
      fileId,
      `access?actorId=${encodeURIComponent(actorId)}&epoch=${epoch}&edit=${access === 'write'}`
    );
  }

  private async sessionForRoom(
    room: string,
    actorId: string,
    access: CollaborationAccess
  ) {
    const { fileId, epoch } = sourceRoom(room);
    const session = await this.session(fileId, actorId);
    if (
      session.epoch !== epoch ||
      (access === 'write' && session.access !== 'write')
    ) {
      throw new SourceRequestError(403, 'Source access or epoch changed');
    }
    return session;
  }

  async load(room: string, document: Y.Doc, actorId: string) {
    let session = await this.sessionForRoom(room, actorId, 'comment');
    if (!session.state) {
      const bytes = await this.base(
        session.sourceURL,
        session.baseSourceSHA256
      );
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (session.baseSourceSHA256 && sha !== session.baseSourceSHA256)
        throw new Error('Source SHA mismatch');
      let state: Uint8Array;
      if (session.format === 'text') {
        const initial = new Y.Doc();
        initial
          .getText('source')
          .insert(
            0,
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              bytes
            )
          );
        state = Y.encodeStateAsUpdate(initial);
        initial.destroy();
      } else {
        state = (await runOffice('seedOffice', session.format, bytes)).state;
      }
      try {
        session = await this.request<SourceSession>(
          session.fileId,
          'checkpoint',
          {
            actorIds: [actorId],
            baseSourceSHA256: sha,
            epoch: session.epoch,
            expectedCheckpoint: 0,
            initialize: true,
            netTokens: 0,
            pendingEffects: [],
            state: Buffer.from(state).toString('base64'),
          }
        );
      } catch (error) {
        if (!(error instanceof SourceRequestError) || error.status !== 409)
          throw error;
        session = await this.sessionForRoom(room, actorId, 'comment');
        if (!session.state) throw error;
      }
    }
    Y.applyUpdate(document, Buffer.from(session.state, 'base64'));
  }

  async effects(
    session: SourceSession,
    state: Uint8Array,
    fromState = session.indexedState
  ) {
    if (session.format === 'text')
      return textEffects(
        textState(Buffer.from(fromState, 'base64')),
        textState(state)
      );
    const bytes = await this.base(session.sourceURL, session.baseSourceSHA256);
    const checkpoint: OfficeCheckpoint = {
      baseSha256: session.baseSourceSHA256,
      format: session.format,
      schemaVersion: 1,
      state,
    };
    const effects = await runOffice(
      'compare',
      bytes,
      { ...checkpoint, state: Buffer.from(fromState, 'base64') },
      checkpoint
    );
    for (const effect of effects) {
      const cached = session.pendingEffects.find(
        (old) =>
          old.id === effect.id &&
          !!effect.imageSHA256 &&
          old.imageSHA256 === effect.imageSHA256 &&
          JSON.stringify(old.assetRef) === JSON.stringify(effect.assetRef)
      );
      if (cached?.caption) {
        effect.caption = cached.caption;
      }
    }
    return effects;
  }

  async store(room: string, snapshot: Y.Doc) {
    const { fileId, epoch } = sourceRoom(room);
    const contributors = documentContributors(snapshot);
    // A receipt for an unchanged document is still a durability receipt.
    if (!contributors.length) {
      const result = await this.pool.query<{ checkpoint: string }>(
        'SELECT checkpoint FROM source_documents WHERE file_id=$1 AND epoch=$2',
        [fileId, epoch]
      );
      if (!result.rowCount)
        throw new SourceRequestError(409, 'Source epoch changed');
      return { checkpoint: Number(result.rows[0].checkpoint), contributors };
    }
    const actors = [...new Set(contributors.map((c) => c.userId))];
    removeDocumentContributors(snapshot, contributors);
    // Merge each persisted replica before CAS. Redis delivery and database
    // flush order can differ; replacement of the durable state would lose edits.
    for (let attempt = 0; attempt < 4; attempt++) {
      const session = await this.sessionForRoom(room, actors[0], 'write');
      const merged = new Y.Doc();
      try {
        Y.applyUpdate(merged, Buffer.from(session.state, 'base64'));
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(snapshot));
        const state = Y.encodeStateAsUpdate(merged);
        if (state.byteLength > MAX_SOURCE_STATE_BYTES)
          throw new Error('Source checkpoint exceeds byte limit');
        const effects = await this.effects(session, state);
        try {
          const saved = await this.request<SourceSession>(
            fileId,
            'checkpoint',
            {
              actorIds: actors,
              epoch,
              expectedCheckpoint: session.checkpoint,
              netTokens: effectTokens(effects),
              pendingEffects: effects,
              state: Buffer.from(state).toString('base64'),
            }
          );
          return { checkpoint: saved.checkpoint, contributors };
        } catch (error) {
          if (
            !(error instanceof SourceRequestError) ||
            error.status !== 409 ||
            attempt === 3
          )
            throw error;
        }
      } finally {
        merged.destroy();
      }
    }
    throw new Error('Source checkpoint could not be committed');
  }

  async resolve(input: {
    fileId: string;
    workspaceId: string;
    userId: string;
    epoch: number;
    checkpoint: number;
    changeId: string;
  }) {
    const session = await this.session(input.fileId, input.userId);
    if (
      session.workspaceId !== input.workspaceId ||
      session.epoch !== input.epoch ||
      session.checkpoint !== input.checkpoint ||
      session.format === 'text'
    ) {
      throw new SourceRequestError(409, 'Source checkpoint changed');
    }
    const effect = session.pendingEffects.find((e) => e.id === input.changeId);
    if (!effect?.assetRef)
      throw new SourceRequestError(404, 'Source image unavailable');
    const bytes = await this.base(session.sourceURL, session.baseSourceSHA256);
    const asset = await runOffice(
      'resolveAsset',
      bytes,
      {
        baseSha256: session.baseSourceSHA256,
        format: session.format,
        schemaVersion: 1,
        state: Buffer.from(session.state, 'base64'),
      },
      effect.assetRef
    );
    return { ...asset, bytes: Buffer.from(asset.bytes).toString('base64') };
  }

  async exportCandidate(fileId: string, jobId: string) {
    const candidate = await this.request<RefreshCandidate>(
      fileId,
      `refresh-candidate?jobId=${encodeURIComponent(jobId)}`
    );
    try {
      const state = Buffer.from(candidate.state, 'base64');
      let bytes: Uint8Array, seed: Uint8Array;
      if (candidate.format === 'text') {
        bytes = new TextEncoder().encode(textState(state));
        seed = state;
      } else {
        const base = await this.base(
          candidate.baseSourceURL,
          candidate.baseSourceSHA256
        );
        bytes = await runOffice(
          'exportOffice',
          base,
          {
            baseSha256: candidate.baseSourceSHA256,
            format: candidate.format,
            schemaVersion: 1,
            state,
          },
          {
            now: '2000-01-01T00:00:00.000Z',
            seed: createHash('sha256').update(jobId).digest('hex'),
          }
        );
        seed = (await runOffice('seedOffice', candidate.format, bytes)).state;
      }
      if (bytes.byteLength > MAX_SOURCE_STATE_BYTES)
        throw new Error('Export exceeds the supported byte limit');
      const uploaded = await fetch(candidate.uploadURL, {
        body: Buffer.from(bytes),
        headers: candidate.uploadHeaders,
        method: 'PUT',
        signal: AbortSignal.timeout(120_000),
      });
      if (!uploaded.ok)
        throw new Error(`Source candidate upload failed (${uploaded.status})`);
      await this.request(fileId, 'refresh-candidate', {
        checkpoint: candidate.checkpoint,
        epoch: candidate.epoch,
        jobId,
        leaseToken: candidate.leaseToken,
        seed: Buffer.from(seed).toString('base64'),
        sizeBytes: bytes.byteLength,
        sourceETag: uploaded.headers.get('etag') ?? '',
        sourceSHA256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch (error) {
      await this.request(fileId, 'refresh-failure', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
        leaseToken: candidate.leaseToken,
      });
      throw error;
    }
  }

  async scheduleRefreshes() {
    const eligible = await this.pool.query<{
      file_id: string;
      user_id: string;
      checkpoint: string;
    }>(`
      SELECT d.file_id,w.user_id,d.checkpoint FROM source_documents d
      JOIN files f ON f.id=d.file_id JOIN workspaces w ON w.id=f.workspace_id
      WHERE d.checkpoint>d.indexed_checkpoint AND d.running_job_id IS NULL
        AND d.refresh_error IS NULL AND jsonb_array_length(d.pending_effects)>0
        AND ((d.format='text' AND (w.auto_reindex OR d.desired_manual) AND d.last_refresh_requested_at < now()-interval '15 seconds')
          OR(d.format<>'text' AND (d.desired_manual OR (w.auto_reparse AND f.ever_parsed_successfully AND d.net_tokens>=5000)) AND d.last_edited_at < now()-interval '60 seconds'))
      ORDER BY d.last_edited_at LIMIT 8`);
    for (const row of eligible.rows) {
      try {
        await this.request(row.file_id, 'refresh', {
          actorId: row.user_id,
          automatic: true,
        });
      } catch (error) {
        if (error instanceof SourceRequestError && error.status === 409)
          continue;
        await this.pool.query(
          'UPDATE source_documents SET refresh_error=$3 WHERE file_id=$1 AND checkpoint=$2 AND running_job_id IS NULL',
          [
            row.file_id,
            row.checkpoint,
            error instanceof Error ? error.message : String(error),
          ]
        );
      }
    }
    const jobs = await this.pool.query<{ id: string; file_id: string }>(
      `SELECT j.id,c.file_id FROM jobs j JOIN source_refresh_candidates c ON c.job_id=j.id WHERE j.type='source_refresh' AND (j.status='pending' OR (j.status='running' AND j.lease_expires_at<now())) ORDER BY j.created_at LIMIT 2`
    );
    for (const job of jobs.rows) {
      try {
        await this.exportCandidate(job.file_id, job.id);
      } catch (error) {
        if (!(error instanceof SourceRequestError) || error.status !== 409)
          console.warn('source refresh failed:', error);
      }
    }
  }
}
