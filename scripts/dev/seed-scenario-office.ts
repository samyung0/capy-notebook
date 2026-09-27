// Regenerate after changing the matching Office files or the BetterOffice pin.
// Run: pnpm exec tsx scripts/dev/seed-scenario-office.ts
import { readFile, writeFile } from 'node:fs/promises';
import { seedOffice } from '../../vendor/betteroffice/shared/office-checkpoint';

for (const [format, file, checkpoint] of [
  ['docx', 'basic/lesson.docx', 'docx'],
  ['xlsx', 'basic/grades.xlsx', 'xlsx'],
  ['pptx', 'basic/lesson.pptx', 'pptx'],
  ['docx', 'rich-content/exchange-plan.docx', 'rich-docx'],
  ['xlsx', 'rich-content/course-guide.xlsx', 'rich-xlsx'],
  ['pptx', 'rich-content/lecture.pptx', 'rich-pptx'],
] as const) {
  const result = await seedOffice(
    format,
    new Uint8Array(
      await readFile(
        new URL(`../../e2e/fixtures/files/${file}`, import.meta.url)
      )
    )
  );
  await writeFile(
    new URL(
      `../../src/mocks/fixtures/${checkpoint}-checkpoint.bin`,
      import.meta.url
    ),
    result.state
  );
}
