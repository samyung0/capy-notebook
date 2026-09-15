/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
import assert from 'node:assert/strict';
import type { FrameLocator } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import * as Y from 'yjs';
import { sanitize } from './evidence';
import { api, fileRow, object, openFile, sha256, string } from './files';
import type { Actor, UatRun } from './runtime';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
type Checkpoint = {
  format: OfficeFormat;
  schemaVersion: 1;
  baseSha256: string;
  state: Uint8Array;
};
type OfficeRuntime = {
  exportOffice(
    base: Uint8Array,
    checkpoint: Checkpoint,
    determinism: { seed: string; now: string }
  ): Promise<Uint8Array>;
  inspectOffice(
    base: Uint8Array,
    checkpoint: Checkpoint
  ): Promise<Array<{ value: string; label: string; position: string }>>;
};
let runtime: Promise<OfficeRuntime> | undefined;
function engine() {
  // office:prepare builds this Node bundle and places its WASM assets beside it.
  runtime ??= import(
    new URL(
      '../../../vendor/betteroffice/shared/office-checkpoint.mjs',
      import.meta.url
    ).href
  ) as Promise<OfficeRuntime>;
  return runtime;
}

export async function savedState(run: UatRun, fileId: string) {
  const rows = await run.query(
    `SELECT format,checkpoint,indexed_checkpoint,epoch,base_blob_path,base_source_sha256,
    encode(state,'base64') AS state FROM source_documents WHERE file_id=%s`,
    [fileId]
  );
  assert.equal(rows.length, 1, `missing source state for ${fileId}`);
  return rows[0];
}

export async function savedExport(run: UatRun, fileId: string) {
  const row = await savedState(run, fileId);
  const state = Buffer.from(string(row.state), 'base64');
  if (row.format === 'text') {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      const text = doc.getText('source').toString();
      return { bytes: Buffer.from(text), row, text };
    } finally {
      doc.destroy();
    }
  }
  assert(
    row.format === 'docx' || row.format === 'xlsx' || row.format === 'pptx'
  );
  const source = await run.blob(string(row.base_blob_path));
  const base = Buffer.from(source.bodyBase64, 'base64');
  assert.equal(sha256(base), row.base_source_sha256);
  const checkpoint: Checkpoint = {
    baseSha256: source.sha256,
    format: row.format,
    schemaVersion: 1,
    state,
  };
  const native = await engine();
  const bytes = await native.exportOffice(base, checkpoint, {
    now: '2026-01-01T00:00:00.000Z',
    seed: sha256(state),
  });
  const entries = await native.inspectOffice(base, checkpoint);
  return {
    bytes: Buffer.from(bytes),
    row,
    text: entries.map((entry) => entry.value).join('\n'),
  };
}

export async function savedFacts(run: UatRun, fileId: string, facts: string[]) {
  const exported = await run.poll(
    `saved edits ${fileId}`,
    () => savedExport(run, fileId),
    (result) => facts.every((fact) => result.text.includes(fact)),
    120_000
  );
  await run.attach(`${fileId}-saved-content`, {
    checkpoint: exported.row.checkpoint,
    epoch: exported.row.epoch,
    sha256: sha256(exported.bytes),
    text: exported.text,
  });
  return exported;
}

export async function openEditor(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  fileId: string
): Promise<FrameLocator> {
  await openFile(run, actor, workspaceId, fileId);
  await actor.page.getByRole('button', { exact: true, name: 'Edit' }).click();
  // This normal action waits for the replica-ready Save control before typing.
  await actor.page.getByRole('button', { exact: true, name: 'Save' }).click();
  return actor.page.frameLocator('iframe[src*="office-runtime"]');
}

