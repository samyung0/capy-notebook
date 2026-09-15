/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import type { Actor, UatRun } from './runtime';

export const fact = 'Wetland plants absorb carbon and protect the shoreline.';
export const basic = new URL('../../fixtures/files/basic/', import.meta.url);
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
export const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

export async function api(
  actor: Actor,
  path: string,
  method = 'GET',
  body?: unknown,
  status = 200
) {
  const response = await actor.request(path, method, body);
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(response.body)}`
  );
  return response.body;
}

export async function workspace(run: UatRun, label: string) {
  const result = object(
    await api(
      run.owner,
      '/api/workspaces',
      'POST',
      {
        name: `UAT ${label} ${randomUUID().slice(0, 8)}`,
      },
      201
    )
  );
  const id = string(result.id);
  await run.record('workspace', id, { ownerId: run.owner.id });
  const rows = await run.query('SELECT user_id FROM workspaces WHERE id=%s', [
    id,
  ]);
  assert.equal(rows[0]?.user_id, run.owner.id);
  return id;
}

export async function invite(
  run: UatRun,
  workspaceId: string,
  actor: Actor,
  role: 'editor' | 'viewer'
) {
  await api(
    run.owner,
    `/api/workspaces/${workspaceId}/invites`,
    'POST',
    { identifier: actor.id, role },
    202
  );
  const rows = await run.poll(
    'workspace invitation',
    () =>
      run.query(
        'SELECT id FROM workspace_invites WHERE workspace_id=%s AND invited_user_id=%s',
        [workspaceId, actor.id]
      ),
    (rows) => rows.length === 1
  );
  const id = string(rows[0].id);
  await run.record('invitation', id, { actorId: actor.id, workspaceId });
  await api(actor, `/api/workspace-invites/${id}/accept`, 'POST');
  const members = await run.query(
    'SELECT role FROM workspace_members WHERE workspace_id=%s AND user_id=%s',
    [workspaceId, actor.id]
  );
  assert.equal(members[0]?.role, role);
}

export async function fixture(name: string, marker: string) {
  const bytes = await readFile(new URL(name, basic));
  if (/\.(docx|xlsx|pptx)$/.test(name)) {
    const parts = unzipSync(bytes);
    let replacements = 0;
    for (const [key, value] of Object.entries(parts)) {
      if (!key.endsWith('.xml')) continue;
      const xml = strFromU8(value);
      if (!xml.includes('UAT_RUN_MARKER')) continue;
      parts[key] = Buffer.from(xml.replaceAll('UAT_RUN_MARKER', marker));
      replacements++;
    }
    assert(replacements > 0, `${name} has no run marker`);
    return Buffer.from(zipSync(parts));
  }
  // PDF uses identical valid committed bytes. Its journey proves ingestion or
  // reuse, not a fresh parse. Text inputs change a real source fact each run.
  return name.endsWith('.pdf')
    ? bytes
    : Buffer.from(bytes.toString().replaceAll('UAT_RUN_MARKER', marker));
}

export async function fileRow(run: UatRun, fileId: string) {
  const rows = await run.query(
    `SELECT id,workspace_id,user_id,name,kind,status,indexed,
    blob_path,source_sha256,size_bytes,revision,trashed_at,trash_episode_id FROM files WHERE id=%s`,
    [fileId]
  );
  assert.equal(rows.length, 1, `missing file ${fileId}`);
  return rows[0];
}

export async function openFile(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  fileId: string
) {
  await actor.page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?file=${encodeURIComponent(fileId)}`
  );
}

