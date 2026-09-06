import { randomUUID } from 'node:crypto';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  effectTokens,
  type SourceDocumentStore,
  SourceRequestError,
  type SourceSession,
} from './sourceDocuments.js';

export const SOURCE_HANDOFF_CHANNEL = 'capy:collaboration:source-handoff';
interface Prepare {
  checkpoint: number;
  epoch: number;
  fileId: string;
  id: string;
  room: string;
  type: 'prepare';
}
interface LocalHandoff {
  checkpoint: number;
  epoch: number;
  id: string;
  ready: Set<string>;
  reject(error: Error): void;
  resolve(): void;
  sockets: Set<string>;
  watchdog: NodeJS.Timeout;
}
export interface SourcePublish extends Record<string, unknown> {
  attemptId: number;
  checkpoint: number;
  epoch: number;
  fileId: string;
  jobId: string;
  leaseToken: string;
}

export class SourceHandoff {
  private readonly local = new Map<string, LocalHandoff>();
  private readonly instanceId: string;
  private readonly redis: Redis;
  private readonly pool: Pool;
  private readonly host: Hocuspocus;
  private readonly sources: SourceDocumentStore;
  private readonly activeInstances: () => Promise<Set<string>>;
  private readonly persist: (document: Document) => Promise<void>;
  constructor(
    instanceId: string,
    redis: Redis,
    pool: Pool,
    host: Hocuspocus,
    sources: SourceDocumentStore,
    activeInstances: () => Promise<Set<string>>,
    persist: (document: Document) => Promise<void>
  ) {
    this.instanceId = instanceId;
    this.redis = redis;
    this.pool = pool;
    this.host = host;
    this.sources = sources;
    this.activeInstances = activeInstances;
    this.persist = persist;
  }

  ready(
    room: string,
    socketId: string,
    event: {
      id?: unknown;
      epoch?: unknown;
      checkpoint?: unknown;
      clean?: unknown;
    }
  ) {
    const waiting = this.local.get(room);
    if (
      !waiting ||
      waiting.id !== event.id ||
      waiting.epoch !== event.epoch ||
      waiting.checkpoint !== event.checkpoint ||
      event.clean !== true ||
      !waiting.sockets.has(socketId)
    )
      return false;
    waiting.ready.add(socketId);
    if (waiting.ready.size === waiting.sockets.size) waiting.resolve();
    return true;
  }

  private reset(room: string) {
    const waiting = this.local.get(room);
    if (waiting) clearTimeout(waiting.watchdog);
    const doc = this.host.documents.get(room);
    for (const connection of doc?.getConnections() ?? []) {
      connection.readOnly =
        connection.context?.access === 'comment' ||
        connection.context?.access === 'read';
    }
    this.local.delete(room);
  }

  private async recover(event: Prepare) {
    if (this.local.get(event.room)?.id !== event.id) return;
    try {
      const current = await this.current(event.fileId);
      await this.handle(
        JSON.stringify({
          ...event,
          newEpoch: current.epoch,
          type: current.epoch === event.epoch ? 'cancel' : 'complete',
        })
      );
    } catch {
      // Reauthentication checks the current epoch before any buffered update
      // can be sent. Keep the client's local draft when the API is unavailable.
      this.host.closeConnections(event.room);
      this.reset(event.room);
    }
  }

