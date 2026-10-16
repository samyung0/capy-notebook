/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Partial files (parts design): a part that fails leaves the file published
// and searchable but `failed` with `indexed` true, its job done with a note
// naming the missing parts. UAT's CAPY_UAT_FAIL_PARTS fails a part of a file
// named with a marker, with no provider call (pipeline ingest/uat.py):
// `[uat-fail-summary]` the descriptor, `[uat-fail-pages]` every VLM page read
// (winning over `[uat-scripted-vlm]`, which INGEST_UAT_SCRIPTED_VLM reads as
// fixed text). Retry processing of a partial file is one click (no upload
// dialog) and Go re-runs only the missing parts: a parts-only ingest job for
// the summary, an unpaid parse that reads only the unread pages for pages.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { m } from '../../i18n';
import { scriptedSearch } from './chat';
import {
  api,
  fact,
  fileRow,
  object,
  pdf,
  processed,
  scriptedPageRead,
  settledSpend,
  string,
  upload,
  workspace,
} from './files';
import { sessionCalls } from './models';
import { test, type UatRun } from './runtime';

const NOTE_END = '; retry processing fills them in';

/** Waits until the file's processing ends, however it ends; records its jobs
 * and attempt traces (the Sentry gate checks them). */
async function finished(run: UatRun, fileId: string) {
  const row = await run.poll(
    `ingest outcome ${fileId}`,
    () => fileRow(run, fileId),
    (row) => row.status === 'ready' || row.status === 'failed',
    900_000
  );
  const jobs = await run.poll(
    `finished jobs ${fileId}`,
    () =>
      run.query(
        "SELECT id,type,status,error FROM jobs WHERE payload->>'fileId'=%s",
        [fileId]
      ),
    (rows) =>
      rows.length > 0 &&
      rows.every((job) => job.status === 'done' || job.status === 'failed')
  );
  for (const job of jobs) await run.record('job', string(job.id), { fileId });
  const attempts = await run.query(
    `SELECT a.trace_id,a.job_id FROM ingest_job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.payload->>'fileId'=%s`,
    [fileId]
  );
  for (const attempt of attempts)
    await run.record('trace', string(attempt.trace_id), {
      fileId,
      jobId: attempt.job_id,
    });
  const note = jobs.find((job) => job.type === 'ingest')?.error;
  return { jobs, note: typeof note === 'string' ? note : '', row };
}

/** A partial file's retry: never unindexed on the way, ending ready. */
async function retried(run: UatRun, fileId: string, hint: string) {
  const seen: unknown[] = [];
  const row = await run.poll(
    `retried ${fileId}`,
    () => fileRow(run, fileId),
    (row) => {
      seen.push([row.status, row.indexed]);
      assert.equal(
        row.indexed,
        true,
        `the retry dropped the index: ${JSON.stringify(seen)}`
      );
      return row.status === 'ready' || row.status === 'failed';
    },
    900_000
  );
  assert.equal(row.status, 'ready', `${hint}; states ${JSON.stringify(seen)}`);
  return seen;
}

/** The content the file's search alias serves. */
async function served(run: UatRun, fileId: string) {
  const rows = await run.query(
    `SELECT r.status,r.pipeline_identity,
    (SELECT count(*)::int FROM rag_chunks c WHERE c.content_id=r.id) AS chunks,
    (SELECT count(*)::int FROM rag_content_summaries s WHERE s.content_id=r.id) AS summaries
    FROM rag_contents r JOIN rag_file_contents f ON f.content_id=r.id AND f.workspace_id=r.workspace_id
    WHERE f.file_id=%s`,
    [fileId]
  );
  assert.equal(rows.length, 1, `${fileId} serves no content`);
  return rows[0];
}

/** The file's parse usage rows, oldest first. */
const parses = (run: UatRun, fileId: string) =>
  run.query(
    `SELECT reservation_id,credit_micros,metadata->'parseFee' AS parse_fee FROM usage_events
    WHERE kind='parse' AND metadata->>'fileId'=%s ORDER BY created_at`,
    [fileId]
  );

/** The jobs one provider session ran. */
const sessionJobs = (run: UatRun, reservationId: string) =>
  run.query(
    `SELECT type,status,payload->'partsOnly' AS parts_only,payload->'parseFee' AS parse_fee
    FROM jobs WHERE payload->>'reservationId'=%s`,
    [reservationId]
  );

