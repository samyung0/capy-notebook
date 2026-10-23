import { expect, type Page, test } from '@playwright/test';

// The Mermaid worker's life on the geometry fixture page
// (e2e/fixtures/mermaid-geometry.tsx): what it makes of one diagram after
// another, and of a download that fails. Chromium only: the worker's requests
// go through the page's network there, so a route can fail one.

/** What the worker makes of `code`: the type it drew, or why it did not. */
async function outcome(page: Page, code: string) {
  return await page.evaluate(
    (source) =>
      (
        window as unknown as {
          mermaidOutcome: (code: string) => Promise<string>;
        }
      ).mermaidOutcome(source),
    code
  );
}

async function openFixture(page: Page) {
  await page.goto('/e2e/fixtures/mermaid-geometry.html');
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.ready), {
      timeout: 60_000,
    })
    .toBe('true');
}

// Review r2 H1, r3 M1: no diagram's directive reaches the next one, by the
// worker's type check or by the image check (`details` sends a source
// through mermaid's own type detection before it draws), so a diagram whose
// directive picks the unsupported renderer-v1 flowchart leaves the next
// flowcharts drawing.
test("a diagram's renderer directive does not reach the next diagram", async ({
  page,
}) => {
  await openFixture(page);
  const dagre =
    '%%{init: {"flowchart": {"defaultRenderer": "dagre-d3"}}}%%\ngraph LR\n';
  expect(await outcome(page, `${dagre}  A --> B`)).toBe('unsupported');
  expect(await outcome(page, 'flowchart TD\n  A[Order details 2] --> B')).toBe(
    'flowchart-v2'
  );
  expect(await outcome(page, `${dagre}  C --> D`)).toBe('unsupported');
  expect(await outcome(page, 'graph TD\n  X --> Y')).toBe('flowchart-v2');
  expect(await outcome(page, 'flowchart TD\n  X --> Y')).toBe('flowchart-v2');
});

// Epo 2026-10-23 (review r2 M2): a diagram type's chunk that fails to
// download says "Diagrams couldn't load." and is not kept, so the next view
// draws it.
test('a diagram whose download fails draws the next time', async ({
  context,
  page,
}) => {
  await openFixture(page);
  const source = 'sankey-beta\nReading,Notes,5\nNotes,Quiz,3';
  await context.route('**/sankeyDiagram-*', (route) => route.abort());
  expect(await outcome(page, source)).toBe('notLoaded');
  await context.unroute('**/sankeyDiagram-*');
  expect(await outcome(page, source)).toBe('sankey');
});

// Review r3 L1: a failed download is told apart by where it happens, never
// by an error's message, which can echo the source: a source that reads like
// a failed import is a source error, and it is kept.
test('a source that reads like a failed download is a source error', async ({
  page,
}) => {
  await openFixture(page);
  expect(
    await outcome(page, 'Failed to fetch dynamically imported module')
  ).toBe('error');
});