export async function editOffice(
  actor: Actor,
  frame: FrameLocator,
  format: OfficeFormat,
  collaborator: boolean
) {
  if (format === 'docx') {
    const input = frame.getByRole('textbox', { name: 'Document input' });
    await input.focus();
    if (collaborator) {
      await input.press('ControlOrMeta+End');
      await input.press('Enter');
      await input.pressSequentially(
        'Collaborator confirmed the survey starts in July.'
      );
    } else {
      await input.press('ControlOrMeta+Home');
      await input.press('Shift+End');
      await input.pressSequentially(
        'Owner sentence: The launch code is CEDAR-42.'
      );
    }
  } else if (format === 'xlsx') {
    await frame.getByRole('tab', { exact: true, name: 'Grades' }).click();
    const app = frame.getByTestId('xlsx-scroll');
    await app.focus();
    await app.press('ControlOrMeta+Home');
    await app.press('ArrowDown');
    if (collaborator) await app.press('ArrowDown');
    await app.press('ArrowRight');
    const input = frame.getByTestId('xlsx-formula-input');
    await input.fill(collaborator ? '19' : '43');
    await input.press('Enter');
  } else {
    await replaceSlideText(
      frame,
      collaborator ? 1 : 0,
      collaborator
        ? 'Collaborator confirmed the survey starts in July.'
        : 'Owner sentence: The launch code is CEDAR-42.'
    );
  }
  await actor.page.getByRole('button', { exact: true, name: 'Save' }).click();
}

export async function replaceSlideText(
  frame: FrameLocator,
  slide: number,
  text: string
) {
  await frame.locator('aside button').nth(slide).click();
  // Input-only coordinates target the fixture's text box at 1in,1in on its
  // 10in x 7.5in slide. Exported content proves which text actually changed.
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = await canvas.boundingBox();
  assert(box, 'slide canvas cannot receive a pointer action');
  await canvas.click({
    clickCount: 3,
    position: { x: box.width * 0.17, y: box.height * 0.155 },
  });
  await frame.getByRole('application').pressSequentially(text);
}

export function assertPreserved(format: OfficeFormat, bytes: Uint8Array) {
  const zip = unzipSync(bytes);
  if (format === 'xlsx') {
    assert.match(
      strFromU8(zip['xl/worksheets/sheet1.xml']),
      /<f(?:\s[^>]*)?>B2\*2<\/f>/
    );
    const workbook = strFromU8(zip['xl/workbook.xml']);
    assert(workbook.includes('Grades') && workbook.includes('Notes'));
  } else if (format === 'docx') {
    const xml = strFromU8(zip['word/document.xml']);
    assert(
      xml.includes('Wetland') && xml.includes('42') && /<w:tbl[ >]/.test(xml)
    );
    assert(
      Object.entries(zip).some(
        ([key, value]) =>
          /^word\/header\d+\.xml$/.test(key) &&
          strFromU8(value).includes('Capy synthetic field notes')
      )
    );
  } else {
    assert(zip['ppt/slides/slide1.xml'] && zip['ppt/slides/slide2.xml']);
  }
}

export async function refresh(run: UatRun, fileId: string) {
  const checkpoint = await savedState(run, fileId);
  const before = await fileRow(run, fileId);
  await run.record('blob', string(checkpoint.base_blob_path), {
    fileId,
    sourceSha256: checkpoint.base_source_sha256,
  });
  const result = object(
    await api(
      run.owner,
      `/api/files/${fileId}/process-changes`,
      'POST',
      undefined,
      202
    )
  );
  await run.attach(`${fileId}-process`, result);
  const jobId = string(result.jobId);
  await run.poll(
    'published saved checkpoint',
    async () => {
      const jobs = await run.query(
        `SELECT j.id,j.status,j.error FROM jobs j JOIN jobs requested ON requested.id=%s
        WHERE j.payload->>'fileId'=%s AND (j.id=requested.id OR
        j.payload->>'sourceLeaseToken'=requested.payload->>'sourceLeaseToken')`,
        [jobId, fileId]
      );
      assert(jobs.length > 0, `missing source refresh job ${jobId}`);
      for (const job of jobs) {
        await run.record('job', string(job.id), { fileId });
        assert.notEqual(
          job.status,
          'failed',
          `source refresh ${fileId} failed in ${job.id}: ${sanitize(job.error)}`
        );
      }
      const candidates = await run.query(
        'SELECT job_id,source_blob_path,source_sha256 FROM source_refresh_candidates WHERE file_id=%s',
        [fileId]
      );
      for (const candidate of candidates) {
        await run.record('job', string(candidate.job_id), { fileId });
        if (typeof candidate.source_blob_path === 'string')
          await run.record('blob', candidate.source_blob_path, {
            fileId,
            sourceSha256: candidate.source_sha256,
          });
      }
      return savedState(run, fileId);
    },
    (state) =>
      Number(state.indexed_checkpoint) >= Number(checkpoint.checkpoint),
    900_000
  );
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