test('partial files: a failed summary or unread page leaves the file searchable and failed; one-click Retry processing fills only the missing part', async ({
  run,
}) => {
  test.setTimeout(2_400_000);
  const workspaceId = await workspace(run, 'partial');
  const token = `UAT_${randomUUID().replaceAll('-', '')}`;
  const name = `report ${token}.pdf`;
  const fileId = await upload(
    run,
    workspaceId,
    `report [uat-fail-summary] ${token}.pdf`,
    pdf([[`Partial ingest report ${token}.`, fact]])
  );
  // Page 1 has a text layer; page 2 has none (blank), so it goes to the VLM,
  // whose read fails for this name. The retry's name keeps only the scripted
  // marker, so page 2 is then read as fixed text.
  const pagesToken = `UAT_${randomUUID().replaceAll('-', '')}`;
  const pagesName = `pages [uat-scripted-vlm] ${pagesToken}.pdf`;
  const pagesRead = `UAT scripted page 2: pages ${pagesToken}`;
  const pagesId = await upload(
    run,
    workspaceId,
    `pages [uat-fail-pages] [uat-scripted-vlm] ${pagesToken}.pdf`,
    pdf([[fact, 'The field survey continues.'], []])
  );

  // The summary failed before any call; the rest published.
  const partial = await finished(run, fileId);
  assert.notEqual(
    partial.row.status,
    'ready',
    'the [uat-fail-summary] file indexed with its summary: UAT ingest needs CAPY_UAT_FAIL_PARTS=true'
  );
  assert.deepEqual(
    [partial.row.status, partial.row.indexed],
    ['failed', true],
    partial.note
  );
  assert(partial.jobs.every((job) => job.status === 'done'));
  assert(
    partial.note.startsWith('summary pending (') &&
      partial.note.includes('[uat-fail-summary]') &&
      partial.note.endsWith(NOTE_END),
    partial.note
  );
  const content = await served(run, fileId);
  assert.equal(content.status, 'ready');
  assert(content.pipeline_identity, 'a complete parse has an identity');
  assert(Number(content.chunks) > 0);
  assert.equal(content.summaries, 0);
  // Parsed and embedded once, with no summary call.
  const [first, ...others] = await settledSpend(run, fileId);
  assert.equal(others.length, 0);
  const uploadCalls = await sessionCalls(run, string(first.id));
  assert(uploadCalls.some((call) => call.kind === 'embedding'));
  assert(!uploadCalls.some((call) => call.purpose === 'file_summary'));
  assert.deepEqual(
    (await parses(run, fileId)).map((row) => row.reservation_id),
    [first.id]
  );

  // Unread pages: failed and indexed, the page named, no read made or charged,
  // and the content (no identity) is never a donor.
  const pages = await finished(run, pagesId);
  assert.deepEqual(
    [pages.row.status, pages.row.indexed],
    ['failed', true],
    pages.note
  );
  assert(
    pages.note.endsWith(`1 pages could not be read (p. 2)${NOTE_END}`),
    pages.note
  );
  assert.equal((await served(run, pagesId)).pipeline_identity, null);
  const [pagesFirst, ...pagesOthers] = await settledSpend(run, pagesId);
  assert.equal(pagesOthers.length, 0);
  assert.deepEqual(
    (await sessionCalls(run, string(pagesFirst.id))).filter(
      (call) => call.purpose === 'vlm_page'
    ),
    [],
    'a [uat-fail-pages] page was read'
  );

  // Search still serves the summary-partial file.
  const cited = await scriptedSearch(run, workspaceId, token);
  assert.equal(cited[0]?.fileId, fileId, 'search does not serve the file');

  // Without the fail markers, each is retried in one click from Settings →
  // Indexing → Failed files: no upload dialog, and the file stays indexed.
  for (const [id, renamed] of [
    [fileId, name],
    [pagesId, pagesName],
  ]) {
    const file = object(
      await api(run.owner, `/api/files/${id}`, 'PATCH', { name: renamed })
    );
    assert.equal(file.name, renamed);
  }
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  const retry = async (id: string, label: string) => {
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/files/${id}/retry-processing` &&
        r.request().method() === 'POST'
    );
    await settings
      .getByRole('listitem')
      .filter({ hasText: label })
      .getByRole('button', { exact: true, name: m.error_action_retry() })
      .click();
    assert.equal((await response).status(), 202);
  };

  // The summary: one parts-only ingest job making one summary call; no
  // parse, no parse charge, no embedding.
  await retry(fileId, name);
  const summaryStates = await retried(run, fileId, 'the summary retry failed');
  await processed(run, fileId, [token]);
  const sessions = await settledSpend(run, fileId);
  assert.equal(sessions.length, 2);
  const summaryRetry = string(sessions[1].id);
  assert.deepEqual(
    (await sessionJobs(run, summaryRetry)).map((job) => [
      job.type,
      job.status,
      job.parts_only,
    ]),
    [['ingest', 'done', true]]
  );
  const retryCalls = await sessionCalls(run, summaryRetry);
  assert.deepEqual(
    retryCalls.map((call) => [call.kind, call.purpose, call.status]),
    [['llm', 'file_summary', 'applied']]
  );
  assert.deepEqual(
    (await parses(run, fileId)).map((row) => row.reservation_id),
    [first.id]
  );

  // The pages: an unpaid parse (the file parsed before) whose ingest reads
  // only the unread page, charged as one page read at the pinned rate.
  await retry(pagesId, pagesName);
  const pagesStates = await retried(
    run,
    pagesId,
    'page 2 is still unread: UAT ingest needs INGEST_UAT_SCRIPTED_VLM=true'
  );
  await processed(run, pagesId, [pagesRead]);
  const pagesSessions = await settledSpend(run, pagesId);
  assert.equal(pagesSessions.length, 2);
  const pagesRetry = string(pagesSessions[1].id);
  const pagesJobs = await sessionJobs(run, pagesRetry);
  assert(pagesJobs.some((job) => job.type === 'parse'));
  assert(
    pagesJobs.every((job) => job.status === 'done' && job.parse_fee === false),
    JSON.stringify(pagesJobs)
  );
  const pageRead = await scriptedPageRead(run, pagesRetry);
  // The upload's parse paid for its text page; any parse row of the retry
  // is free.
  const [uploadParse, ...retryParses] = await parses(run, pagesId);
  assert.equal(uploadParse.reservation_id, pagesFirst.id);
  assert(Number(uploadParse.credit_micros) > 0, 'the upload parse is free');
  assert.deepEqual(
    retryParses.map((row) => [
      row.reservation_id,
      row.parse_fee,
      Number(row.credit_micros),
    ]),
    retryParses.map(() => [pagesRetry, false, 0])
  );
  await run.attach(`${workspaceId}-partial`, {
    notes: [partial.note, pages.note],
    pageRead,
    pagesJobs,
    pagesParses: [uploadParse, ...retryParses],
    pagesStates,
    retryCalls,
    summaryStates,
    uploadCalls,
  });
});
