import type { Page } from '@playwright/test';

/**
 * Shared V8 sampling-profile capture and attribution for the diagnostic perf
 * specs. These specs assert nothing; they exist to answer "which function" when
 * a budget in `editor.perf.ts` trips or when a number looks wrong.
 */

export interface CallFrame {
  functionName: string;
  url: string;
}

export interface ProfileNode {
  callFrame: CallFrame;
  children?: number[];
  id: number;
}

export interface CpuProfile {
  endTime: number;
  nodes: ProfileNode[];
  samples: number[];
  startTime: number;
  timeDeltas: number[];
}

export function shortUrl(url: string) {
  if (!url) return '';
  return url
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace('/node_modules/.vite/deps/', 'dep:');
}

export function label(frame: CallFrame) {
  return `${frame.functionName || '(anonymous)'}  ${shortUrl(frame.url)}`;
}

interface AnalyzeOptions {
  /**
   * Function names to report explicitly. A sampling profiler only names what it
   * happened to catch on the stack, so a top-N list silently omits a suspect
   * that is merely expensive rather than dominant; naming it keeps a zero
   * visible and therefore falsifiable.
   */
  watch?: string[];
}

export function analyze(
  profile: CpuProfile,
  { watch = [] }: AnalyzeOptions = {}
) {
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) byId.set(node.id, node);
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }

  const selfByLabel = new Map<string, number>();
  const totalByLabel = new Map<string, number>();
  let sampled = 0;

  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    sampled += ms;
    const node = byId.get(id);
    if (!node) continue;
    const key = label(node.callFrame);
    selfByLabel.set(key, (selfByLabel.get(key) ?? 0) + ms);

    const seen = new Set<string>();
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      const current = byId.get(cursor);
      if (current) {
        const ancestor = label(current.callFrame);
        if (!seen.has(ancestor)) {
          seen.add(ancestor);
          totalByLabel.set(ancestor, (totalByLabel.get(ancestor) ?? 0) + ms);
        }
      }
      cursor = parent.get(cursor);
    }
  }

  const format = (map: Map<string, number>, count: number, min = 0) =>
    [...map.entries()]
      .filter(([, ms]) => ms >= min)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(
        ([name, ms]) => `${Math.round(ms).toString().padStart(7)}ms  ${name}`
      );

  const sumMatching = (map: Map<string, number>, name: string) => {
    let total = 0;
    for (const [key, ms] of map) {
      if (key.split('  ')[0] === name) total += ms;
    }
    return total;
  };

  return {
    appTotals: format(
      new Map([...totalByLabel].filter(([n]) => n.includes('/src/'))),
      20
    ),
    busyMs: Math.round(
      sampled -
        (selfByLabel.get('(idle)  ') ?? 0) -
        (selfByLabel.get('(program)  ') ?? 0)
    ),
    self: format(selfByLabel, 22),
    total: format(totalByLabel, 26),
    wallMs: Math.round((profile.endTime - profile.startTime) / 1000),
    watch: watch
      .map((name) => ({
        name,
        selfMs: sumMatching(selfByLabel, name),
        totalMs: sumMatching(totalByLabel, name),
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .map(
        ({ name, selfMs, totalMs }) =>
          `${Math.round(totalMs).toString().padStart(7)}ms incl ${Math.round(
            selfMs
          )
            .toString()
            .padStart(6)}ms self  ${name}`
      ),
  };
}

/** Counts DOM nodes added/removed under the editable, to distinguish a React
 * re-render that reuses the DOM from one that tears it down and rebuilds it. */
export async function startDomCounter(page: Page) {
  await page.evaluate(() => {
    const target = document.querySelector('[contenteditable="true"]');
    if (!target) throw new Error('no editable');
    const counters = { added: 0, attrs: 0, records: 0, removed: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        counters.records += 1;
        if (record.type === 'attributes') counters.attrs += 1;
        counters.added += record.addedNodes.length;
        counters.removed += record.removedNodes.length;
      }
    });
    observer.observe(target, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    (window as unknown as { __dom: unknown }).__dom = { counters, observer };
  });
}

export async function readDomCounter(page: Page, reset: boolean) {
  return page.evaluate((shouldReset) => {
    const state = (
      window as unknown as {
        __dom: {
          counters: {
            added: number;
            removed: number;
            records: number;
            attrs: number;
          };
        };
      }
    ).__dom;
    const snapshot = { ...state.counters };
    if (shouldReset) {
      state.counters.added = 0;
      state.counters.removed = 0;
      state.counters.records = 0;
      state.counters.attrs = 0;
    }
    return snapshot;
  }, reset);
}

export function profileSection(
  name: string,
  profile: CpuProfile,
  dom: Record<string, number>,
  options: AnalyzeOptions = {}
) {
  const stats = analyze(profile, options);
  const watch = stats.watch.length
    ? ['-- watched frames (inclusive / self) --', ...stats.watch]
    : [];
  return [
    `######## ${name}`,
    `wall ${stats.wallMs}ms · busy ${stats.busyMs}ms · dom +${dom.added}/-${dom.removed} nodes, ${dom.attrs} attr writes`,
    ...watch,
    '-- app components (inclusive) --',
    ...stats.appTotals,
    '-- top self time --',
    ...stats.self,
    '-- top inclusive time --',
    ...stats.total,
    '',
  ].join('\n');
}