  async handle(raw: string) {
    const event = JSON.parse(raw) as
      | Prepare
      | {
          type: 'cancel' | 'complete';
          id: string;
          room: string;
          fileId: string;
          epoch: number;
          newEpoch?: number;
        };
    if (!event.id || !event.room || !event.fileId) return;
    const document = this.host.documents.get(event.room);
    if (event.type === 'complete') {
      document?.broadcastStateless(
        JSON.stringify({ ...event, type: 'source-epoch-changed' })
      );
      this.host.closeConnections(event.room);
      this.reset(event.room);
      if (document) await this.host.unloadDocument(document);
      return;
    }
    if (event.type === 'cancel') {
      const waiting = this.local.get(event.room);
      if (waiting?.id === event.id) {
        waiting.reject(new Error('Source handoff cancelled'));
        this.reset(event.room);
        document?.broadcastStateless(
          JSON.stringify({ ...event, type: 'source-handoff-cancel' })
        );
      }
      return;
    }
    if (event.type !== 'prepare') return;
    if (this.local.get(event.room)?.id === event.id) return;
    if (this.local.has(event.room)) this.reset(event.room);
    let ok = true;
    try {
      const connections =
        document?.getConnections().filter((c) => !c.readOnly) ?? [];
      if (document) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const waiting: LocalHandoff = {
              checkpoint: event.checkpoint,
              epoch: event.epoch,
              id: event.id,
              ready: new Set(),
              reject,
              resolve,
              sockets: new Set(connections.map((c) => c.socketId)),
              watchdog: setTimeout(() => {
                void this.recover(event);
              }, 125_000),
            };
            this.local.set(event.room, waiting);
            waiting.watchdog.unref();
            if (!connections.length) {
              resolve();
              return;
            }
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'Editors did not finish saving before source handoff'
                  )
                ),
              10_000
            );
            for (const connection of connections) {
              connection.onClose(() => {
                if (
                  this.local.get(event.room) === waiting &&
                  !waiting.ready.has(connection.socketId)
                )
                  reject(
                    new Error('Editor disconnected before source handoff')
                  );
              });
            }
            document.broadcastStateless(
              JSON.stringify({ ...event, type: 'source-handoff-prepare' })
            );
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (document) await this.persist(document);
    } catch {
      ok = false;
    }
    await this.redis.hset(
      `capy:source-handoff:${event.id}`,
      this.instanceId,
      ok ? 'ready' : 'failed'
    );
    await this.redis.expire(`capy:source-handoff:${event.id}`, 120);
  }

  private async current(fileId: string): Promise<SourceSession> {
    const result = await this.pool.query<{ user_id: string }>(
      'SELECT w.user_id FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1',
      [fileId]
    );
    if (!result.rows[0])
      throw new SourceRequestError(404, 'Source no longer exists');
    return this.sources.session(fileId, result.rows[0].user_id);
  }

  async publish(input: SourcePublish) {
    const session = await this.current(input.fileId);
    const receipt = await this.pool.query<{ published: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND payload->>'fileId'=$2
       AND payload->>'sourceEpoch'=$3 AND payload->>'sourceCheckpoint'=$4
       AND payload->>'sourceLeaseToken'=$5 AND payload->>'sourcePublishedCheckpoint'=$4
       AND payload->>'sourcePublishedAttemptId'=$6) AS published`,
      [
        input.jobId,
        input.fileId,
        String(input.epoch),
        String(input.checkpoint),
        input.leaseToken,
        String(input.attemptId),
      ]
    );
    if (receipt.rows[0]?.published)
      return this.sources.request(input.fileId, 'publish', {
        ...input,
        expectedLatestCheckpoint: session.checkpoint,
        netTokens: 0,
        pendingEffects: [],
      });
    if (session.epoch !== input.epoch)
      throw new SourceRequestError(409, 'Source epoch changed');
    if (session.format === 'text') {
      const candidate = await this.pool.query<{ state: Buffer }>(
        'SELECT state FROM source_refresh_candidates WHERE file_id=$1 AND job_id=$2 AND lease_token=$3 AND checkpoint=$4',
        [input.fileId, input.jobId, input.leaseToken, input.checkpoint]
      );
      if (!candidate.rows[0])
        throw new SourceRequestError(409, 'Source candidate changed');
      // Text retains its Y.Text lineage. Later edits remain a residual against
      // the just-indexed checkpoint, even while users keep typing.
      for (let attempt = 0; attempt < 4; attempt++) {
        const latest = attempt ? await this.current(input.fileId) : session;
        const effects = await this.sources.effects(
          latest,
          Buffer.from(latest.state, 'base64'),
          candidate.rows[0].state.toString('base64')
        );
        try {
          return await this.sources.request(input.fileId, 'publish', {
            ...input,
            expectedLatestCheckpoint: latest.checkpoint,
            indexedState: candidate.rows[0].state.toString('base64'),
            netTokens: effectTokens(effects),
            pendingEffects: effects,
          });
        } catch (error) {
          if (
            !(error instanceof SourceRequestError) ||
            error.status !== 409 ||
            attempt === 3
          )
            throw error;
        }
      }
    }
    if (session.checkpoint !== input.checkpoint)
      throw new SourceRequestError(409, 'Source changed during processing');
    const id = randomUUID();
    const room = session.room;
    const lock = `capy:collaboration:evicting:${room}`;
    if ((await this.redis.set(lock, id, 'PX', 120_000, 'NX')) !== 'OK')
      throw new SourceRequestError(409, 'Source handoff already running');
    let completed = false;
    try {
      const instances = await this.activeInstances();
      await this.redis.publish(
        SOURCE_HANDOFF_CHANNEL,
        JSON.stringify({
          checkpoint: input.checkpoint,
          epoch: input.epoch,
          fileId: input.fileId,
          id,
          room,
          type: 'prepare',
        } satisfies Prepare)
      );
      const deadline = Date.now() + 15_000;
      while (true) {
        const acknowledgments = await this.redis.hgetall(
          `capy:source-handoff:${id}`
        );
        if (Object.values(acknowledgments).includes('failed'))
          throw new SourceRequestError(
            409,
            'An editor has uncommitted changes'
          );
        if (
          [...instances].every(
            (instance) => acknowledgments[instance] === 'ready'
          )
        )
          break;
        if (Date.now() >= deadline)
          throw new SourceRequestError(409, 'Source handoff timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if ((await this.redis.get(lock)) !== id)
        throw new SourceRequestError(409, 'Source handoff lease expired');
      const result = await this.sources.request(input.fileId, 'publish', {
        ...input,
        expectedLatestCheckpoint: input.checkpoint,
        netTokens: 0,
        pendingEffects: [],
      });
      completed = true;
      await this.redis.publish(
        SOURCE_HANDOFF_CHANNEL,
        JSON.stringify({
          epoch: input.epoch,
          fileId: input.fileId,
          id,
          newEpoch: input.epoch + 1,
          room,
          type: 'complete',
        })
      );
      return result;
    } finally {
      if (!completed) {
        // A timed-out HTTP request can have committed. Read the authoritative
        // epoch before allowing a client to resume writing its old document.
        const current = await this.current(input.fileId).catch(() => null);
        await this.redis.publish(
          SOURCE_HANDOFF_CHANNEL,
          JSON.stringify({
            epoch: input.epoch,
            fileId: input.fileId,
            id,
            newEpoch: current?.epoch,
            room,
            type:
              current && current.epoch !== input.epoch ? 'complete' : 'cancel',
          })
        );
      }
      await this.redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
        1,
        lock,
        id
      );
      await this.redis.del(`capy:source-handoff:${id}`);
    }
  }
}
