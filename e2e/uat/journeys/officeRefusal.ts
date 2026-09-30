/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// The Office refusal journey (human/frontend/office-files.md, 2026-09-29): a
// publication held after its capture, a TOC-link edit the rebase refuses, and
// the automatic republication that captures it.
import assert from 'node:assert/strict';
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { sanitize } from './evidence';
import { api, fileRow, object, string } from './files';
import type { UatRun } from './runtime';

/** UAT's COLLABORATION_UAT_PUBLICATION_HOLD holds a file named with it. */
export const HOLD_MARKER = '[hold-publication]';
/** How the ingest worker records collaboration's 422 for a refused rebase. */
export const REFUSAL_PREFIX =
  'source publication gateway returned 422: {"message":"Office rebase:';

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
  await page.getByRole('button', { exact: true, name: 'Save' }).click();
  return { published: 'IntroZduction' };
}

/**
 * The held publication ended refused: its job failed with collaboration's
 * rebase refusal, the file is due again without refresh_error, and the
 * published file did not change. The refusal's Sentry event is expected.
 */
export async function refusedPublication(
  run: UatRun,
  fileId: string,
  jobId: string,
  before: Record<string, unknown>
) {
  const [job] = await run.poll(
    `refused publication ${jobId}`,
    () => run.query('SELECT status,error FROM jobs WHERE id=%s', [jobId]),
    // A held publication that timed out retries (pending) before it ends.
    (rows) => rows[0]?.status === 'failed' || rows[0]?.status === 'done',
    300_000
  );
  assert.equal(job.status, 'failed');
  assert(
    string(job.error).startsWith(REFUSAL_PREFIX),
    `unexpected publication failure: ${sanitize(job.error)}`
  );
  const attempts = await run.query(
    'SELECT status,error_category,error_code,trace_id FROM ingest_job_attempts WHERE job_id=%s',
    [jobId]
  );
  const refused = attempts.filter(
    (attempt) =>
      attempt.status === 'failed' &&
      attempt.error_code === 'office_rebase_refused'
  );
  assert.equal(refused.length, 1);
  assert.equal(refused[0].error_category, 'source_refresh');
  for (const attempt of attempts)
    await run.record('trace', string(attempt.trace_id), { fileId, jobId });
  await run.record('sentry-expected', string(refused[0].trace_id), {
    errorCode: 'office_rebase_refused',
    exceptionType: 'SourceRebaseRefusedError',
    fileId,
    jobId,
    valuePrefix: REFUSAL_PREFIX,
  });
  // Due again at the latest checkpoint (a fresh refresh may already run).
  const [source] = await run.query(
    'SELECT checkpoint,desired_checkpoint,refresh_error,running_job_id FROM source_documents WHERE file_id=%s',
    [fileId]
  );
  assert.equal(source.refresh_error, null);
  assert.equal(Number(source.desired_checkpoint), Number(source.checkpoint));
  assert.notEqual(source.running_job_id, jobId);
  const file = await fileRow(run, fileId);
  assert.equal(file.status, 'ready');
  assert.equal(file.indexed, true);
  assert.equal(file.revision, before.revision);
  assert.equal(file.source_sha256, before.source_sha256);
}

/**
 * The automatic republication after the refusal (the journey's own wait: the
 * refused job stays failed, so automaticPublication() does not apply). It
 * publishes `checkpoint` or later with no refresh error and no other failed
 * refresh job, from a second automatic refresh job.
 */
export async function republication(
  run: UatRun,
  fileId: string,
  refusedJobId: string,
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
          job.id === refusedJobId || job.status !== 'failed',
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
  // The refused publication and a fresh one, both scheduled automatically;
  // the fresh one captured the refused edit. The handoff retypes a refresh job
  // to parse or ingest, so match on the payload.
  const refreshes = await run.query(
    `SELECT payload->>'automatic' AS automatic,(payload->>'sourceCheckpoint')::bigint AS checkpoint
    FROM jobs WHERE payload->>'sourceRefresh'='true' AND payload->>'fileId'=%s ORDER BY created_at`,
    [fileId]
  );
  assert.equal(refreshes.length, 2);
  assert(refreshes.every((refresh) => refresh.automatic === 'true'));
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
