/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// The Office refusal journey (human/frontend/office-files.md, 2026-09-29 and
// 2026-10-02): a publication held after its capture publishes deferred, the
// TOC-link edit saved during the hold makes its rebuild refuse, and the
// automatic republication captures the edit and rebuilds.
import assert from 'node:assert/strict';
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { sanitize } from './evidence';
import { api, fileRow, object, string } from './files';
import { saveOffice } from './office';
import type { UatRun } from './runtime';

/** UAT's COLLABORATION_UAT_PUBLICATION_HOLD holds a file named with it. */
export const HOLD_MARKER = '[hold-publication]';
/** The engine's rebase refusal (RebaseError), as the rebuild records it. */
export const REFUSAL_PREFIX = 'Office rebase:';

/** Sets or clears the hold marker through the rename API (editor rights). */
export async function setHold(
  run: UatRun,
  fileId: string,
  name: string,
  held: boolean
) {
  const renamed = held ? name.replace(/(\.docx)$/, ` ${HOLD_MARKER}$1`) : name;
  const file = object(
    await api(run.owner, `/api/files/${fileId}`, 'PATCH', { name: renamed })
  );
  assert.equal(file.name, renamed);
}

/**
 * The automatic publication once it is held: its candidate captured the
 * saved checkpoint, and the worker parsed and indexed it and asked to
 * publish, which collaboration holds while the file's name has the marker.
 */
export async function heldPublication(run: UatRun, fileId: string) {
  const [row] = await run.poll(
    `held publication ${fileId}`,
    async () => {
      const rows = await run.query(
        `SELECT c.job_id,c.checkpoint,c.source_blob_path,c.source_sha256,j.status,
        j.payload->>'sourcePublicationReady' AS ready,d.refresh_error
        FROM source_documents d LEFT JOIN source_refresh_candidates c ON c.file_id=d.file_id
        LEFT JOIN jobs j ON j.id=c.job_id WHERE d.file_id=%s`,
        [fileId]
      );
      assert.equal(rows.length, 1, `missing source row for ${fileId}`);
      const [candidate] = rows;
      assert.equal(
        candidate.refresh_error,
        null,
        `source refresh ${fileId} failed: ${sanitize(candidate.refresh_error)}`
      );
      if (typeof candidate.job_id === 'string')
        await run.record('job', candidate.job_id, { fileId });
      if (typeof candidate.source_blob_path === 'string')
        await run.record('blob', candidate.source_blob_path, {
          fileId,
          sourceSha256: candidate.source_sha256,
        });
      return rows;
    },
    (rows) => rows[0].ready === 'true' && rows[0].status === 'running',
    900_000
  );
  return { checkpoint: Number(row.checkpoint), jobId: string(row.job_id) };
}

/**
 * The edit the publication rebase refuses (e2e/fixtures/files/toc/README.md):
 * one character typed after "Intro" in the first TOC entry's link. The editor
 * mirrors text one element per glyph, each with its document position; the
 * entry's glyphs are anchors to its heading's bookmark (`#_Toc1`), and a click
 * on one follows it there. So the caret is placed on the first glyph of the
 * paragraph's plain "Contents" label and arrows to five glyphs into the link.
 * Typing at the entry's start, Backspace, Delete or Enter would land instead.
 * Returns the text the published document.xml contains once a fresh
 * publication captures the edit.
 */
