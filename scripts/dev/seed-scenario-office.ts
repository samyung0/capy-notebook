// Regenerate after changing the matching Office files or the BetterOffice pin.
// Run: pnpm exec tsx scripts/dev/seed-scenario-office.ts
import { readFile, writeFile } from 'node:fs/promises';
import { seedOffice } from '../../vendor/betteroffice/shared/office-checkpoint';

for (const [format, file, checkpoint] of [
  ['docx', 'e2e/fixtures/files/basic/lesson.docx', 'docx'],
  ['xlsx', 'e2e/fixtures/files/basic/grades.xlsx', 'xlsx'],
  ['pptx', 'e2e/fixtures/files/basic/lesson.pptx', 'pptx'],
  ['docx', 'e2e/fixtures/files/rich-content/exchange-plan.docx', 'rich-docx'],
  ['xlsx', 'e2e/fixtures/files/rich-content/course-guide.xlsx', 'rich-xlsx'],
  ['pptx', 'e2e/fixtures/files/rich-content/lecture.pptx', 'rich-pptx'],
  // The Office perf spec's 62-page document (VITE_LOAD_TEST_SEED).
  ['docx', 'bench/editor/fixtures/office/long-handbook.docx', 'long-docx'],
] as const) {
  const result = await seedOffice(
    format,
    new Uint8Array(await readFile(new URL(`../../${file}`, import.meta.url)))
  );
  await writeFile(
    new URL(
      `../../src/mocks/fixtures/${checkpoint}-checkpoint.bin`,
      import.meta.url
    ),
    result.state
  );
}
