import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type PerfSnapshot = {
  commit: string;
  createdAt: string;
  cpuModel: string;
  cpuRate: number;
  chromium: string;
  cases: Record<string, unknown>;
};

export type RelativeMetric = {
  caseName: string;
  path: string[];
  label: string;
  direction: 'lower-better';
};

export type ComparisonRow = RelativeMetric & {
  absoluteDelta: number | null;
  baseline: number | null;
  current: number | null;
  percentDelta: number | null;
};

export const RELATIVE_METRICS: RelativeMetric[] = [
  {
    caseName: 'open-large-document',
    direction: 'lower-better',
    label: 'Large document interactive open',
    path: ['interactive', 'openMs'],
  },
  {
    caseName: 'typing-large-document',
    direction: 'lower-better',
    label: 'Large document typing blocking per keystroke',
    path: ['typing', 'blockingPerKeystrokeMs'],
  },
  {
    caseName: 'typing-large-document',
    direction: 'lower-better',
    label: 'Large document save-cycle blocking',
    path: ['saveCycle', 'loafTotalBlockingMs'],
  },
];

type SnapshotMetadata = Omit<PerfSnapshot, 'cases' | 'createdAt'> & {
  createdAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePerfSnapshot(value: unknown): PerfSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.commit !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.cpuModel !== 'string' ||
    typeof value.cpuRate !== 'number' ||
    !Number.isFinite(value.cpuRate) ||
    typeof value.chromium !== 'string' ||
    !isRecord(value.cases)
  ) {
    return null;
  }

  return {
    cases: value.cases,
    chromium: value.chromium,
    commit: value.commit,
    cpuModel: value.cpuModel,
    cpuRate: value.cpuRate,
    createdAt: value.createdAt,
  };
}

export async function assembleSnapshot({
  commit,
  cpuModel,
  cpuRate,
  chromium,
  createdAt = new Date().toISOString(),
  snapshotDir,
}: SnapshotMetadata & { snapshotDir: string }): Promise<PerfSnapshot> {
  const cases: Record<string, unknown> = {};

  if (existsSync(snapshotDir)) {
    const entries = (await readdir(snapshotDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const caseName = entry.name.slice(0, -'.json'.length);
      const contents = await readFile(
        path.join(snapshotDir, entry.name),
        'utf8'
      );
      const payload: unknown = JSON.parse(contents);
      cases[caseName] = payload;
    }
  }

  return {
    cases,
    chromium,
    commit,
    cpuModel,
    cpuRate,
    createdAt,
  };
}

function readMetric(
  cases: Record<string, unknown>,
  metric: RelativeMetric
): number | null {
  let value: unknown = cases[metric.caseName];
  for (const segment of metric.path) {
    if (!isRecord(value)) return null;
    value = value[segment];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number | null): string {
  if (value === null) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDelta(row: ComparisonRow): string {
  if (row.absoluteDelta === null) return 'n/a';
  const absolutePrefix = row.absoluteDelta > 0 ? '+' : '';
  const absolute = `${absolutePrefix}${formatNumber(row.absoluteDelta)} ms`;
  if (row.percentDelta === null) return absolute;
  const percentPrefix = row.percentDelta > 0 ? '+' : '';
  return `${absolute} (${percentPrefix}${row.percentDelta.toFixed(1)}%)`;
}

export function compareSnapshots(
  current: PerfSnapshot,
  baseline: PerfSnapshot | null
): { markdown: string; rows: ComparisonRow[] } {
  const rows = RELATIVE_METRICS.map((metric) => {
    const currentValue = readMetric(current.cases, metric);
    const baselineValue = baseline ? readMetric(baseline.cases, metric) : null;
    const absoluteDelta =
      currentValue === null || baselineValue === null
        ? null
        : currentValue - baselineValue;
    const percentDelta =
      absoluteDelta === null || baselineValue === 0
        ? null
        : (absoluteDelta / baselineValue) * 100;

    return {
      ...metric,
      absoluteDelta,
      baseline: baselineValue,
      current: currentValue,
      percentDelta,
    };
  });

  const lines = [
    '## Editor perf comparison',
    '',
    `Current snapshot: \`${current.commit}\` on \`${current.cpuModel}\`, CPU x${current.cpuRate}, ${current.chromium}.`,
    '',
  ];

  if (baseline) {
    lines.push(
      `Baseline snapshot: \`${baseline.commit}\` from ${baseline.createdAt}.`,
      ''
    );
    if (current.cpuModel !== baseline.cpuModel) {
      lines.push(
        `> Warning: CPU model changed from \`${baseline.cpuModel}\` to \`${current.cpuModel}\`. The deltas may reflect runner hardware.`,
        ''
      );
    }
  } else {
    lines.push(
      '> First run: no successful Editor perf snapshot artifact is available yet.',
      ''
    );
  }

  lines.push(
    'Relative deltas are warn-only. The Playwright absolute budgets remain the only performance failure gate.',
    '',
    '| Metric, lower is better | Current (ms) | Baseline (ms) | Delta |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.label} | ${formatNumber(row.current)} | ${formatNumber(row.baseline)} | ${formatDelta(row)} |`
    ),
    '',
    '### Current case payloads, context only',
    '',
    'Small-document typing, INP estimates, scroll FPS, and longest-frame values appear here but are not compared.',
    '',
    '```json',
    JSON.stringify(current.cases, null, 2),
    '```',
    ''
  );

  return { markdown: lines.join('\n'), rows };
}
