/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
import assert from 'node:assert/strict';
import { expect, type FrameLocator, type Page } from '@playwright/test';
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
  seedOffice(format: OfficeFormat, base: Uint8Array): Promise<Checkpoint>;
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
  const source = await run.blob(string(row.base_blob_path));
  const base = Buffer.from(source.bodyBase64, 'base64');
  assert.equal(sha256(base), row.base_source_sha256);
  // A NULL state is seed(base) until the first save: the published source is
  // the current content (human/frontend/office-files.md, storage record).
  const state =
    row.state === null ? null : Buffer.from(string(row.state), 'base64');
  if (row.format === 'text') {
    if (!state) return { bytes: base, row, text: base.toString() };
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
  const native = await engine();
  const checkpoint: Checkpoint = state
    ? {
        baseSha256: source.sha256,
        format: row.format,
        schemaVersion: 1,
        state,
      }
    : await native.seedOffice(row.format, base);
  const bytes = state
    ? await native.exportOffice(base, checkpoint, {
        now: '2026-01-01T00:00:00.000Z',
        seed: sha256(state),
      })
    : base;
  const entries = await native.inspectOffice(base, checkpoint);
  return {
    bytes: Buffer.from(bytes),
    row,
    text: entries.map((entry) => entry.value).join('\n'),
  };
}

/** Size of seed(base), the part of the editing state the owner is not charged for. */
export async function seedBytes(format: OfficeFormat, base: Uint8Array) {
  return (await (await engine()).seedOffice(format, base)).state.byteLength;
}

/** The owner's storage charge as the app reports it. */
export async function storageCharge(run: UatRun) {
  return Number(object(await api(run.owner, '/api/billing')).storageUsedBytes);
}

/**
 * The owner's charge since `before` (read before the upload) is the source
 * plus its pending effects, editing-state growth beyond the recorded seed and
 * a stored baseline (human/backend-storage-quota.md, 2026-09-25 Office rule).
 */
export async function officeCharge(
  run: UatRun,
  fileId: string,
  before: number
) {
  const [charge, rows] = await Promise.all([
    storageCharge(run),
    run.query(
      `SELECT f.size_bytes,d.checkpoint,d.seed_bytes,d.pending_effects,d.net_tokens,
      octet_length(d.state) AS state_bytes,
      COALESCE(octet_length(NULLIF(d.pending_effects,'[]'::jsonb)::text),0) AS effects_bytes,
      octet_length(d.indexed_baseline) AS baseline_bytes
      FROM files f JOIN source_documents d ON d.file_id=f.id WHERE f.id=%s`,
      [fileId]
    ),
  ]);
  assert.equal(rows.length, 1, `missing source row for ${fileId}`);
  const row = rows[0];
  const growth =
    row.state_bytes === null
      ? 0
      : Math.max(0, Number(row.state_bytes) - Number(row.seed_bytes));
  assert.equal(
    charge - before,
    Number(row.size_bytes) +
      Number(row.effects_bytes) +
      growth +
      Number(row.baseline_bytes ?? 0)
  );
  await run.attach(`${fileId}-charge`, {
    ...row,
    charge: charge - before,
    pending_effects: undefined,
  });
  return row;
}

/** Waits for the edit header's durable save status. */
export async function saved(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: /^Saved$/ })
  ).toBeVisible({ timeout: 60_000 });
}

/**
 * Waits for the automatic publication while `actor` keeps the file open in
 * Edit (records 19 and 20): the editor stays mounted and read-only under the
 * banner, which says its changes were saved, and the banner's button reloads
 * the whole page. Call it inside the 60 s idle window after the last save.
 */
