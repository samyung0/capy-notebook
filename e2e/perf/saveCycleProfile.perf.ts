import { expect, type Page, test } from '@playwright/test';
import { PERF_LARGE_NOTE, PERF_WORKSPACE_ID } from '../../src/mocks/perfSeed';
import { CPU_RATE } from './metrics';

/**
 * Diagnostic companion to `editor.perf.ts`. Instead of asserting a budget it
 * takes a V8 sampling profile of each half of the save cycle and prints where
 * the time actually goes, so the 20s+ blocking frame can be attributed to
 * functions and to DOM churn rather than to "React".
 *
 * Opt-in, because it asserts nothing and costs ~2 minutes:
 *   $env:PERF_PROFILE=1; pnpm perf --grep "save cycle profile"
 */

interface CallFrame {
  functionName: string;
  url: string;
}
interface ProfileNode {
  callFrame: CallFrame;
  children?: number[];
  id: number;
}
interface CpuProfile {
  endTime: number;
  nodes: ProfileNode[];
  samples: number[];
  startTime: number;
  timeDeltas: number[];
}

function shortUrl(url: string) {
  if (!url) return '';
  return url
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace('/node_modules/.vite/deps/', 'dep:');
}

function label(frame: CallFrame) {
  return `${frame.functionName || '(anonymous)'}  ${shortUrl(frame.url)}`;
}

function analyze(profile: CpuProfile) {
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
  };
}

/** Counts DOM nodes added/removed under the editable, to distinguish a React
 * re-render that reuses the DOM from one that tears it down and rebuilds it. */
async function startDomCounter(page: Page) {
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

async function readDomCounter(page: Page, reset: boolean) {
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

test(`save cycle profile — near-limit document (cpu x${CPU_RATE})`, async ({
  page,
}, testInfo) => {
  // biome-ignore lint/suspicious/noSkippedTests: diagnostic probe, asserts nothing.
  test.skip(
    !process.env.PERF_PROFILE,
    'diagnostic only; set PERF_PROFILE=1 to run'
  );
  test.setTimeout(900_000);
  const client = await page.context().newCDPSession(page);
  const saveState = page.getByTestId('editor-save-state');

  await page.goto(
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(PERF_LARGE_NOTE.id)}`
  );
  await expect(page.getByTestId('heavy-material-open')).toBeVisible({
    timeout: 120_000,
  });
  await page.getByTestId('heavy-material-open').click();

  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 120_000 });
  await expect(editor.getByText(PERF_LARGE_NOTE.readyText).first()).toBeVisible(
    { timeout: 120_000 }
  );
  await expect(saveState).toHaveText(/Synced|Saved/, { timeout: 120_000 });
  await page.waitForTimeout(2500);

  const blocks = await page.evaluate(
    () =>
      document.querySelectorAll('[contenteditable="true"] [data-slate-node]')
        .length
  );

  await editor.getByText(PERF_LARGE_NOTE.readyText).first().click();
  await page.keyboard.press('End');
  await startDomCounter(page);

  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  // Phase 1: the keystrokes themselves.
  await client.send('Profiler.start');
  await page.keyboard.type(' probe', { delay: 40 });
  const typingProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const typingDom = await readDomCounter(page, true);

  // Phase 2: debounce expiry -> checkpoint request -> the mock provider's
  // synchronous acknowledgement -> the React work that acknowledgement causes.
  await client.send('Profiler.start');
  await expect(saveState).toHaveText('Saved', { timeout: 300_000 });
  const ackProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const ackDom = await readDomCounter(page, true);

  // Phase 3: the projection refetch the acknowledgement invalidated, and the
  // render its response causes.
  await client.send('Profiler.start');
  await page.waitForTimeout(20_000);
  const projectionProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const projectionDom = await readDomCounter(page, false);

  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const section = (
    name: string,
    profile: CpuProfile,
    dom: Record<string, number>
  ) => {
    const stats = analyze(profile);
    return [
      `######## ${name}`,
      `wall ${stats.wallMs}ms · busy ${stats.busyMs}ms · dom +${dom.added}/-${dom.removed} nodes, ${dom.attrs} attr writes`,
      '-- app components (inclusive) --',
      ...stats.appTotals,
      '-- top self time --',
      ...stats.self,
      '-- top inclusive time --',
      ...stats.total,
      '',
    ].join('\n');
  };

  const report = [
    `document: ${blocks} rendered slate nodes, cpu x${CPU_RATE}, vite dev build`,
    '',
    section('PHASE 1 — typing 6 characters', typingProfile.profile, typingDom),
    section(
      'PHASE 2 — checkpoint request + acknowledgement',
      ackProfile.profile,
      ackDom
    ),
    section(
      'PHASE 3 — projection refetch + its render',
      projectionProfile.profile,
      projectionDom
    ),
  ].join('\n');

  console.log(`\n${report}\n`);
  await testInfo.attach('save-cycle-profile', {
    body: report,
    contentType: 'text/plain',
  });
});
