import { expect, test } from '@playwright/test';

// A diagram loads nothing from off-origin, whatever it references: an image in
// an HTML label, an image node, a CSS image function in style/classDef/
// linkStyle/themeCSS, or an init directive. The one shared renderer
// (`renderMermaid`) serves every surface, so this gallery covers them all.
// Links stay clickable but open in a new tab that cannot reach this one.
// Security regression: track `mermaid` (diagrams load nothing from outside).

const REMOTE = 'https://mermaid-remote.test';

test('diagrams that reference an outside resource load nothing from it', async ({
  page,
  context,
}) => {
  const requested: string[] = [];
  await context.route('https://offsite.test/**', (route) => {
    requested.push(route.request().url());
    return route.abort();
  });
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
  // Diagrams draw as they come near the screen: scroll down the gallery.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          window.scrollBy(0, 500);
          return document.body.dataset.mermaidDone;
        }),
      { timeout: 60_000 }
    )
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
  // A diagram link opens in a new tab with no opener or referrer, and a
  // script target is not kept.
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('[data-case="link"] a')].map((a) => ({
      href:
        a.getAttribute('href') ??
        a.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
        '',
      rel: a.getAttribute('rel') ?? '',
      target: a.getAttribute('target'),
    }))
  );
  expect(links.length).toBeGreaterThan(0);
  expect(links).toContainEqual(
    expect.objectContaining({ href: 'https://offsite.test/x' })
  );
  for (const link of links) {
    expect(link.target).toBe('_blank');
    expect(link.rel.split(/\s+/)).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer'])
    );
    expect(link.href).not.toMatch(/javascript:/i);
  }
});

// The worker's DOMPurify parses with linkedom, so the page sanitizes its SVG
// again with the browser's parser before inserting it (Epo 2026-10-22):
// a worker answering scripts, handlers, images and a script link gets none
// of them into the page, and its links still open in a new tab.
// Security regression: fails with forPage's DOMPurify pass (Mermaid.tsx)
// removed.
test("the page sanitizes the worker's SVG before inserting it", async ({
  page,
  context,
}) => {
  const requested: string[] = [];
  await context.route(`${REMOTE}/**`, (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.goto('/e2e/fixtures/mermaid-safety.html?worker=hostile');
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.mermaidDone), {
      timeout: 60_000,
    })
    .toBe('true');
  const box = page.locator('[data-case="hostile"]');
  await expect(box.locator('svg')).toContainText('hostile');
  await page.waitForTimeout(500);
  const found = await box.evaluate((element) => ({
    handlers: [...element.querySelectorAll('*')].flatMap((node) =>
      [...node.attributes]
        .map((attribute) => attribute.name)
        .filter((name) => name.startsWith('on'))
    ),
    links: [...element.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href') ?? '',
      rel: a.getAttribute('rel') ?? '',
      target: a.getAttribute('target'),
    })),
    loaders: element.querySelectorAll('script, img, image').length,
    pwned: 'pwned' in window,
  }));
  expect(found.handlers).toEqual([]);
  expect(found.loaders).toBe(0);
  expect(found.pwned).toBe(false);
  expect(requested).toEqual([]);
  for (const link of found.links) {
    expect(link.href).not.toMatch(/javascript:/i);
    expect(link.target).toBe('_blank');
    expect(link.rel.split(/\s+/)).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer'])
    );
  }
  expect(found.links).toContainEqual(
    expect.objectContaining({ href: 'https://offsite.test/hostile' })
  );
});
