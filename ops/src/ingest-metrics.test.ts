import { expect, it } from 'vitest';
import { workerResourceRows } from './ingest-metrics';

it.each([
  ['import', 'ingest', 'parse'],
  ['parse', 'ingest', 'import'],
] as const)('keeps worker roles separate in order %s, %s, %s', (...roles) => {
  const sampledAt = '2026-09-27T13:00:00Z';
  const cores = { import: 3, ingest: 2, parse: 1 };
  const samples = roles.map((role) => ({
    busyWorkers: 0,
    cpuCores: cores[role],
    memoryBytes: cores[role] * 1024 ** 3,
    memoryLimitBytes: 8 * 1024 ** 3,
    oomKillEvents: 0,
    role,
    sampledAt,
    workerCount: 1,
  }));

  expect(workerResourceRows(samples)).toEqual([
    {
      importCpu: 3,
      importMemoryGiB: 3,
      ingestCpu: 2,
      ingestMemoryGiB: 2,
      parseCpu: 1,
      parseMemoryGiB: 1,
      sampledAt,
    },
  ]);
});