export async function editTocLink(page: Page, frame: FrameLocator) {
  const toc = frame.locator('[role="paragraph"]:has(a[href="#_Toc1"])');
  const label = toc.locator('span[data-doc-start]:not(:empty)').first();
  const link = toc.locator('a[href="#_Toc1"]').first();
  const input = frame.getByRole('textbox', { name: 'Document input' });
  const head = async () =>
    Number(await input.getAttribute('data-selection-head'));
  // The text cursor confirms hit testing is ready before the caret is placed.
  await expect(async () => {
    await label.hover({ force: true, timeout: 5000 });
    await expect(frame.locator('.canvas-pages')).toHaveCSS('cursor', 'text', {
      timeout: 1000,
    });
    await label.click({ force: true, timeout: 5000 });
    await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
      timeout: 1000,
    });
    const caret = await head();
    expect(caret).toBeGreaterThanOrEqual(
      Number(await label.getAttribute('data-doc-start'))
    );
    expect(caret).toBeLessThanOrEqual(
      Number(await label.getAttribute('data-doc-end'))
    );
  }).toPass({ timeout: 20_000 });
  const target =
    Number(await link.getAttribute('data-doc-start')) + 'Intro'.length;
  for (let caret = await head(); caret !== target; caret = await head()) {
    assert(caret < target, `the caret passed "Intro" (${caret} > ${target})`);
    await input.press('ArrowRight');
    await expect(input).not.toHaveAttribute(
      'data-selection-head',
      String(caret)
    );
  }
  await input.pressSequentially('Z');
  await saveOffice(page);
  return { published: 'IntroZduction' };
}

/**
 * The held publication completed: deferred, it published the capture (the
 * paste) while editing stayed on the old base, so the job is done and the
 * file's bytes changed. Returns the file it published.
 */
export async function heldPublicationDone(
  run: UatRun,
  fileId: string,
  jobId: string,
  before: Record<string, unknown>
) {
  const [job] = await run.poll(
    `held publication ${jobId}`,
    () => run.query('SELECT status,error FROM jobs WHERE id=%s', [jobId]),
    // A held publication that timed out retries (pending) before it ends.
    (rows) => rows[0]?.status === 'failed' || rows[0]?.status === 'done',
    300_000
  );
  assert.equal(
    job.status,
    'done',
    `held publication failed: ${sanitize(job.error)}`
  );
  const attempts = await run.query(
    'SELECT trace_id FROM ingest_job_attempts WHERE job_id=%s',
    [jobId]
  );
  for (const attempt of attempts)
    await run.record('trace', string(attempt.trace_id), { fileId, jobId });
  const file = await fileRow(run, fileId);
  assert.equal(file.status, 'ready');
  assert.equal(file.indexed, true);
  assert(Number(file.revision) > Number(before.revision));
  assert.notEqual(file.source_sha256, before.source_sha256);
  await run.record('blob', string(file.blob_path), {
    fileId,
    sourceSha256: file.source_sha256,
  });
  return file;
}

/**
 * The held publication's rebuild refused the edit saved after its capture:
 * the source row holds the refusal until the next publication, and the
 * automatic republication's job records the refusal it replaces. Fails at once
 * if the rebuild landed instead (the engine no longer refuses the edit).
 */
export async function refusedRebuild(
  run: UatRun,
  fileId: string,
  epoch: number
) {
  const [row] = await run.poll(
    `refused rebuild ${fileId}`,
    async () => {
      const rows = await run.query(
        `SELECT d.epoch,d.rebuild_pending,COALESCE(d.rebuild_refusal,(SELECT j.payload->>'rebuildRefusal' FROM jobs j
        WHERE j.payload->>'fileId'=d.file_id AND j.payload->>'rebuildRefusal' IS NOT NULL LIMIT 1)) AS refusal
        FROM source_documents d WHERE d.file_id=%s`,
        [fileId]
      );
      assert.equal(rows.length, 1, `missing source row for ${fileId}`);
      assert(
        rows[0].refusal !== null || Number(rows[0].epoch) === epoch,
        `the rebuild of ${fileId} landed without a refusal`
      );
      return rows;
    },
    (rows) => rows[0].refusal !== null,
    300_000
  );
  assert(
    string(row.refusal).startsWith(REFUSAL_PREFIX),
    `unexpected rebuild failure: ${sanitize(row.refusal)}`
  );
  return string(row.refusal);
}

/**
 * The automatic republication after the refused rebuild. It publishes
 * `checkpoint` or later with no refresh error and no failed refresh job, from
 * a second automatic refresh job that records the refusal.
 */
