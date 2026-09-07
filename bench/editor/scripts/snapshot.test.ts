import { describe, expect, it } from 'vitest';
import {
  compareSnapshots,
  MEDIAN_WINDOW,
  type PerfSnapshot,
  RELATIVE_METRICS,
} from './snapshot';

function snapshot({
  commit,
  cpuModel = 'AMD EPYC',
  createdAt = '2026-08-24T12:00:00.000Z',
  openMs = 1000,
  typingBlockingMs = 100,
  saveCycleBlockingMs = 200,
}: {
  commit: string;
  cpuModel?: string;
  createdAt?: string;
  openMs?: number;
  typingBlockingMs?: number;
  saveCycleBlockingMs?: number;
}): PerfSnapshot {
  return {
    cases: {
      'open-large-document': {
        interactive: { openMs },
      },
      'scroll-large-document': {
        avgFps: 40,
        longestFrameMs: 100,
      },
      'typing-large-document': {
        saveCycle: { loafTotalBlockingMs: saveCycleBlockingMs },
        typing: {
          blockingPerKeystrokeMs: typingBlockingMs,
          inpApproxMs: 500,
        },
      },
      'typing-small-document': {
        blockingPerKeystrokeMs: 5,
        inpApproxMs: 100,
      },
    },
    chromium: 'Version 1.61.1',
    commit,
    cpuModel,
    cpuRate: 4,
    createdAt,
  };
}

const typingRow = (rows: ReturnType<typeof compareSnapshots>['rows']) =>
  rows.find((row) => row.path.join('.') === 'typing.blockingPerKeystrokeMs');

describe('performance snapshot comparison', () => {
  it('reports a first run without baselines', () => {
    const result = compareSnapshots(snapshot({ commit: 'current' }), []);

    expect(result.markdown).toContain('First run');
    expect(result.markdown).toContain('1,000');
    expect(result.rows).toHaveLength(3);
    expect(typingRow(result.rows)).toMatchObject({
      best: null,
      median: null,
      vsBest: null,
      vsMedian: null,
    });
  });

  it('compares against the median of the newest window and the best ever', () => {
    // Seven greens, oldest first. The typing metric creeps 100 → 160 by 10ms
    // per checkpoint; a last-green comparison would show +10 every time.
    const baselines = Array.from({ length: 7 }, (_, index) =>
      snapshot({
        commit: `green-${index}`,
        createdAt: `2026-08-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
        typingBlockingMs: 100 + index * 10,
      })
    );
    const current = snapshot({ commit: 'current', typingBlockingMs: 170 });

    const result = compareSnapshots(current, baselines);
    const typing = typingRow(result.rows);

    // Newest five are 120..160, median 140. Best over all seven is 100.
    expect(MEDIAN_WINDOW).toBe(5);
    expect(typing).toMatchObject({
      best: 100,
      current: 170,
      median: 140,
      vsBest: { absoluteMs: 70, percent: 70 },
      vsMedian: { absoluteMs: 30 },
    });
    expect(result.markdown).toContain('+70 ms (+70.0%)');
    expect(result.markdown).toContain('warn-only');
    expect(result.markdown).toContain('Median uses the newest 5');
  });

  it('warns when any baseline came from another runner CPU model', () => {
    const baselines = [
      snapshot({ commit: 'a', cpuModel: 'AMD EPYC' }),
      snapshot({ commit: 'b', cpuModel: 'Intel Xeon' }),
    ];
    const current = snapshot({ commit: 'current', cpuModel: 'AMD EPYC' });

    expect(compareSnapshots(current, baselines).markdown).toContain(
      'other CPU models (`Intel Xeon`)'
    );
  });

  it('excludes noisy context metrics from relative comparison', () => {
    const comparedPaths = RELATIVE_METRICS.map(
      (metric) => `${metric.caseName}.${metric.path.join('.')}`
    );

    expect(comparedPaths).not.toContain(
      'typing-small-document.blockingPerKeystrokeMs'
    );
    expect(comparedPaths.some((path) => path.endsWith('.inpApproxMs'))).toBe(
      false
    );
    expect(comparedPaths.some((path) => path.startsWith('scroll-'))).toBe(
      false
    );
  });
});
