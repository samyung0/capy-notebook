import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  assembleSnapshot,
  compareSnapshots,
  type PerfSnapshot,
  parsePerfSnapshot,
} from './snapshot';

async function readSnapshot(filePath: string): Promise<PerfSnapshot | null> {
  if (!existsSync(filePath)) return null;
  const contents = await readFile(filePath, 'utf8');
  const value: unknown = JSON.parse(contents);
  return parsePerfSnapshot(value);
}

function argument(args: string[], index: number, usage: string): string {
  const value = args[index];
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'assemble') {
    const snapshotDir = argument(
      args,
      0,
      'compare-cli.ts assemble <case-dir> <output>'
    );
    const output = argument(
      args,
      1,
      'compare-cli.ts assemble <case-dir> <output>'
    );
    const configuredCpuRate = Number(process.env.PERF_CPU ?? 4);
    const snapshot = await assembleSnapshot({
      chromium: process.env.PERF_CHROMIUM ?? 'unknown',
      // PERF_COMMIT wins because GITHUB_SHA is the caller's SHA when this runs
      // through workflow_call, not the measured revision.
      commit: process.env.PERF_COMMIT ?? process.env.GITHUB_SHA ?? 'unknown',
      cpuModel: process.env.PERF_CPU_MODEL ?? 'unknown',
      cpuRate: Number.isFinite(configuredCpuRate) ? configuredCpuRate : 4,
      snapshotDir,
    });
    await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return;
  }

  if (command === 'compare') {
    const currentPath = argument(
      args,
      0,
      'compare-cli.ts compare <current> [baseline...]'
    );
    const current = await readSnapshot(currentPath);
    if (!current)
      throw new Error(`Invalid performance snapshot: ${currentPath}`);
    // An unexpanded shell glob or a run whose artifact expired yields a
    // missing or malformed file; skip it rather than lose the whole table.
    const baselines = (
      await Promise.all(args.slice(1).map((file) => readSnapshot(file)))
    ).filter((snapshot): snapshot is PerfSnapshot => snapshot !== null);
    process.stdout.write(compareSnapshots(current, baselines).markdown);
    return;
  }

  throw new Error(
    'Usage: compare-cli.ts assemble <case-dir> <output> | compare <current> [baseline...]'
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
