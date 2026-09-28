import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { preloadEditWasm } from '@betteroffice/docx/wasm/edit';
import { preloadOpcWasm } from '@betteroffice/docx/wasm/opc';
import { preloadParseWasm } from '@betteroffice/docx/wasm/parse';
import { initWasm as initPptx } from '@betteroffice/pptx/editor';
import { initWasm, openWorkbook } from '@betteroffice/xlsx/editor';
import { beforeAll, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { OfficeFormat } from '@/features/files/officeProtocol';
import { exportCheckpoint } from './exportCheckpoint.worker';

// The collaboration service's headless engine bundle, loaded as the service
// loads it (collaboration/src/officeRuntime.ts).
type Checkpoint = {
  baseSha256: string;
  format: OfficeFormat;
  schemaVersion: 1;
  state: Uint8Array;
};
type Entry = { id: string; label: string; value: string };
const { applyOfficeCommands, inspectOffice, seedOffice } = (await import(
  /* @vite-ignore */ new URL(
    '../../vendor/betteroffice/shared/office-checkpoint.mjs',
    import.meta.url
  ).href
)) as {
  applyOfficeCommands(
    base: Uint8Array,
    checkpoint: Checkpoint,
    commands: unknown[]
  ): Promise<{ state: Uint8Array }>;
  inspectOffice(base: Uint8Array, checkpoint: Checkpoint): Promise<Entry[]>;
  seedOffice(format: OfficeFormat, base: Uint8Array): Promise<Checkpoint>;
};

const xlsx = new URL(
  '../../vendor/betteroffice/packages/xlsx/',
  import.meta.url
);
const bytesAt = (path: string) =>
  new Uint8Array(readFileSync(new URL(path, xlsx)));

// Node cannot fetch the packaged wasm URL; hand the bytes to the same loader
// the worker calls, whose later initWasm() is then a no-op.
const runtimeWasm = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../vendor/betteroffice/shared/office-runtime/${name}.wasm`,
        import.meta.url
      )
    )
  );
beforeAll(() =>
  Promise.all([
    initWasm(bytesAt('src/wasm/generated/xlsx_wasm_bg.wasm')),
    preloadEditWasm(runtimeWasm('docx')),
    preloadParseWasm(runtimeWasm('parse')),
    preloadOpcWasm(runtimeWasm('opc')),
    initPptx(runtimeWasm('pptx')),
  ])
);

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

// The collaboration service stores an Office change over seed(base) and the
// seed's SHA-256 (its headless engine bundle); the viewer's engines must seed
// the same bytes, or every saved-but-unpublished view would be refused.
it.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  'exports a %s change over the seed the service hashed',
  async (format, path) => {
    const base = new Uint8Array(
      readFileSync(
        new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
      )
    );
    const seed = await seedOffice(format, base);
    const [target] = (await inspectOffice(base, seed)).filter(
      (entry) => entry.value.length > 0
    );
    const edited = await applyOfficeCommands(base, seed, [
      format === 'xlsx'
        ? {
            cell: target.label.slice(target.label.lastIndexOf('!') + 1),
            expectedValue: target.value,
            sheet: target.label.slice(0, target.label.lastIndexOf('!')),
            type: 'set_cell',
            value: 'Viewed change',
          }
        : {
            expectedText: target.value,
            targetId: target.id,
            text: 'Viewed change',
            type: 'replace_text',
          },
    ]);
    const document = new Y.Doc();
    Y.applyUpdate(document, edited.state);
    const change = Y.encodeStateAsUpdate(
      document,
      Y.encodeStateVectorFromUpdate(seed.state)
    );
    const seedSHA256 = createHash('sha256').update(seed.state).digest('hex');
    const exported = await exportCheckpoint(format, base, change, seedSHA256);
    const values = (
      await inspectOffice(exported, await seedOffice(format, exported))
    ).map((entry) => entry.value);
    expect(values).toContain('Viewed change');
    await expect(
      exportCheckpoint(format, base, change, '0'.repeat(64))
    ).rejects.toThrow('different seed');
  },
  60_000
);