export async function upload(
  run: UatRun,
  workspaceId: string,
  name: string,
  bytes: Buffer
) {
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Add file' }).click();
  // The picker stays disabled until the workspace upload policy is ready.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /^Upload from your computer/ }).click(),
  ]);
  await chooser.setFiles({
    buffer: bytes,
    mimeType: 'application/octet-stream',
    name,
  });
  const path = `/api/workspaces/${workspaceId}/sources/uploads`;
  const reservation = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST'
    )
    .then(async (reserved) => {
      assert.equal(reserved.status(), 201, await reserved.text());
      const uploadId = string(object(await reserved.json()).uploadId);
      await run.record('upload', uploadId, { workspaceId });
      const sessions = await run.query(
        'SELECT object_path,final_path FROM upload_sessions WHERE id=%s',
        [uploadId]
      );
      for (const key of [sessions[0]?.object_path, sessions[0]?.final_path])
        if (typeof key === 'string')
          await run.record('blob', key, { uploadId, workspaceId });
      return uploadId;
    });
  const completion = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(`${path}/`) &&
      new URL(response.url()).pathname.endsWith('/complete') &&
      response.request().method() === 'POST'
  );
  // Consume both response promises even when submission fails.
  const clicked = page
    .getByRole('button', { exact: true, name: 'Upload' })
    .click();
  const [uploadId, completed] = await Promise.all([
    reservation,
    completion,
    clicked,
  ]);
  assert.equal(completed.status(), 201, await completed.text());
  const body = object(await completed.json());
  const id = string(body.id);
  await run.record('file', id, { workspaceId });
  const row = await fileRow(run, id);
  const key = string(row.blob_path);
  await run.record('blob', key, {
    fileId: id,
    sourceSha256: sha256(bytes),
  });
  const stored = await run.blob(key);
  assert.equal(stored.sha256, sha256(bytes));
  assert.equal(stored.size, bytes.length);
  assert.equal(row.user_id, run.owner.id);
  const sessions = await run.query(
    'SELECT status,declared_size,file_id FROM upload_sessions WHERE id=%s',
    [uploadId]
  );
  assert.equal(sessions[0]?.status, 'completed');
  assert.equal(sessions[0]?.file_id, id);
  const reservedRows = await run.query(
    "SELECT count(*)::int AS pending FROM upload_sessions WHERE workspace_id=%s AND status='pending'",
    [workspaceId]
  );
  assert.equal(reservedRows[0]?.pending, 0);
  const storage = await run.query(
    'SELECT reserved_bytes,used_bytes FROM user_storage WHERE user_id=%s',
    [run.owner.id]
  );
  assert.equal(Number(storage[0]?.reserved_bytes), 0);
  assert(Number(storage[0]?.used_bytes) >= bytes.length);
  return id;
}

export async function indexText(run: UatRun, fileId: string) {
  const rows = await run.query(
    `SELECT c.indexed_text AS text FROM rag_chunks c JOIN rag_file_contents f ON f.content_id=c.content_id AND f.workspace_id=c.workspace_id
    WHERE f.file_id=%s ORDER BY c.chunk_idx`,
    [fileId]
  );
  return rows.map((row) => string(row.text)).join('\n');
}

export async function processed(
  run: UatRun,
  fileId: string,
  expected: string[]
) {
  const row = await run.poll(
    `ingest ${fileId}`,
    () => fileRow(run, fileId),
    (row) => {
      assert.notEqual(row.status, 'failed', `file ${fileId} failed processing`);
      return row.indexed === true && row.status === 'ready';
    },
    900_000
  );
  const text = await run.poll(
    'indexed fixture facts',
    () => indexText(run, fileId),
    (text) => expected.every((item) => text.includes(item)),
    900_000
  );
  const jobs = await run.query(
    "SELECT id,status,type FROM jobs WHERE payload->>'fileId'=%s",
    [fileId]
  );
  for (const job of jobs) await run.record('job', string(job.id), { fileId });
  assert(jobs.length > 0);
  await run.poll(
    'completed file jobs',
    () =>
      run.query("SELECT status FROM jobs WHERE payload->>'fileId'=%s", [
        fileId,
      ]),
    (rows) => rows.every((row) => row.status === 'done'),
    900_000
  );
  const attempts = await run.query(
    `SELECT a.status,a.release_sha,a.environment,a.source_format,a.trace_id,a.job_id FROM ingest_job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.payload->>'fileId'=%s`,
    [fileId]
  );
  assert(attempts.some((attempt) => attempt.status === 'succeeded'));
  for (const attempt of attempts) {
    await run.record('trace', string(attempt.trace_id), {
      fileId,
      jobId: attempt.job_id,
    });
    assert.equal(attempt.release_sha, run.env.expectedRevision);
    assert.equal(attempt.environment, 'uat');
  }
  const contents = await run.query(
    `SELECT r.status, (SELECT count(*)::int FROM rag_chunk_vectors_2560 v JOIN rag_chunks c ON c.id=v.chunk_id WHERE c.content_id=r.id) AS vectors,
    (SELECT count(*)::int FROM rag_content_summaries s WHERE s.content_id=r.id) AS summaries
    FROM rag_contents r JOIN rag_file_contents f ON f.content_id=r.id AND f.workspace_id=r.workspace_id WHERE f.file_id=%s`,
    [fileId]
  );
  assert.equal(contents[0]?.status, 'ready');
  assert(Number(contents[0]?.vectors) > 0);
  assert(Number(contents[0]?.summaries) > 0);
  await settledSpend(run, fileId);
  await run.attach(`${fileId}-index`, { attempts, text });
  return row;
}

