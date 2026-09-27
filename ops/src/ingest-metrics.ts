import type { IngestHostMetrics } from './api';

const GIB = 1024 ** 3;

export function workerResourceRows(
  samples: IngestHostMetrics['environments'][number]['workerSamples']
) {
  const buckets = new Map<
    string,
    {
      importCpu: number;
      importMemoryGiB: number;
      ingestCpu: number;
      ingestMemoryGiB: number;
      parseCpu: number;
      parseMemoryGiB: number;
      sampledAt: string;
    }
  >();
  for (const sample of samples) {
    const row = buckets.get(sample.sampledAt) ?? {
      importCpu: 0,
      importMemoryGiB: 0,
      ingestCpu: 0,
      ingestMemoryGiB: 0,
      parseCpu: 0,
      parseMemoryGiB: 0,
      sampledAt: sample.sampledAt,
    };
    if (
      sample.role !== 'import' &&
      sample.role !== 'parse' &&
      sample.role !== 'ingest'
    ) {
      continue;
    }
    row[`${sample.role}Cpu`] = sample.cpuCores;
    row[`${sample.role}MemoryGiB`] = sample.memoryBytes / GIB;
    buckets.set(sample.sampledAt, row);
  }
  return [...buckets.values()];
}
