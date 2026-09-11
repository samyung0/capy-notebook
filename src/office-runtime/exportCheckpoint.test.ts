import { readFileSync } from 'node:fs';
import { initWasm, openWorkbook } from '@betteroffice/xlsx/editor';
import { beforeAll, expect, it } from 'vitest';
import { exportCheckpoint } from './exportCheckpoint.worker';

const xlsx = new URL(
  '../../vendor/betteroffice/packages/xlsx/',
  import.meta.url
);
const bytesAt = (path: string) =>
  new Uint8Array(readFileSync(new URL(path, xlsx)));

// Node cannot fetch the packaged wasm URL; hand the bytes to the same loader
// the worker calls, whose later initWasm() is then a no-op.
beforeAll(() => initWasm(bytesAt('src/wasm/generated/xlsx_wasm_bg.wasm')));

it('exports the saved checkpoint over the published base', async () => {
  const base = bytesAt('test-fixtures/sample.xlsx');
  const editor = openWorkbook(base, { collaborative: true });
  editor.editCell(0, 0, 0, 'saved but unpublished');
  const checkpoint = editor.encodeStateAsUpdate();
  editor.dispose();

  const exported = await exportCheckpoint('xlsx', base, checkpoint);

  const viewer = openWorkbook(exported);
  try {
    expect(viewer.cell(0, 0, 0).input).toBe('saved but unpublished');
  } finally {
    viewer.dispose();
  }
});
