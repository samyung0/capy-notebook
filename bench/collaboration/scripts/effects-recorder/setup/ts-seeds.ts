// The TS/wasm seed (shared/office-checkpoint.ts seedOffice, what the fork's
// golden test and Capy's MSW checkpoints use) of the given fixtures, beside
// the native one in recordings/_seeds, to see where they differ.
//   bun ts-seeds.ts <file>...
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedOffice } from '../../../../../vendor/betteroffice/shared/office-checkpoint';

for (const file of process.argv.slice(2)) {
  const format = path.extname(file).slice(1) as 'docx' | 'pptx' | 'xlsx';
  const { state } = await seedOffice(format, new Uint8Array(readFileSync(file)));
  const sha = createHash('sha256').update(state).digest('hex');
  writeFileSync(`${file}.ts-seed.bin`.replace(/.*[\\/]/, path.join(process.env.OUT ?? '.', '/')), state);
  console.log(`${path.basename(file)} ${state.length} ${sha}`);
}
