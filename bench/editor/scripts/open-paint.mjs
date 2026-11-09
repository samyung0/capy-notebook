// How long a note takes to show and to turn editable, on a production build
// with MSW (see bench/README.md):
//
//   NODE_ENV=production VITE_USE_MSW=true VITE_LOAD_TEST_SEED=true \
//     VITE_CLERK_PUBLISHABLE_KEY= \
//     node --max-old-space-size=4096 node_modules/vite/bin/vite.js build \
//     --mode development --outDir /tmp/open-paint-dist
//   node node_modules/vite/bin/vite.js preview --mode development \
//     --outDir /tmp/open-paint-dist --port 4620 --strictPort &
//   OPEN_PAINT_URL=http://localhost:4620 node bench/editor/scripts/open-paint.mjs
//
// Per note and path, the median of OPEN_PAINT_RUNS (3): click or navigation to
// the note's text on screen (`paintMs`), to an editable editor showing it
// (`editableMs`), its token's answer to that (`tokenToEditableMs`), and the long
// tasks' blocking from the start to there. MSW adds about 1.1 s to every /api
// call, so the paint path's API waits are artificial on both sides of a compare.
// The reopen path needs a build of this branch: a device copy is written on
// hide and the note reloads from it.
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require('@playwright/test');

const BASE = process.env.OPEN_PAINT_URL ?? 'http://localhost:4620';
const RUNS = Number(process.env.OPEN_PAINT_RUNS ?? 3);
const SUFFIX = process.env.OPEN_PAINT_SEARCH ?? '';
const NOTES = {
  large: {
    gated: true,
    id: 'mat_note_bio_load_test',
    text: 'Load test — near 2MB feature soup',
  },
  small: {
    gated: false,
    id: 'mat_perf_small',
    text: 'Baseline note for typing latency.',
  },
};

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function instrument(page) {
  await page.addInitScript(() => {
    window.__open = { blocking: 0, token: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__open.blocking += Math.max(0, entry.duration - 50);
    }).observe({ buffered: true, type: 'longtask' });
    const { fetch: original } = window;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]?.url ?? args[0]).includes('collaboration-token'))
        window.__open.token ||= performance.now();
      return response;
    };
  });
}

async function open(page, note, { reload = false } = {}) {
  const url = `${BASE}/workspaces/ws_bio?material=${note.id}${SUFFIX}`;
  if (reload) await page.reload();
  else await page.goto(url);
  if (note.gated) {
    const go = page.getByTestId('heavy-material-open');
    await go.waitFor({ timeout: 90_000 });
    await page.evaluate(() => {
      window.__open.start = performance.now();
      window.__open.blocking = 0;
    });
    await go.click();
  } else
    await page.evaluate(() => {
      window.__open.start = 0;
    });
  await page
    .locator('[data-testid="material-preview"], [contenteditable="true"]')
    .getByText(note.text)
    .first()
    .waitFor({ state: 'visible', timeout: 120_000 });
  const painted = await page.evaluate(() => performance.now());
  await page
    .locator('[contenteditable="true"]')
    .getByText(note.text)
    .first()
    .waitFor({ state: 'visible', timeout: 180_000 });
  const editable = await page.evaluate(() => performance.now());
  const { blocking, start, token } = await page.evaluate(() => window.__open);
  return {
    blockingMs: Math.round(blocking),
    editableMs: Math.round(editable - start),
    paintMs: Math.round(painted - start),
    tokenToEditableMs: token ? Math.round(editable - Math.max(token, start)) : null,
  };
}

const browser = await chromium.launch();
const results = {};
for (const [name, note] of Object.entries(NOTES)) {
  const first = [];
  const reopen = [];
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await instrument(page);
    first.push(await open(page, note));
    // Hidden: this branch writes its device copy.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    reopen.push(await open(page, note, { reload: true }));
    await context.close();
  }
  const summary = (rows) =>
    Object.fromEntries(
      Object.keys(rows[0]).map((key) => [
        key,
        median(rows.map((row) => row[key] ?? 0)),
      ])
    );
  results[name] = { first: summary(first), reopen: summary(reopen) };
  console.log(name, JSON.stringify(results[name]));
}
await browser.close();
