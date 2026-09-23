// Regenerate after changing the matching Office files or the BetterOffice pin.
// Run: pnpm exec tsx scripts/dev/seed-scenario-office.ts
import { readFile, writeFile } from 'node:fs/promises';
import { seedOffice } from '../../vendor/betteroffice/shared/office-checkpoint';

for (const [format, file] of [
  ['docx', 'lesson.docx'],
  ['xlsx', 'grades.xlsx'],
  ['pptx', 'lesson.pptx'],
] as const) {
  const result = await seedOffice(
    format,
    new Uint8Array(
      await readFile(
        new URL(`../../e2e/fixtures/files/basic/${file}`, import.meta.url)
      )
    )
  );
  await writeFile(
    new URL(
      `../../src/mocks/fixtures/${format}-checkpoint.bin`,
      import.meta.url
    ),
    result.state
  );
}