export async function publishWhileEditing(
  run: UatRun,
  actor: Actor,
  fileId: string
) {
  const { page } = actor;
  const mounted = await page
    .locator('iframe[src*="office-runtime"]')
    .elementHandle();
  const runtime = await mounted?.contentFrame();
  assert(mounted && runtime, 'no Office runtime is mounted');
  // A remount replaces the iframe document; a reload replaces the page.
  await runtime.evaluate(() => {
    Object.assign(window, { uatMounted: true });
  });
  await page.evaluate(() => {
    Object.assign(window, { uatPage: true });
  });
  const published = await automaticPublication(run, fileId);
  const banner = page
    .getByRole('alert')
    .filter({ hasText: 'A newer version of this file is available.' });
  await expect(
    banner.getByText(
      'A newer version of this file is available. Your changes were saved.',
      { exact: true }
    )
  ).toBeVisible({ timeout: 60_000 });
  await saved(page);
  await expect(
    page.getByRole('button', { exact: true, name: 'Save' })
  ).toBeDisabled();
  assert(await mounted.evaluate((node) => node.isConnected));
  assert(await runtime.evaluate(() => 'uatMounted' in window));
  await Promise.all([
    page.waitForEvent('load'),
    banner.getByRole('button', { exact: true, name: 'Reload' }).click(),
  ]);
  assert(!(await page.evaluate(() => 'uatPage' in window)));
  return published;
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
  // The URL's mode, not the Material mode toggle: the browser remembers the
  // last mode per file, so a second open would toggle back to View.
  await openFile(run, actor, workspaceId, fileId, 'edit');
  // Save is enabled once the replica is ready; large workbooks take longer
  // than the action timeout to open.
  const save = actor.page.getByRole('button', { exact: true, name: 'Save' });
  await expect(save).toBeEnabled({ timeout: 120_000 });
  await save.click();
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
  text: string,
  // Input-only coordinates, as a share of the slide, inside the paragraph to
  // replace; the default is the basic fixture's text box at 1in,1in on its
  // 10in x 7.5in slide. Exported content proves which text actually changed.
  at = { x: 0.17, y: 0.155 }
) {
  await frame.locator('aside button').nth(slide).click();
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = await canvas.boundingBox();
  assert(box, 'slide canvas cannot receive a pointer action');
  await canvas.click({
    clickCount: 3,
    position: { x: box.width * at.x, y: box.height * at.y },
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

/** The owner's Process: publishes the saved checkpoint after parsing it. */
export async function refresh(run: UatRun, fileId: string) {
  const checkpoint = await savedState(run, fileId);
  const before = await fileRow(run, fileId);
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
  return publication(run, fileId, checkpoint, before, string(result.jobId));
}

/**
 * The automatic refresh publishing the checkpoint saved now (3,000 net tokens
 * after 60 s idle; a store-only file publishes export-only).
 */
export async function automaticPublication(run: UatRun, fileId: string) {
  return publication(
    run,
    fileId,
    await savedState(run, fileId),
    await fileRow(run, fileId)
  );
}

async function publication(
  run: UatRun,
  fileId: string,
  checkpoint: Record<string, unknown>,
  before: Record<string, unknown>,
  jobId?: string
) {
  await run.record('blob', string(checkpoint.base_blob_path), {
    fileId,
    sourceSha256: checkpoint.base_source_sha256,
  });
  await run.poll(
    'published saved checkpoint',
    async () => {
      // The owner's Process names its job and the jobs sharing its lease;
      // an automatic refresh is found by its file once it starts.
      const jobs = jobId
        ? await run.query(
            `SELECT j.id,j.status,j.error FROM jobs j JOIN jobs requested ON requested.id=%s
        WHERE j.payload->>'fileId'=%s AND (j.id=requested.id OR
        j.payload->>'sourceLeaseToken'=requested.payload->>'sourceLeaseToken')`,
            [jobId, fileId]
          )
        : await run.query(
            "SELECT id,status,error FROM jobs WHERE payload->>'fileId'=%s AND payload->>'sourceRefresh'='true'",
            [fileId]
          );
      assert(!jobId || jobs.length > 0, `missing source refresh job ${jobId}`);
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