export async function settledSpend(
  run: UatRun,
  fileId: string,
  noCalls = false
) {
  const sessions = await run.query(
    `SELECT DISTINCT p.id,p.status,p.settled_at,
    (SELECT count(*)::int FROM provider_calls c WHERE c.reservation_id=p.id AND c.status='open') AS open_calls,
    (SELECT count(*)::int FROM provider_calls c WHERE c.reservation_id=p.id) AS calls,
    (SELECT count(*)::int FROM usage_events u WHERE u.reservation_id=p.id) AS receipts
    FROM provider_sessions p JOIN jobs j ON j.payload->>'reservationId'=p.id
    WHERE j.payload->>'fileId'=%s`,
    [fileId]
  );
  assert(sessions.length > 0, 'ingest must have a recorded spend reservation');
  for (const session of sessions) {
    await run.record('provider-session', string(session.id), { fileId });
    assert(session.status === 'settled' || session.status === 'released');
    assert(session.settled_at);
    assert.equal(session.open_calls, 0);
    if (noCalls) {
      assert.equal(session.status, 'released');
      assert.equal(session.calls, 0);
      assert.equal(session.receipts, 0);
    }
  }
  await run.attach(`${fileId}-spend`, sessions);
}

export async function officeBundle(run: UatRun, fileId: string) {
  const row = await fileRow(run, fileId);
  // Successful ingest clears the file's diagnostic local-bundle reference.
  // The completed continuation retains the receipt for this exact source.
  const receipts = await run.query(
    `SELECT payload->'parseArtifact' AS artifact FROM jobs
    WHERE payload->>'fileId'=%s AND type='ingest' AND status='done'
      AND payload->'localSource'->>'sha256'=%s
    ORDER BY updated_at DESC LIMIT 1`,
    [fileId, row.source_sha256]
  );
  assert.equal(
    receipts.length,
    1,
    'current Office source has no parse receipt'
  );
  const receipt = object(receipts[0].artifact);
  const fingerprint = string(receipt.fingerprint);
  const version = string(receipt.version);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert(version.length > 0);
  const format = string(row.name).split('.').at(-1);
  const attempts = await run.query(
    `SELECT a.source_format,a.release_sha,a.environment,a.parse_pages,a.donor_reused,
    j.payload->'processingPlan' AS plan FROM ingest_job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.payload->>'fileId'=%s AND a.status='succeeded' ORDER BY a.finished_at`,
    [fileId]
  );
  assert(
    attempts.some(
      (attempt) => Number(attempt.parse_pages) > 0 && !attempt.donor_reused
    ),
    'unique Office source must have a successful real parse'
  );
  for (const attempt of attempts) {
    assert.equal(attempt.source_format, format);
    assert.equal(attempt.release_sha, run.env.expectedRevision);
    assert.equal(attempt.environment, 'uat');
    const plan = object(attempt.plan);
    assert.equal(plan.version, 2);
    assert.equal(plan.format, format);
    assert.equal(plan.office, true);
  }
  const caches = await run.query(
    'SELECT object_path,kind FROM artifact_cache WHERE source_sha256=%s',
    [row.source_sha256]
  );
  assert(caches.every((cache) => cache.kind !== 'office_preview'));
  const bundle = caches.find((cache) => cache.kind === 'parse_bundle');
  // The required parser handoff is local. B2 bundle caching is optional.
  if (!bundle) {
    await run.attach(`${fileId}-bundle`, {
      attempts,
      receipt,
      status: 'optional cache unavailable',
    });
    return;
  }
  const key = string(bundle.object_path);
  await run.record('blob', key, {
    cache: true,
    fileId,
    sourceSha256: row.source_sha256,
  });
  const stored = await run.blob(key);
  assert.equal(stored.sha256, receipt.sha256);
  assert.equal(stored.size, receipt.size);
  const parts = unzipSync(Buffer.from(stored.bodyBase64, 'base64'));
  assert(
    Object.keys(parts).every((name) => !name.toLowerCase().endsWith('.pdf'))
  );
  const manifest = object(JSON.parse(strFromU8(parts['manifest.json'])));
  assert.equal(manifest.schema, 'capy-parser-bundle-v4');
  assert.equal(manifest.source_fingerprint, fingerprint);
  assert.equal(manifest.parser_version, version);
  const blocks: unknown = JSON.parse(strFromU8(parts['content_list.json']));
  assert(Array.isArray(blocks));
  const refinement = object(JSON.parse(strFromU8(parts['refinement.json'])));
  const evidence = object(refinement.page_evidence);
  assert(Array.isArray(evidence.page_texts) && evidence.page_texts.length > 0);
  assert(Array.isArray(evidence.visible_headings));
  assert(
    evidence.visible_headings.every(
      (i) => Number.isInteger(i) && Number(i) >= 0 && Number(i) < blocks.length
    )
  );
  await run.attach(`${fileId}-bundle`, {
    entries: Object.keys(parts),
    manifest,
    pageCount: evidence.page_texts.length,
    receipt,
  });
}

