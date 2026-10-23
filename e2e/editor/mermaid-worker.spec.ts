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

// Review r2 H1: the worker's type check reads mermaid's site config, so a
// diagram whose directive picks the unsupported renderer-v1 flowchart leaves
// the next flowcharts drawing (it used to refuse every one after it).
test("a diagram's renderer directive does not reach the next diagram", async ({
  page,
}) => {
  await openFixture(page);
  expect(
    await outcome(
      page,
      '%%{init: {"flowchart": {"defaultRenderer": "dagre-d3"}}}%%\ngraph LR\n  A --> B'
    )
  ).toBe('unsupported');
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