export async function republication(
  run: UatRun,
  fileId: string,
  checkpoint: number,
  before: Record<string, unknown>
) {
  await run.poll(
    `automatic republication ${fileId}`,
    async () => {
      const jobs = await run.query(
        "SELECT id,status,error FROM jobs WHERE payload->>'fileId'=%s AND payload->>'sourceRefresh'='true'",
        [fileId]
      );
      for (const job of jobs) {
        await run.record('job', string(job.id), { fileId });
        assert(
          job.status !== 'failed',
          `source refresh ${fileId} failed in ${job.id}: ${sanitize(job.error)}`
        );
      }
      const candidates = await run.query(
        'SELECT source_blob_path,source_sha256 FROM source_refresh_candidates WHERE file_id=%s',
        [fileId]
      );
      for (const candidate of candidates)
        if (typeof candidate.source_blob_path === 'string')
          await run.record('blob', candidate.source_blob_path, {
            fileId,
            sourceSha256: candidate.source_sha256,
          });
      const [source] = await run.query(
        'SELECT indexed_checkpoint,refresh_error FROM source_documents WHERE file_id=%s',
        [fileId]
      );
      assert.equal(
        source.refresh_error,
        null,
        `source refresh ${fileId} failed: ${sanitize(source.refresh_error)}`
      );
      return source;
    },
    (source) => Number(source.indexed_checkpoint) >= checkpoint,
    900_000
  );
  // The held publication and a fresh one, both scheduled automatically; the
  // fresh one records the refused rebuild and captured the edit. The handoff
  // retypes a refresh job to parse or ingest and a parse hands its payload to
  // an ingest job, so one publication is every job sharing its lease token.
  const refreshes = await run.query(
    `SELECT bool_and(payload->>'automatic'='true')::text AS automatic,
      max((payload->>'sourceCheckpoint')::bigint) AS checkpoint,
      max(payload->>'rebuildRefusal') AS refusal
    FROM jobs WHERE payload->>'sourceRefresh'='true' AND payload->>'fileId'=%s
    GROUP BY payload->>'sourceLeaseToken' ORDER BY min(created_at)`,
    [fileId]
  );
  assert.equal(refreshes.length, 2);
  assert(refreshes.every((refresh) => refresh.automatic === 'true'));
  assert.equal(refreshes[0].refusal, null);
  assert(string(refreshes[1].refusal).startsWith(REFUSAL_PREFIX));
  assert(Number(refreshes[1].checkpoint) >= checkpoint);
  const published = await fileRow(run, fileId);
  assert(Number(published.revision) > Number(before.revision));
  assert.notEqual(published.source_sha256, before.source_sha256);
  await run.record('blob', string(published.blob_path), {
    fileId,
    sourceSha256: published.source_sha256,
  });
  const pending = await run.query(
    'SELECT file_id FROM source_refresh_candidates WHERE file_id=%s',
    [fileId]
  );
  assert.equal(pending.length, 0);
  return published;
}

/**
 * The republication's rebuild completed: nothing was saved after its capture,
 * so editing moved onto the published file (a new epoch after `epoch`) with
 * the state seed(published).
 */
export async function rebuiltAfterRepublication(
  run: UatRun,
  fileId: string,
  epoch: number
) {
  const [row] = await run.poll(
    `rebuilt ${fileId}`,
    () =>
      run.query(
        `SELECT epoch,rebuild_pending,rebuild_refusal,base_blob_path,
        encode(state,'base64') AS state FROM source_documents WHERE file_id=%s`,
        [fileId]
      ),
    (rows) => rows[0]?.rebuild_pending === false,
    300_000
  );
  assert(Number(row.epoch) > epoch);
  assert.equal(row.rebuild_refusal, null);
  assert.equal(row.state, null);
  const file = await fileRow(run, fileId);
  assert.equal(row.base_blob_path, file.blob_path);
  return row;
}
