import { describe, expect, it } from 'vitest';
import {
  compareSnapshots,
  type PerfSnapshot,
  RELATIVE_METRICS,
} from './snapshot';

function snapshot({
  commit,
  cpuModel = 'AMD EPYC',
  openMs = 1000,
  typingBlockingMs = 100,
  saveCycleBlockingMs = 200,
}: {
  commit: string;
  cpuModel?: string;
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
    createdAt: '2026-08-24T12:00:00.000Z',
  };
}

describe('performance snapshot comparison', () => {
  it('reports a first run without a baseline', () => {
    const result = compareSnapshots(snapshot({ commit: 'current' }), null);

    expect(result.markdown).toContain('First run');
    expect(result.markdown).toContain('1,000');
    expect(result.rows).toHaveLength(3);
  });

  it('shows a worse typing delta without creating a failure state', () => {
    const baseline = snapshot({
      commit: 'baseline',
      typingBlockingMs: 100,
    });
    const current = snapshot({
      commit: 'current',
      typingBlockingMs: 125,
    });

    const result = compareSnapshots(current, baseline);
    const typing = result.rows.find(
      (row) => row.path.join('.') === 'typing.blockingPerKeystrokeMs'
    );

    expect(typing).toMatchObject({
      absoluteDelta: 25,
      baseline: 100,
      current: 125,
      percentDelta: 25,
    });
    expect(result.markdown).toContain('+25 ms (+25.0%)');
    expect(result.markdown).toContain('warn-only');
  });

  it('warns when the runner CPU model changes', () => {
    const baseline = snapshot({ commit: 'baseline', cpuModel: 'AMD EPYC' });
    const current = snapshot({ commit: 'current', cpuModel: 'Intel Xeon' });

    expect(compareSnapshots(current, baseline).markdown).toContain(
      'CPU model changed'
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
