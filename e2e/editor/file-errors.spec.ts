import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { expectErrorSurface } from '../helpers/errors';

async function openWorkspace(page: Page) {
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 30_000 });
}

async function openFile(page: Page, name: string) {
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  await page.getByRole('button', { exact: true, name }).click();
}

for (const kind of ['text', 'csv', 'image'] as const) {
  test(`${kind} preview retries the same signed URL and recovers`, async ({
    page,
    baseURL,
  }) => {
    const url = `${baseURL}/__preview-retry/${kind}`;
    await openWorkspace(page);
    await page.evaluate(
      async ({ kind, url }) => {
        const browserPath = '/src/mocks/browser.ts';
        const mswPath = '/node_modules/msw/lib/core/index.mjs';
        const { worker } = await import(browserPath);
        const { http, HttpResponse } = await import(mswPath);
        let ready = false;
        window.addEventListener('preview-retry-enable', () => {
          ready = true;
        });
        worker.use(
          http.get(url, () => {
            performance.mark('preview-download');
            if (!ready) return new HttpResponse(null, { status: 503 });
            return new HttpResponse(
              kind === 'image'
                ? '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>'
                : 'Recovered preview',
              {
                headers: {
                  'Content-Type':
                    kind === 'image' ? 'image/svg+xml' : 'text/plain',
                },
              }
            );
          }),
          http.get(`/api/files/mock-preview-${kind}/links`, () => {
            performance.mark('preview-links');
            return HttpResponse.json({ url });
          })
        );
      },
      { kind, url }
    );
    await openFile(
      page,
      kind === 'text'
        ? 'Edit source error.txt'
        : `Broken preview.${kind === 'image' ? 'png' : 'csv'}`
    );
    const error = await expectErrorSurface(page, 'panel', undefined, 30_000);
    await page.evaluate(() =>
      window.dispatchEvent(new Event('preview-retry-enable'))
    );
    await error.getByRole('button', { exact: true, name: 'Retry' }).click();
    await expect(error).toHaveCount(0);
    if (kind === 'image') {
      await expect(
        page.getByRole('img', { exact: true, name: 'Broken preview.png' })
      ).toBeVisible();
    } else {
      await expect(
        page.getByText('Recovered preview', { exact: true })
      ).toBeVisible();
    }
    expect(
      await page.evaluate(
        () => performance.getEntriesByName('preview-download').length
      )
    ).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(
        () => performance.getEntriesByName('preview-links').length
      )
    ).toBe(2);
  });
}

test('Office retry recovers from both session and parser failures', async ({
  page,
  baseURL,
}) => {
  const url = `${baseURL}/__preview-retry/workbook`;
  await openWorkspace(page);
  await page.evaluate(
    async ({ url, workbook }) => {
      const browserPath = '/src/mocks/browser.ts';
      const mswPath = '/node_modules/msw/lib/core/index.mjs';
      const { worker } = await import(browserPath);
      const { http, HttpResponse } = await import(mswPath);
      let stage = 0;
      window.addEventListener('office-retry-stage', (event) => {
        stage = (event as CustomEvent<number>).detail;
      });
      worker.use(
        http.get(url, () => {
          performance.mark('office-download');
          return new HttpResponse(
            stage === 1 ? 'Invalid workbook bytes' : new Uint8Array(workbook)
          );
        }),
        http.get('/api/files/mock-preview-xlsx/source-session', () =>
          stage === 0
            ? HttpResponse.json(
                { detail: 'Session unavailable' },
                { status: 503 }
              )
            : HttpResponse.json({
                checkpoint: 0,
                indexedCheckpoint: 0,
                sourceURL: url,
              })
        )
      );
    },
    { url, workbook: [...readFileSync('e2e/fixtures/files/basic/grades.xlsx')] }
  );
  await openFile(page, 'Office session error.xlsx');
  const error = await expectErrorSurface(
    page,
    'panel',
    'Failed to load spreadsheet',
    30_000
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('office-retry-stage', { detail: 1 }))
  );
  await error.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => performance.getEntriesByName('office-download').length
      )
    )
    .toBe(1);
  await expect(error).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('office-retry-stage', { detail: 2 }))
  );
  await error.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(page.getByText(/^\d+ sheets$/)).toBeVisible({ timeout: 30_000 });
  await expect(error).toHaveCount(0);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName('office-download').length
    )
  ).toBe(2);
});

