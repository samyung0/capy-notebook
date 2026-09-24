/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The cell assertion helper executes only inside these tests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { read as readWorkbook } from 'xlsx';
import {
  api,
  fact,
  fileRow,
  fixture,
  indexText,
  invite,
  object,
  officeBundle,
  openFile,
  processed,
  settledSpend,
  sha256,
  string,
  trashRestorePurge,
  upload,
  workspace,
} from './files';
import {
  assertPreserved,
  editOffice,
  openEditor,
  refresh,
  replaceSlideText,
  savedExport,
  savedFacts,
  savedState,
} from './office';
import { test } from './runtime';

for (const [format, name] of [
  ['docx', 'lesson.docx'],
  ['xlsx', 'grades.xlsx'],
  ['pptx', 'lesson.pptx'],
] as const) {
  test(`${format}: browser upload, collaboration, durable export, publication and purge`, async ({
    run,
  }) => {
    test.setTimeout(2_400_000);
    const workspaceId = await workspace(run, format);
    const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
    const bytes = await fixture(name, marker);
    const fileId = await upload(run, workspaceId, name, bytes);
    await processed(run, fileId, [marker]);
    await officeBundle(run, fileId);
    const editor = await run.createActor(`${format}-editor`);
    await invite(run, workspaceId, editor, 'editor');
    const outsider = await run.createActor(`${format}-outsider`);
    assert.equal(
      (
        await outsider.request(
          `/api/files/${fileId}/collaboration-token`,
          'POST'
        )
      ).status,
      404
    );
    const ownerFrame = await openEditor(run, run.owner, workspaceId, fileId);
    const editorFrame = await openEditor(run, editor, workspaceId, fileId);
    const original = await fileRow(run, fileId);
    await editOffice(run.owner, ownerFrame, format, false);
    const ownerFact = format === 'xlsx' ? '43' : 'CEDAR-42';
    await savedFacts(run, fileId, [ownerFact]);
    await editOffice(editor, editorFrame, format, true);
    const editorFact = format === 'xlsx' ? '19' : 'survey starts in July';
    const merged = await savedFacts(run, fileId, [
      ownerFact,
      editorFact,
      marker,
    ]);
    assertPreserved(format, merged.bytes);
    if (format === 'xlsx') assertCells(merged.bytes);
    // Saving Office changes does not publish a replacement source/index.
    assert.equal(
      (await fileRow(run, fileId)).source_sha256,
      original.source_sha256
    );
    await run.owner.page.goto(`${run.env.appUrl}/workspaces`);
    await editor.page.goto(`${run.env.appUrl}/workspaces`);
    // This account has never loaded the Office document and has no local
    // replica. Its edits must start from the persisted shared checkpoint.
    await invite(run, workspaceId, outsider, 'editor');
    const reopened = await openEditor(run, outsider, workspaceId, fileId);
    const beforeReopenSave = await savedState(run, fileId);
    if (format === 'docx') {
      const input = reopened.getByRole('textbox', { name: 'Document input' });
      await input.focus();
      await input.press('ControlOrMeta+End');
      await input.press('Enter');
      await input.pressSequentially(
        'Fresh client confirmed the saved field survey.'
      );
    } else if (format === 'xlsx') {
      await reopened.getByRole('tab', { exact: true, name: 'Notes' }).click();
      const app = reopened.getByTestId('xlsx-scroll');
      await app.focus();
      await app.press('ControlOrMeta+Home');
      const input = reopened.getByTestId('xlsx-formula-input');
      await input.fill('Fresh client confirmed the saved field survey.');
      await input.press('Enter');
    } else {
      // A new client types in the same simple paragraph, proving restoration
      // through its own editor replica rather than only a database read.
      await replaceSlideText(
        reopened,
        0,
        'Owner sentence: The launch code is CEDAR-42. Fresh client confirmed the saved field survey.'
      );
    }
    await outsider.page
      .getByRole('button', { exact: true, name: 'Save' })
      .click();
    const fresh = await savedFacts(run, fileId, [
      ownerFact,
      editorFact,
      'Fresh client confirmed',
      marker,
    ]);
    assert(Number(fresh.row.checkpoint) > Number(beforeReopenSave.checkpoint));
    assertPreserved(format, fresh.bytes);
    const published = await refresh(run, fileId);
    await processed(
      run,
      fileId,
      format === 'xlsx'
        ? [marker, 'Fresh client confirmed']
        : [ownerFact, editorFact, 'Fresh client confirmed']
    );
    await officeBundle(run, fileId);
    const source = await run.blob(string(published.blob_path));
    assert.equal(source.sha256, published.source_sha256);
    assertPreserved(format, Buffer.from(source.bodyBase64, 'base64'));
    if (format === 'xlsx')
      assertCells(Buffer.from(source.bodyBase64, 'base64'));
    else assert(!(await indexText(run, fileId)).includes('LARCH-17'));
    await trashRestorePurge(run, fileId);
  });
}

