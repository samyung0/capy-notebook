// Do two exports of the same state with different job seeds produce different bytes?
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const runtime = await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs');
for (const input of process.argv.slice(2)) {
  const format = input.split('.').pop();
  const bytes = new Uint8Array(await readFile(input));
  const seed = await runtime.seedOffice(format, bytes);
  const cp = { baseSha256: seed.baseSha256, format, schemaVersion: 1, state: seed.state };
  const shas = [];
  for (const job of ['job-a', 'job-a', 'job-b']) {
    const out = await runtime.exportOffice(bytes, cp, { now: '2000-01-01T00:00:00.000Z', seed: createHash('sha256').update(job).digest('hex') });
    shas.push(createHash('sha256').update(out).digest('hex').slice(0, 12));
  }
  console.log(input.split('/').pop(), 'same job twice:', shas[0] === shas[1], 'different job:', shas[0] === shas[2], shas.join(' '));
}