test('workspace statistics and indexing share a recoverable panel error', async ({
  page,
}) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const { worker } = await import(browserPath);
    const { http, HttpResponse } = await import(mswPath);
    worker.use(
      http.get('/api/workspaces/ws_bio/stats', () =>
        HttpResponse.json({ detail: 'Statistics unavailable' }, { status: 503 })
      )
    );
  });
  await page
    .getByRole('button', { exact: true, name: 'Workspace settings' })
    .click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings
    .getByRole('button', { exact: true, name: 'Statistics' })
    .click();
  const error = await expectErrorSurface(page, 'panel', undefined, 30_000);
  await settings.getByRole('button', { exact: true, name: 'Indexing' }).click();
  await expect(error).toBeVisible();
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const { worker } = await import(browserPath);
    worker.resetHandlers();
  });
  await error.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(error).toHaveCount(0);
  await settings
    .getByRole('button', { exact: true, name: 'Statistics' })
    .click();
  await expect(
    settings.getByText('Average score', { exact: true })
  ).toBeVisible();
});

test('User scenarios opens errors in the actual workspace', async ({
  page,
}) => {
  await openWorkspace(page);
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click();
  await panel
    .getByRole('button', { exact: true, name: 'Broken preview.txt' })
    .click();
  await expect(page).toHaveURL(
    /\/workspaces\/ws_bio\?file=mock-preview-text-load$/
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const error = await expectErrorSurface(
    page,
    'panel',
    "Couldn't load this file.",
    30_000
  );
  const retry = error.getByRole('button', { exact: true, name: 'Retry' });
  await expect(retry).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(retry.locator(':scope > svg')).toBeVisible();
});

test('User scenarios opens seeded material errors in the workspace and survives reload', async ({
  page,
}) => {
  await openWorkspace(page);
  const panel = page.getByTestId('mock-scenario-panel');
  for (const [label, id, message] of [
    ['Material load error', 'mock-material-load', 'Something went wrong'],
    [
      'Unreadable material',
      'mock-material-unreadable',
      'This note could not be loaded',
    ],
    ['Broken diagram', 'mock-material-diagram', 'Failed to render diagram'],
  ]) {
    await panel.locator('summary').click();
    await panel.getByRole('button', { exact: true, name: label }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/ws_bio\\?material=${id}$`)
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByText(message, { exact: id !== 'mock-material-diagram' })
    ).toBeVisible({ timeout: 30_000 });
  }
  await page.reload();
  await expect(
    page.getByText('Failed to render diagram', { exact: false })
  ).toBeVisible({ timeout: 30_000 });
});

test('PDF annotation load toast retries failures and recovers without reloading the PDF', async ({
  page,
  context,
}) => {
  let releasePdf: () => void;
  const pdfReady = new Promise<void>((resolve) => {
    releasePdf = resolve;
  });
  await context.route(
    'https://raw.githubusercontent.com/mozilla/pdf.js/**',
    async (route) => {
      await pdfReady;
      await route.fulfill({
        contentType: 'application/pdf',
        headers: { 'access-control-allow-origin': '*' },
        path: 'e2e/fixtures/files/basic/digital.pdf',
      });
    }
  );
  await openWorkspace(page);
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click();
  await panel
    .getByRole('button', { exact: true, name: 'Annotation load error.pdf' })
    .click();
  await expect(panel).toHaveAttribute('data-scenario-status', 'ready');
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const { worker } = await import(browserPath);
    const { http, HttpResponse } = await import(mswPath);
    let ready = false;
    window.addEventListener('annotations-retry-enable', () => {
      ready = true;
    });
    worker.use(
      http.get('/api/files/mock-preview-annotations/annotations', () =>
        ready ? HttpResponse.json([]) : new HttpResponse(null, { status: 503 })
      )
    );
  });
  const canvas = page.locator('[data-page="1"] canvas');
  const toast = page.locator('[data-sonner-toast]').filter({
    hasText: 'Private annotations could not be loaded.',
  });
  await expect(toast).toHaveCount(1, { timeout: 15_000 });
  await expect(canvas).toHaveCount(0);
  releasePdf!();
  await expect(canvas).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Private annotations could not be loaded.',
    })
  ).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Material mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Edit' }).click();
  await expect(
    page.getByRole('button', { exact: true, name: 'Draw' })
  ).toBeDisabled();
  await toast.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(toast).toHaveCount(0);
  await expect(toast).toHaveCount(1, { timeout: 15_000 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event('annotations-retry-enable'))
  );
  await toast.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(toast).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: 'Draw' })
  ).toBeEnabled();
  expect(await originalCanvas?.evaluate((element) => element.isConnected)).toBe(
    true
  );
});