function assertCells(bytes: Uint8Array) {
  const workbook = readWorkbook(bytes, { type: 'buffer' });
  assert.equal(workbook.Sheets.Grades.B2.v, 43);
  assert.equal(workbook.Sheets.Grades.B3.v, 19);
  assert.equal(workbook.Sheets.Grades.C2.f, 'B2*2');
}

test('text: browser edit automatically publishes durable UTF-8 source', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const workspaceId = await workspace(run, 'text');
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  const fileId = await upload(
    run,
    workspaceId,
    'notes.txt',
    await fixture('notes.txt', marker)
  );
  await processed(run, fileId, [marker]);
  await openFile(run, run.owner, workspaceId, fileId);
  await run.owner.page
    .getByRole('button', { exact: true, name: 'Material mode' })
    .click();
  const edited = `${fact}\nThe launch code is CEDAR-42.\n${marker}\n`;
  await run.owner.page
    .getByRole('textbox', { name: 'Edit source text' })
    .fill(edited);
  await run.owner.page
    .getByRole('button', { exact: true, name: 'Save' })
    .click();
  const saved = await savedFacts(run, fileId, ['CEDAR-42', marker]);
  assert.equal(saved.text, edited);
  await run.poll(
    'automatic text indexing',
    () => indexText(run, fileId),
    (text) => text.includes('CEDAR-42') && !text.includes('LARCH-17'),
    900_000
  );
  await processed(run, fileId, ['CEDAR-42', marker]);
  const row = await fileRow(run, fileId);
  await run.record('blob', string(row.blob_path), {
    fileId,
    sourceSha256: row.source_sha256,
  });
  const published = await run.blob(string(row.blob_path));
  assert.equal(Buffer.from(published.bodyBase64, 'base64').toString(), edited);
  await openFile(run, run.owner, workspaceId, fileId);
  assert.equal((await savedExport(run, fileId)).text, edited);
  await trashRestorePurge(run, fileId);
});

