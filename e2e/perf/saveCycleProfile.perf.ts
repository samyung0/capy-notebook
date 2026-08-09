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
 * Diagnostic companion to `editor.perf.ts`. Instead of asserting a budget it
 * takes a V8 sampling profile of each half of the save cycle and prints where
 * the time actually goes, so the 20s+ blocking frame can be attributed to
 * functions and to DOM churn rather than to "React".
 *
 * Opt-in, because it asserts nothing and costs ~2 minutes:
 *   $env:PERF_PROFILE=1; pnpm perf --grep "save cycle profile"
 */

/** Kept identical to `TYPING_TEXT` in editor.perf.ts. */
const PROBE_TEXT =
  'measuring editor latency with plain words that avoid every input rule trigger in the registry';

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

  // Phase 1: the keystrokes themselves. Same text and cadence as the budgeted
  // run, because the save that follows scales with the pending edit.
  await client.send('Profiler.start');
  await page.keyboard.type(` ${PROBE_TEXT}`, { delay: 40 });
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

  const report = [
    `document: ${blocks} rendered slate nodes, cpu x${CPU_RATE}, vite dev build`,
    '',
    profileSection(
      `PHASE 1 — typing ${PROBE_TEXT.length + 1} characters`,
      typingProfile.profile,
      typingDom
    ),
    profileSection(
      'PHASE 2 — checkpoint request + acknowledgement',
      ackProfile.profile,
      ackDom
    ),
    profileSection(
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
