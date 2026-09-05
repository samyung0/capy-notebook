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

export type Delta = {
  absoluteMs: number;
  percent: number | null;
};

export type ComparisonRow = RelativeMetric & {
  best: number | null;
  current: number | null;
  median: number | null;
  vsBest: Delta | null;
  vsMedian: Delta | null;
};

/** How many of the newest green snapshots feed the median column. */
export const MEDIAN_WINDOW = 5;

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

function formatDelta(delta: Delta | null): string {
  if (delta === null) return 'n/a';
  const absolutePrefix = delta.absoluteMs > 0 ? '+' : '';
  const absolute = `${absolutePrefix}${formatNumber(delta.absoluteMs)} ms`;
  if (delta.percent === null) return absolute;
  const percentPrefix = delta.percent > 0 ? '+' : '';
  return `${absolute} (${percentPrefix}${delta.percent.toFixed(1)}%)`;
}

function delta(current: number | null, reference: number | null): Delta | null {
  if (current === null || reference === null) return null;
  const absoluteMs = current - reference;
  return {
    absoluteMs,
    percent: reference === 0 ? null : (absoluteMs / reference) * 100,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Compare the current snapshot with every retained green snapshot. The median
 * of the newest `MEDIAN_WINDOW` answers "are we drifting"; the best value over
 * all of them is a floor that cannot creep upward one checkpoint at a time.
 */
export function compareSnapshots(
  current: PerfSnapshot,
  baselines: PerfSnapshot[]
): { markdown: string; rows: ComparisonRow[] } {
  const newestFirst = [...baselines].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const window = newestFirst.slice(0, MEDIAN_WINDOW);

  const rows = RELATIVE_METRICS.map((metric) => {
    const currentValue = readMetric(current.cases, metric);
    const read = (snapshots: PerfSnapshot[]) =>
      snapshots
        .map((snapshot) => readMetric(snapshot.cases, metric))
        .filter((value): value is number => value !== null);
    const all = read(newestFirst);
    const medianValue = median(read(window));
    const bestValue = all.length ? Math.min(...all) : null;

    return {
      ...metric,
      best: bestValue,
      current: currentValue,
      median: medianValue,
      vsBest: delta(currentValue, bestValue),
      vsMedian: delta(currentValue, medianValue),
    };
  });

  const lines = [
    '## Editor perf comparison',
    '',
    `Current snapshot: \`${current.commit}\` on \`${current.cpuModel}\`, CPU x${current.cpuRate}, ${current.chromium}.`,
    '',
  ];

  if (newestFirst.length) {
    const oldest = newestFirst.at(-1)!;
    lines.push(
      `Baselines: ${newestFirst.length} green snapshot(s), newest \`${newestFirst[0].commit}\` (${newestFirst[0].createdAt}), oldest \`${oldest.commit}\` (${oldest.createdAt}). Median uses the newest ${window.length}.`,
      ''
    );
    const otherCpus = [
      ...new Set(newestFirst.map((snapshot) => snapshot.cpuModel)),
    ].filter((model) => model !== current.cpuModel);
    if (otherCpus.length) {
      lines.push(
        `> Warning: baselines include other CPU models (${otherCpus.map((model) => `\`${model}\``).join(', ')}); current is \`${current.cpuModel}\`. The deltas may reflect runner hardware.`,
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
    '| Metric, lower is better | Current (ms) | Median (ms) | vs median | Best (ms) | vs best |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.label} | ${formatNumber(row.current)} | ${formatNumber(row.median)} | ${formatDelta(row.vsMedian)} | ${formatNumber(row.best)} | ${formatDelta(row.vsBest)} |`
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
