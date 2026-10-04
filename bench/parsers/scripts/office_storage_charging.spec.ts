// What the owner is charged for store-only sources through edit, publication,
// rebuild and the blob reaper (bench/parsers/reports/2026-10-05-office-storage-charging.md).
// Run through office_storage_charging.config.ts, which starts the local
// stack. Each Office fixture is edited in the browser editor (the DOCX also
// gets a ~1 MB image), published export-only with the editor open, edited
// again, closed until the rebuild, published again and reaped; the Markdown
// file gets three edit and publish rounds, its parse and index stood in for
// by this run (no ingest worker runs here).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import * as Y from 'yjs';
import { e2eHeaders, users } from '../../../e2e/fixtures/seed';
import { saved, saveOffice, type OfficeFormat } from '../../../e2e/uat/journeys/office';
import { editRich } from '../../../e2e/uat/journeys/richContent';

const require = createRequire(new URL('../../../collaboration/package.json', import.meta.url));
const { Client } = require('pg') as typeof import('pg');

const root = path.resolve(import.meta.dirname, '../../..');
const api = process.env.E2E_API_URL!;
const s3 = `http://127.0.0.1:${process.env.OFFICE_CHARGING_S3_PORT}`;
const owner = users.owner;
const db = new Client({
  connectionString: `postgres://capy:capy@127.0.0.1:${process.env.E2E_DB_PORT}/capy`,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method: string, route: string, body?: BodyInit | object, status?: number) {
  const json = body !== undefined && !(body instanceof FormData);
  const response = await fetch(`${api}${route}`, {
    body: json ? JSON.stringify(body) : (body as BodyInit | undefined),
    headers: { ...e2eHeaders(owner), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    method,
  });
  const text = await response.text();
  assert(status === undefined ? response.ok : response.status === status, `${method} ${route}: ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function row<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  return (await db.query(sql, args)).rows[0] as T;
}

async function poll<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 300_000, every = 500) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > ms) throw new Error(`${label}: timed out on ${JSON.stringify(value)}`);
    await sleep(every);
  }
}

/** Objects in the fake S3 bucket with their sizes. */
async function bucket() {
  const xml = await (await fetch(`${s3}/capy?prefix=`)).text();
  return Object.fromEntries(
    [...xml.matchAll(/<Key>([^<]*)<\/Key><Size>(\d+)<\/Size>/g)].map(([, key, size]) => [key, Number(size)])
  );
}

// Reconciliation's recount of a user's used bytes (storage.go, storageRecountSQL).
const RECOUNT = `COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id=$1),0)
  +COALESCE((SELECT sum(storage_bytes) FROM source_documents WHERE user_id=$1),0)
  +COALESCE((SELECT sum(size_bytes) FROM editor_assets WHERE user_id=$1 AND status='ready'),0)
  +COALESCE((SELECT sum(size_bytes) FROM materials WHERE owner_user_id=$1),0)
  +COALESCE((SELECT sum(inverse_bytes) FROM agent_edit_inverses WHERE owner_user_id=$1),0)`;

let baseline = 0;
const records: Record<string, unknown>[] = [];

/** One step's numbers for a file, with the owner's charge since the start. */
async function measure(file: string, fileId: string, step: string, extra: Record<string, unknown> = {}) {
  const r = await row(
    `SELECT f.size_bytes::int,f.blob_path,d.base_blob_path,d.storage_bytes::int,d.seed_bytes::int,d.epoch::int,
      d.checkpoint::int,d.indexed_checkpoint::int,d.rebuild_pending,
      COALESCE(octet_length(d.state),0)::int AS state_bytes,
      COALESCE(octet_length(d.published_state),0)::int AS published_state_bytes,
      octet_length(d.pending_effects::text)::int AS pending_effects_bytes,
      (SELECT c.size_bytes::int FROM source_refresh_candidates c WHERE c.file_id=f.id) AS candidate_bytes,
      COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$2),0)
        +COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$2),0) AS booked,
      ${RECOUNT.replaceAll('$1', '$2')} AS recount
     FROM files f LEFT JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1`,
    [fileId, owner]
  );
  const objects = await bucket();
  const pending = (await db.query('SELECT object_path,not_before FROM pending_blob_deletions ORDER BY object_path')).rows;
  const record = {
    file,
    step,
    ...r,
    booked: Number(r.booked),
    recount: Number(r.recount),
    charged: Number(r.booked) - baseline,
    blob_bytes: objects[r.blob_path as string] ?? null,
    base_blob_bytes: objects[r.base_blob_path as string] ?? null,
    base_is_blob: r.base_blob_path === r.blob_path,
    pending_blob_deletions: pending.map((p) => ({ path: p.object_path, bytes: objects[p.object_path] ?? null })),
    bucket_bytes: Object.values(objects).reduce((sum, size) => sum + size, 0),
    bucket_objects: Object.keys(objects).length,
    ...extra,
  };
  records.push(record);
  console.log(JSON.stringify(record));
  assert.equal(record.booked, record.recount, `${file} ${step}: the ledger and reconciliation disagree`);
  return record;
}

/** A deterministic, poorly compressible PNG of about 1 MB. */
function noisePng(width = 600, height = 580) {
  let x = 0x9e3779b9;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = i % (width * 3 + 1) === 0 ? 0 : x & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function upload(workspace: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  form.append('name', name);
  form.append('parseMode', 'none');
  const file = await call('POST', `/api/workspaces/${workspace}/sources`, form);
  return String(file.id);
}

const source = (fileId: string) =>
  row<{ epoch: number; checkpoint: number; indexed_checkpoint: number; rebuild_pending: boolean; running_job_id: string | null }>(
    'SELECT epoch::int,checkpoint::int,indexed_checkpoint::int,rebuild_pending,running_job_id FROM source_documents WHERE file_id=$1',
    [fileId]
  );

/**
 * Makes the saved edits due (the 7-day stale rule, past the 60 s idle) and
 * waits for the scheduler's export-only publication, noting the candidate's
 * size while it exists.
 */
async function publishOffice(fileId: string) {
  const before = await source(fileId);
  await db.query(`UPDATE source_documents SET last_edited_at=now()-interval '8 days' WHERE file_id=$1`, [fileId]);
  let candidate: number | null = null;
  await poll(
    `publication of ${fileId}`,
    async () => {
      const c = await row<{ size_bytes: number | null }>(
        'SELECT size_bytes::int FROM source_refresh_candidates WHERE file_id=$1',
        [fileId]
      );
      if (c?.size_bytes) candidate = c.size_bytes;
      return source(fileId);
    },
    (s) => s.indexed_checkpoint >= before.checkpoint && s.running_job_id === null,
    300_000,
    100
  );
  return { candidate_bytes_seen: candidate };
}

async function rebuilt(fileId: string, epoch: number) {
  await poll(
    `rebuild of ${fileId}`,
    () => source(fileId),
    (s) => !s.rebuild_pending && s.epoch > epoch
  );
}

async function openEditor(page: Page, workspace: string, fileId: string): Promise<FrameLocator> {
  await page.goto(`/workspaces/${workspace}?file=${encodeURIComponent(fileId)}&mode=edit`);
  await expect(
    page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { exact: true, name: 'Edit' })
  ).toBeVisible({ timeout: 180_000 });
  await saveOffice(page);
  return page.frameLocator('iframe[src*="office-runtime"]');
}

async function insertImage(page: Page, png: Buffer) {
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { exact: true, name: 'Insert' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: /^Image/ }).click(),
  ]);
  await chooser.setFiles({ buffer: png, mimeType: 'image/png', name: 'noise.png' });
}

/** The reaper deletes what the publications released, once due. */
async function reap() {
  await db.query('UPDATE pending_blob_deletions SET not_before=now()');
  await poll(
    'blob reaper',
    async () => Number((await row<{ n: string }>('SELECT count(*) AS n FROM pending_blob_deletions')).n),
    (n) => n === 0,
    240_000
  );
}

async function textRoom(fileId: string) {
  const doc = new Y.Doc();
  const token = (await call('POST', `/api/files/${fileId}/collaboration-token`)) as { token: string; url: string; room: string };
  const origin = process.env.E2E_BASE_URL!;
  class OriginWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { headers: { Origin: origin }, protocols } as unknown as string[]);
    }
  }
  const provider = new HocuspocusProvider({
    document: doc,
    name: token.room,
    token: token.token,
    url: token.url,
    WebSocketPolyfill: OriginWebSocket,
  } as HocuspocusProviderConfiguration);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('text room did not sync')), 60_000);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { doc, provider };
}

/**
 * The ingest worker's part of a text refresh, without a parser or an index
 * provider: the finalized candidate's parse job runs as one attempt, a ready
 * content row stands in for the index, and the publication goes through the
 * gateway as the worker sends it.
 */
async function publishText(workspace: string, fileId: string) {
  const before = await source(fileId);
  await call('POST', `/api/files/${fileId}/process-changes`, undefined, 202);
  const job = await poll(
    `text export of ${fileId}`,
    () =>
      row<{ id: string; payload: Record<string, unknown> } | undefined>(
        `SELECT j.id,j.payload FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id
         WHERE c.file_id=$1 AND c.source_sha256 IS NOT NULL AND j.status='pending' AND j.type<>'source_refresh'`,
        [fileId]
      ),
    (value) => value !== undefined
  );
  assert(job);
  const candidate = await row<{ size_bytes: number }>('SELECT size_bytes::int FROM source_refresh_candidates WHERE file_id=$1', [fileId]);
  const content = `rc_${randomUUID().replaceAll('-', '')}`;
  const hash = createHash('sha256').update(content).digest('hex');
  await db.query(`UPDATE jobs SET status='running',attempts=1,locked_at=now(),lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, [job.id]);
  const attempt = await row<{ id: string }>(
    `INSERT INTO ingest_job_attempts(job_id,operation_id,attempt,job_type,environment,host_id,worker_instance_id,trace_id,queued_at,claimed_at)
     SELECT id,id,1,type,'local','local','office-charging','office-charging',now(),now() FROM jobs WHERE id=$1 RETURNING id`,
    [job.id]
  );
  await db.query(`INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,$3,'ready')`, [content, workspace, hash]);
  await db.query('UPDATE source_refresh_candidates SET content_id=$2,content_hash=$3 WHERE file_id=$1', [fileId, content, hash]);
  await db.query(`UPDATE jobs SET payload=payload||'{"sourcePublicationReady":true}'::jsonb WHERE id=$1`, [job.id]);
  const response = await fetch(`${api}/api/internal/source-refresh/publish`, {
    body: JSON.stringify({
      attemptId: Number(attempt.id),
      checkpoint: job.payload.sourceCheckpoint,
      contentHash: hash,
      contentId: content,
      epoch: job.payload.sourceEpoch,
      fileId,
      jobId: job.id,
      leaseToken: job.payload.sourceLeaseToken,
      sourceETag: job.payload.sourceETag,
    }),
    headers: { 'Content-Type': 'application/json', 'X-Pipeline-Secret': process.env.OFFICE_CHARGING_PIPELINE_SECRET! },
    method: 'POST',
  });
  assert.equal(response.status, 200, await response.text());
  await db.query(`UPDATE jobs SET status='done',locked_at=NULL,lease_expires_at=NULL WHERE id=$1`, [job.id]);
  await poll(`text publication of ${fileId}`, () => source(fileId), (s) => s.indexed_checkpoint >= before.checkpoint);
  return { candidate_bytes: candidate.size_bytes };
}

