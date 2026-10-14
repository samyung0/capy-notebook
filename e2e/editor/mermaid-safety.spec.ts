import { expect, test } from '@playwright/test';

// A diagram loads nothing from off-origin, whatever it references: an image in
// an HTML label, an image node, a CSS image function in style/classDef/
// linkStyle/themeCSS, or an init directive. The one shared renderer
// (`renderMermaid`) serves every surface, so this gallery covers them all.
// Security regression: track `mermaid` (diagrams load nothing from outside).

const REMOTE = 'https://mermaid-remote.test';

test('diagrams that reference an outside resource load nothing from it', async ({
  page,
  context,
}) => {
  const requested: string[] = [];
  await context.route(`${REMOTE}/**`, (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
      contentType: 'image/png',
    });
  });

  await page.goto('/e2e/fixtures/mermaid-safety.html');
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.mermaidDone), {
      timeout: 60_000,
    })
    .toBe('true');

  // Positive control: an off-origin image added now does reach the route, so
  // the route observes loads — the diagrams above simply make none.
  const control = page.waitForRequest(`${REMOTE}/control.png`);
  await page.evaluate((remote) => {
    const img = new Image();
    img.src = `${remote}/control.png`;
    document.body.append(img);
  }, REMOTE);
  await control;
  await page.waitForTimeout(500);

  expect(requested.filter((path) => path !== '/control.png')).toEqual([]);

  // Ordinary diagrams still draw their text.
  await expect(page.locator('[data-case="flowchart"] svg')).toContainText(
    'Choice'
  );
  await expect(page.locator('[data-case="sequence"] svg')).toContainText(
    'Alice'
  );
  await expect(page.locator('[data-case="class"] svg')).toContainText('Animal');
  await expect(page.locator('[data-case="mindmap"] svg')).toContainText(
    'Topic'
  );
  await expect(page.locator('[data-case="er"] svg')).toContainText('CUSTOMER');
  // A referencing diagram still renders, minus the dropped part.
  await expect(page.locator('[data-case="labelImage"] svg')).toContainText(
    'node'
  );
});