export async function trashRestorePurge(run: UatRun, fileId: string) {
  const before = await fileRow(run, fileId);
  const path = `/api/files/${fileId}`;
  await api(run.owner, path, 'DELETE', undefined, 204);
  const trashed = await fileRow(run, fileId);
  assert(trashed.trashed_at);
  assert.equal((await run.owner.request(`${path}/links`)).status, 404);
  assert.equal(
    (await run.blob(string(before.blob_path))).sha256,
    before.source_sha256
  );
  await api(run.owner, `/api/trash/source_file/${fileId}/restore`, 'POST', {
    episodeId: trashed.trash_episode_id,
    requestId: randomUUID(),
  });
  assert.equal((await fileRow(run, fileId)).trashed_at, null);
  await api(run.owner, `${path}/links`);
  await api(run.owner, path, 'DELETE', undefined, 204);
  const episode = string((await fileRow(run, fileId)).trash_episode_id);
  await api(
    run.owner,
    `/api/trash/source_file/${fileId}?episodeId=${encodeURIComponent(episode)}&requestId=${randomUUID()}`,
    'DELETE'
  );
  assert.equal(
    (await run.query('SELECT id FROM files WHERE id=%s', [fileId])).length,
    0
  );
  assert.equal(
    (
      await run.query('SELECT file_id FROM source_documents WHERE file_id=%s', [
        fileId,
      ])
    ).length,
    0
  );
  assert.equal(
    (
      await run.query('SELECT file_id FROM pdf_annotations WHERE file_id=%s', [
        fileId,
      ])
    ).length,
    0
  );
  const refs = await run.query(
    'SELECT ref_count FROM blobs WHERE object_path=%s',
    [before.blob_path]
  );
  assert.equal(refs.length, 0);
  // Deletion may already have drained the outbox. Cleanup independently
  // verifies retained cache objects and eventual provider deletion.
  await run.attach(`${fileId}-purge`, {
    pending: await run.query(
      'SELECT object_path,not_before FROM pending_blob_deletions WHERE object_path=%s',
      [before.blob_path]
    ),
    source: before.blob_path,
  });
}