test('office and text storage charges', async ({ browser }) => {
  await db.connect();
  try {
    const context = await browser.newContext();
    const appOrigin = new URL(process.env.E2E_BASE_URL!).origin;
    await context.route(`${appOrigin}/api/**`, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), ...e2eHeaders(owner) } });
    });
    // The browser fetches sources from presigned URLs on the fake S3's
    // in-network name; serve them from its published port.
    const cors = { 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,PUT', 'Access-Control-Allow-Origin': '*' };
    await context.route('https://s3.stress.backblazeb2.com:9443/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors, status: 204 });
      const url = new URL(route.request().url());
      const response = await fetch(`${s3}${url.pathname}`, { method: route.request().method() });
      await route.fulfill({
        body: Buffer.from(await response.arrayBuffer()),
        headers: { ...cors, 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' },
        status: response.status,
      });
    });
    const page = await context.newPage();
    const workspace = String((await call('POST', '/api/workspaces', { name: `Storage charging ${randomUUID().slice(0, 8)}` })).id);
    baseline = Number((await row<{ booked: string }>(
      `SELECT COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1),0)+COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1),0) AS booked`,
      [owner]
    )).booked);
    const png = noisePng();

    for (const [name, format] of [
      ['exchange-plan.docx', 'docx'],
      ['lecture.pptx', 'pptx'],
      ['course-guide.xlsx', 'xlsx'],
    ] as const) {
      const bytes = await readFile(path.join(root, 'e2e/fixtures/files/rich-content', name));
      const fileId = await upload(workspace, name, bytes);
      await measure(name, fileId, 'uploaded');
      const frame = await openEditor(page, workspace, fileId);
      await editRich(page, frame, format as OfficeFormat, false);
      await saved(page);
      await measure(name, fileId, 'edited');
      if (format === 'docx') {
        await insertImage(page, png);
        await saveOffice(page);
        await saved(page);
        await poll('image saved', () => row<{ n: number }>('SELECT octet_length(state)::int AS n FROM source_documents WHERE file_id=$1', [fileId]), (r) => r.n > png.length);
        await measure(name, fileId, 'image', { image_bytes: png.length });
      }
      // Published while the editor stays open: editing stays on the old base.
      const published = await publishOffice(fileId);
      const pending = await measure(name, fileId, 'published', published);
      assert.equal(pending.rebuild_pending, true);
      await editRich(page, frame, format as OfficeFormat, true);
      await saved(page);
      await measure(name, fileId, 'edited-while-pending');
      // Closed: the room empties and the rebuild moves editing onto the file.
      await page.goto(`/workspaces/${workspace}`);
      await rebuilt(fileId, Number(pending.epoch));
      const swapped = await measure(name, fileId, 'rebuilt');
      const republished = await publishOffice(fileId);
      await measure(name, fileId, 'republished', republished);
      await rebuilt(fileId, Number(swapped.epoch));
      await measure(name, fileId, 'republished-rebuilt');
      await reap();
      await measure(name, fileId, 'reaped');
    }

    // Text: three rounds of an edit and a publication.
    const text = Array.from({ length: 40 }, (_, i) => `- Note ${i + 1}: wetlands store carbon and slow floods.`).join('\n');
    const fileId = await upload(workspace, 'notes.md', new TextEncoder().encode(`# Field notes\n\n${text}\n`));
    await measure('notes.md', fileId, 'uploaded');
    for (const round of [1, 2, 3]) {
      // The room's session creates the source row on the first open.
      const room = await textRoom(fileId);
      const { checkpoint } = await source(fileId);
      const body = room.doc.getText('source');
      // 1,000 bytes typed in 25 pieces, as edits arrive.
      for (let i = 0; i < 25; i++) {
        body.insert(body.length, `\nRound ${round}, line ${String(i).padStart(2, '0')}: peat holds water.`.padEnd(40, '.'));
        await sleep(40);
      }
      await poll('text saved', () => source(fileId), (s) => s.checkpoint > checkpoint && !room.provider.hasUnsyncedChanges);
      await sleep(3000);
      room.provider.destroy();
      room.doc.destroy();
      await measure('notes.md', fileId, `round-${round}-edited`);
      const published = await publishText(workspace, fileId);
      await measure('notes.md', fileId, `round-${round}-published`, published);
    }
    await reap();
    await measure('notes.md', fileId, 'reaped');
  } finally {
    const out = path.resolve(root, process.env.OFFICE_CHARGING_OUT!);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(
      out,
      `${JSON.stringify(
        {
          capy_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
          server_image: process.env.OFFICE_CHARGING_SERVER_IMAGE,
          collaboration_image: process.env.OFFICE_CHARGING_COLLABORATION_IMAGE,
          records,
        },
        null,
        2
      )}\n`
    );
    await db.end();
  }
});