test('digital PDF: reader annotations are private and source bytes stay unchanged', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const workspaceId = await workspace(run, 'pdf');
  const bytes = await fixture('digital.pdf', 'unused');
  const fileId = await upload(run, workspaceId, 'digital.pdf', bytes);
  const before = await processed(run, fileId, ['LARCH-17']);
  const index = await indexText(run, fileId);
  const viewer = await run.createActor('pdf-viewer');
  await invite(run, workspaceId, viewer, 'viewer');
  await openFile(run, viewer, workspaceId, fileId);
  // PDF sources have no collaboration room, including for their owner.
  assert.equal(
    (await viewer.request(`/api/files/${fileId}/collaboration-token`, 'POST'))
      .status,
    404
  );
  const annotations = `/api/files/${fileId}/annotations`;
  const mark = {
    color: '#facc15',
    kind: 'rectangle',
    page: 1,
    rects: [{ height: 60, width: 300, x: 80, y: 80 }],
    sourceIdentity: `revision:${before.revision}`,
  };
  const ownerMark = object(
    await api(run.owner, annotations, 'POST', mark, 201)
  );
  const viewerMark = object(
    await api(viewer, annotations, 'POST', { ...mark, color: '#60a5fa' }, 201)
  );
  await run.record('annotation', string(ownerMark.id), {
    actorId: run.owner.id,
    fileId,
  });
  await run.record('annotation', string(viewerMark.id), {
    actorId: viewer.id,
    fileId,
  });
  const ownerMarks = await api(run.owner, annotations);
  const viewerMarks = await api(viewer, annotations);
  assert(Array.isArray(ownerMarks) && Array.isArray(viewerMarks));
  assert.deepEqual(
    ownerMarks.map((value) => object(value).id),
    [ownerMark.id]
  );
  assert.deepEqual(
    viewerMarks.map((value) => object(value).id),
    [viewerMark.id]
  );
  assert.equal(
    (await viewer.request(`${annotations}/${ownerMark.id}`, 'DELETE')).status,
    404
  );
  const stored = await run.query(
    'SELECT author_id,source_identity,kind,rects FROM pdf_annotations WHERE file_id=%s ORDER BY author_id',
    [fileId]
  );
  assert.equal(stored.length, 2);
  assert(stored.every((row) => row.source_identity === mark.sourceIdentity));
  assert.equal((await fileRow(run, fileId)).revision, before.revision);
  assert.equal(
    (await run.blob(string(before.blob_path))).sha256,
    sha256(bytes)
  );
  assert.equal(await indexText(run, fileId), index);
  await trashRestorePurge(run, fileId);
});

test('oversized delimited structure: terminal ingest failure never publishes an index', async ({
  run,
}) => {
  test.setTimeout(600_000);
  const workspaceId = await workspace(run, 'invalid-csv');
  const fileId = await upload(
    run,
    workspaceId,
    'delimiter-limit.csv',
    await fixture(
      'delimiter-limit.csv',
      `UAT_${randomUUID().replaceAll('-', '')}`
    )
  );
  await run.poll(
    'terminal CSV failure',
    () => fileRow(run, fileId),
    (row) => row.status === 'failed',
    300_000
  );
  assert.equal((await fileRow(run, fileId)).indexed, false);
  await run.poll(
    'terminal CSV job finalized',
    () =>
      run.query("SELECT status FROM jobs WHERE payload->>'fileId'=%s", [
        fileId,
      ]),
    (rows) => rows.length > 0 && rows.every((row) => row.status === 'failed')
  );
  assert.equal(
    (
      await run.query(
        'SELECT file_id FROM rag_file_contents WHERE file_id=%s',
        [fileId]
      )
    ).length,
    0
  );
  const attempts = await run.query(
    `SELECT a.error_code,j.error AS job_error,a.status,a.release_sha,a.environment,a.trace_id,a.job_id FROM ingest_job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.payload->>'fileId'=%s`,
    [fileId]
  );
  assert(
    attempts.some(
      (attempt) =>
        attempt.status === 'failed' &&
        attempt.error_code === 'terminalerror' &&
        attempt.job_error === 'delimited table exceeds the cell limit'
    )
  );
  for (const attempt of attempts) {
    await run.record('trace', string(attempt.trace_id), {
      fileId,
      jobId: attempt.job_id,
    });
    if (
      attempt.status === 'failed' &&
      attempt.error_code === 'terminalerror' &&
      attempt.job_error === 'delimited table exceeds the cell limit'
    ) {
      await run.record('sentry-expected', string(attempt.trace_id), {
        errorCode: 'terminalerror',
        fileId,
        jobId: attempt.job_id,
      });
    }
    assert.equal(attempt.release_sha, run.env.expectedRevision);
    assert.equal(attempt.environment, 'uat');
  }
  const jobs = await run.query(
    "SELECT id,status FROM jobs WHERE payload->>'fileId'=%s",
    [fileId]
  );
  for (const job of jobs) {
    await run.record('job', string(job.id), { fileId });
    assert.equal(job.status, 'failed');
  }
  await run.attach(`${fileId}-terminal-failure`, attempts);
  await settledSpend(run, fileId, true);
  await trashRestorePurge(run, fileId);
});
