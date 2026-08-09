import { expect, test } from '@playwright/test';
import { PERF_LARGE_NOTE, PERF_WORKSPACE_ID } from '../../src/mocks/perfSeed';
import {
  type CpuProfile,
  profileSection,
  readDomCounter,
  startDomCounter,
} from './cpuProfile';
import { CPU_RATE } from './metrics';

/**
 * Diagnostic companion to `editor.perf.ts`, for the one number that spec cannot
 * explain: ~1.1s of blocking per keystroke on the near-limit document. It
 * profiles an idle window and a typing window separately so that per-keystroke
 * work can be told apart from background churn (awareness, cursors, providers).
 *
 * Opt-in, because it asserts nothing:
 *   $env:PERF_PROFILE=1; pnpm perf --grep "typing profile"
 */

/** Plain words only, matching `TYPING_TEXT` in editor.perf.ts, but short: the
 * profile needs attribution, not a statistically clean average, and every
 * keystroke here costs about a second of throttled main thread. */
const PROBE_TEXT = 'membrane transport';

/**
 * Frames worth naming explicitly, whether or not they make the top-N lists.
 *
 * - Toc/getHeadingList: the TOC selector walks every node and returns a fresh
 *   array, so reference equality can never hold.
 * - ElementContent/PluginElementWithPath: the per-element render path. Large
 *   numbers here mean elements are re-rendering rather than bailing out of
 *   `MemoizedElement`.
 * - ChunkAncestor/reconcileChildren: slate-react's chunked child rendering.
 * - useDecorations/findPath: per-node work that scales with the document.
 * - BlockDraggable/BlockDiscussionContent: the two `render.aboveNodes` wrappers.
 */
const WATCH = [
  'BlockDiscussionContent',
  'BlockDraggable',
  'ChunkAncestor',
  'Element',
  'ElementContent',
  'FastIntrinsicElementBody',
  'PluginElementWithPath',
  'Paragraph',
  'Toc',
  'commentDecorationRangesForEntry',
  'findPath',
  'getHeadingList',
  'getRenderNodeProps',
  'pipeInjectNodeProps',
  'reconcileChildren',
  'remoteCursorRangesForEntry',
  'splitDecorationsByChild',
  'useChildren',
  'useContentObserver',
  'useDecorations',
  'useNodePath',
  'useTocElementState',
];

test(`typing profile — near-limit document (cpu x${CPU_RATE})`, async ({
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

  const document = await page.evaluate(() => ({
    headings: window.document.querySelectorAll(
      '[contenteditable="true"] h1,[contenteditable="true"] h2,[contenteditable="true"] h3,[contenteditable="true"] h4,[contenteditable="true"] h5,[contenteditable="true"] h6'
    ).length,
    slateNodes: window.document.querySelectorAll(
      '[contenteditable="true"] [data-slate-node]'
    ).length,
    topLevelBlocks:
      window.document.querySelector('[contenteditable="true"]')
        ?.childElementCount ?? 0,
  }));

  await editor.getByText(PERF_LARGE_NOTE.readyText).first().click();
  await page.keyboard.press('End');
  await startDomCounter(page);

  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  // Phase 1: no input at all. Anything expensive here is background churn and
  // would otherwise be misattributed to the keystrokes that follow.
  await client.send('Profiler.start');
  await page.waitForTimeout(6000);
  const idleProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const idleDom = await readDomCounter(page, true);

  // Phase 2: typing in the document's title, which is what `editor.perf.ts`
  // measures. It is also the worst case for the table of contents, because
  // every keystroke genuinely changes a heading.
  await client.send('Profiler.start');
  await page.keyboard.type(` ${PROBE_TEXT}`, { delay: 40 });
  const headingProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const headingDom = await readDomCounter(page, true);

  // Let the checkpoint the edit above scheduled land, so its acknowledgement
  // does not fall inside the next measurement window.
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await expect(saveState).toHaveText('Saved', { timeout: 300_000 });
  await page.waitForTimeout(5000);

  // Phase 3: typing in a body paragraph in the middle of the document, which
  // is what editing a document of this size actually looks like.
  const paragraph = editor.locator('p').filter({ hasText: 'Pad 100.' }).first();
  await paragraph.click();
  await page.keyboard.press('End');
  await readDomCounter(page, true);
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  await client.send('Profiler.start');
  await page.keyboard.type(` ${PROBE_TEXT}`, { delay: 40 });
  const bodyProfile = (await client.send('Profiler.stop')) as unknown as {
    profile: CpuProfile;
  };
  const bodyDom = await readDomCounter(page, true);

  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const keystrokes = PROBE_TEXT.length + 1;
  const report = [
    `document: ${document.slateNodes} rendered slate nodes, ${document.topLevelBlocks} top-level blocks, ${document.headings} headings`,
    `cpu x${CPU_RATE}, vite dev build, ${keystrokes} keystrokes per typing phase`,
    '',
    profileSection('PHASE 1 — idle (no input)', idleProfile.profile, idleDom, {
      watch: WATCH,
    }),
    profileSection(
      `PHASE 2 — typing ${keystrokes} characters into the title heading`,
      headingProfile.profile,
      headingDom,
      { watch: WATCH }
    ),
    profileSection(
      `PHASE 3 — typing ${keystrokes} characters into a body paragraph`,
      bodyProfile.profile,
      bodyDom,
      { watch: WATCH }
    ),
  ].join('\n');

  console.log(`\n${report}\n`);
  await testInfo.attach('typing-profile', {
    body: report,
    contentType: 'text/plain',
  });
});
