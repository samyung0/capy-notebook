/**
 * The pin bump's seed check (openwiki/deployment-runbook.md, "Office
 * maintenance window"). Stored Office changes are taken over seed(base), so an
 * engine that seeds a base differently cannot read them. This re-seeds every
 * base named by `office-maintenance seed-manifest` (JSON lines, from a file or
 * stdin) with this checkout's engine and compares the seed's SHA-256. It exits
 * 1 when any differs: publish those files on the old engine in a maintenance
 * window before deploying the pin.
 *
 *   pnpm office:seed-check manifest.jsonl
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeOfficeRuntime,
  type OfficeFormat,
  runOffice,
} from './officeRuntime.js';
import { readSourceBytes } from './sourceDocuments.js';

export interface SeedManifestLine {
  baseSourceSHA256: string;
  files: number;
  format: OfficeFormat;
  sourceURL: string;
  stateSeedSHA256: string;
}

export interface SeedCheck extends Omit<SeedManifestLine, 'sourceURL'> {
  /** This engine's seed hash; differs from stateSeedSHA256 when changed. */
  seedSHA256: string;
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** Seeds each (format, base) once and reports every manifest line. */
export async function checkSeeds(
  lines: SeedManifestLine[],
  read: (url: string) => Promise<Uint8Array> = readSourceBytes
): Promise<SeedCheck[]> {
  const seeds = new Map<string, string>();
  const checks: SeedCheck[] = [];
  for (const { sourceURL, ...line } of lines) {
    const key = `${line.format}:${line.baseSourceSHA256}`;
    let seed = seeds.get(key);
    if (!seed) {
      const bytes = await read(sourceURL);
      if (sha256(bytes) !== line.baseSourceSHA256)
        throw new Error(`base ${line.baseSourceSHA256} downloaded other bytes`);
      seed = sha256((await runOffice('seedOffice', line.format, bytes)).state);
      seeds.set(key, seed);
    }
    checks.push({ ...line, seedSHA256: seed });
  }
  return checks;
}

async function main() {
  const path = process.argv[2];
  let input = path ? await readFile(path, 'utf8') : '';
  if (!path) for await (const chunk of process.stdin) input += chunk;
  const lines = input
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SeedManifestLine);
  try {
    const checks = await checkSeeds(lines);
    const changed = checks.filter((c) => c.seedSHA256 !== c.stateSeedSHA256);
    for (const c of checks)
      process.stdout.write(
        `${[
          c.seedSHA256 === c.stateSeedSHA256 ? 'same' : 'changed',
          c.format,
          c.baseSourceSHA256,
          `${c.files} file(s)`,
        ].join('\t')}\n`
      );
    const formats = [...new Set(changed.map((c) => c.format))];
    process.stdout.write(
      changed.length
        ? `${changed.length} of ${checks.length} seeds changed (${formats.join(', ')}): run the Office maintenance window before deploying this pin\n`
        : `${checks.length} seeds unchanged: this pin can deploy without a window\n`
    );
    process.exitCode = changed.length ? 1 : 0;
  } finally {
    await closeOfficeRuntime();
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''))
  await main();
