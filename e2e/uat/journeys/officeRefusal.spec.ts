import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import {
  fileRow,
  fixture,
  processed,
  sha256,
  string,
  upload,
  workspace,
} from './files';
import { openEditor, saved, savedState } from './office';
import {
  editTocLink,
  heldPublication,
  refusedPublication,
  republication,
  setHold,
} from './officeRefusal';
import { pasteRich, richPaste } from './richContent';
import { test } from './runtime';

// Needs UAT's COLLABORATION_UAT_PUBLICATION_HOLD=true (deployment runbook §12.2).
test('docx refusal: a held publication refuses a TOC-link edit and the automatic republication publishes it', async ({
  run,
}) => {
  test.setTimeout(2_400_000);
  const workspaceId = await workspace(run, 'refusal');
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  const name = 'report.docx';
  const fileId = await upload(
    run,
    workspaceId,
    name,
    await fixture(name, marker, 'toc')
  );
  await processed(run, fileId, [marker]);
  // Arm the hold before any publication is due: collaboration holds this
  // file's publications after their capture while its name has the marker.
  await setHold(run, fileId, name, true);

  const page = run.owner.page;
  const frame = await openEditor(run, run.owner, workspaceId, fileId);
  await saved(page);
  // About 3,500 net tokens: the automatic publication is due 60 s after this save.
  const paste = richPaste(marker);
  await pasteRich(page, frame, 'docx', paste);
  await saved(page);
  const [due] = await run.query(
    'SELECT checkpoint,net_tokens FROM source_documents WHERE file_id=%s',
    [fileId]
  );
  assert(Number(due.net_tokens) >= 3000);
  const held = await heldPublication(run, fileId);
  assert.equal(held.checkpoint, Number(due.checkpoint));
  const before = await fileRow(run, fileId);

  // Within the 60 s hold: the refusing edit, saved after the capture.
  const edit = await editTocLink(page, frame);
  await saved(page);
  const edited = await run.poll(
    'saved TOC edit',
    () => savedState(run, fileId),
    (state) => Number(state.checkpoint) > held.checkpoint,
    30_000
  );
  // Still held: nothing published and the publishing job still runs.
  const [job] = await run.query('SELECT status FROM jobs WHERE id=%s', [
    held.jobId,
  ]);
  assert.equal(job.status, 'running');
  assert(Number(edited.indexed_checkpoint) < held.checkpoint);
  // No editor stays connected through either handoff.
  await page.goto(`${run.env.appUrl}/workspaces`);
  await setHold(run, fileId, name, false);

  await refusedPublication(run, fileId, held.jobId, before);
  const published = await republication(
    run,
    fileId,
    held.jobId,
    Number(edited.checkpoint),
    before
  );
  // The fresh publication captured the edit rather than rebasing it: nothing
  // was saved after its capture, so the state is seed(published) again.
  const current = await savedState(run, fileId);
  assert.equal(current.state, null);
  const source = await run.blob(string(published.blob_path));
  const bytes = Buffer.from(source.bodyBase64, 'base64');
  assert.equal(sha256(bytes), published.source_sha256);
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
  assert(xml.includes(edit.published), 'the published file lacks the TOC edit');
  assert(xml.includes(marker));
  await run.attach(`${fileId}-republished`, {
    checkpoint: current.checkpoint,
    epoch: current.epoch,
    sha256: published.source_sha256,
  });
});
