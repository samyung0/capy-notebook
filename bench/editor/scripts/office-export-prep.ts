// Seeds a checkpoint for each Office file the browser export probe measures
// (bench/editor/reports/2026-10-28-office-browser-export.md): the file and
// its seeded state go to bench/editor/.results/office-export/files.
// Run: pnpm exec tsx bench/editor/scripts/office-export-prep.ts
// after python3 bench/editor/scripts/gen_office_ladder.py.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { seedOffice } from '../../../vendor/betteroffice/shared/office-checkpoint';

export const CASES = [
  ['docx', 'bench/editor/fixtures/office/long-handbook.docx'],
  ['docx', 'bench/editor/.results/ladder/docx-text-192.docx'],
  ['docx', 'bench/editor/.results/ladder/docx-table-96.docx'],
  ['docx', 'bench/editor/.results/ladder/docx-picture-24.docx'],
  ['docx', 'bench/editor/.results/ladder/docx-picture-64.docx'],
  ['xlsx', 'bench/editor/fixtures/office/large-gradebook.xlsx'],
  ['xlsx', 'bench/editor/fixtures/office/rows-50k.xlsx'],
  ['xlsx', 'bench/editor/.results/ladder/xlsx-formula-8000.xlsx'],
  ['xlsx', 'bench/editor/.results/ladder/xlsx-style-8000.xlsx'],
  ['pptx', 'bench/editor/.results/ladder/pptx-text-400.pptx'],
  ['pptx', 'bench/parsers/fixtures/docs/jp_llm2.pptx'],
  ['pptx', 'bench/editor/.results/ladder/pptx-picture-40.pptx'],
] as const;

const out = 'bench/editor/.results/office-export/files';
await mkdir(out, { recursive: true });
for (const [format, file] of CASES) {
  const name = file.split('/').at(-1)!;
  const bytes = new Uint8Array(await readFile(file));
  const started = performance.now();
  const { state } = await seedOffice(format, bytes);
  await copyFile(file, `${out}/${name}`);
  await writeFile(`${out}/${name}.state`, state);
  console.log(`${name}: ${bytes.length} bytes, state ${state.length} bytes, seeded in ${Math.round(performance.now() - started)} ms`);
}
