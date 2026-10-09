import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { expectErrorSurface } from '../helpers/errors';
import { m } from '../i18n';

async function openWorkspace(page: Page) {
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 30_000 });
}

async function openFile(page: Page, name: string) {
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page.getByRole('link', { exact: true, name }).click();
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
    await error
      .getByRole('button', { exact: true, name: m.error_action_retry() })
      .click();
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
  const error = await expectErrorSurface(page, 'panel', 'sheet', 30_000);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('office-retry-stage', { detail: 1 }))
  );
  await error
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
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
  await error
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
  // The workbook opened: its sheet tabs and the drawn sheet.
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.getByRole('tab').first()).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('canvas').first()).toBeVisible();
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
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_stats_title() })
    .click();
  const error = await expectErrorSurface(page, 'panel', undefined, 30_000);
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  await expect(error).toBeVisible();
  // The error replaces the whole tab, as on Statistics.
  await expect(
    settings.getByRole('switch', { name: m.workspace_auto_process() })
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const { worker } = await import(browserPath);
    worker.resetHandlers();
  });
  await error
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
  await expect(error).toHaveCount(0);
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_stats_title() })
    .click();
  await expect(
    settings.getByText(m.stats_average_score(), { exact: true })
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
  const error = await expectErrorSurface(page, 'panel', 'text', 30_000);
  const retry = error.getByRole('button', {
    exact: true,
    name: m.error_action_retry(),
  });
  await expect(retry).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(retry.locator(':scope > svg')).toBeVisible();
});

test('User scenarios opens seeded material errors in the workspace and survives reload', async ({
  page,
}) => {
  await openWorkspace(page);
  const panel = page.getByTestId('mock-scenario-panel');
  for (const [label, id, message] of [
    ['Material load error', 'mock-material-load', m.error_file_title()],
    [
      'Unreadable material',
      'mock-material-unreadable',
      m.material_decode_title(),
    ],
    [
      'Broken diagram',
      'mock-material-diagram',
      m.mermaid_syntax_error({ line: 2 }),
    ],
  ]) {
    await panel.locator('summary').click();
    await panel.getByRole('button', { exact: true, name: label }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/ws_bio\\?material=${id}$`)
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(message, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }
  await page.reload();
  await expect(
    page.getByText(m.mermaid_syntax_error({ line: 2 }), { exact: true })
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
    hasText: m.pdf_annotations_failed(),
  });
  await expect(toast).toHaveCount(1, { timeout: 15_000 });
  await expect(canvas).toHaveCount(0);
  releasePdf!();
  await expect(canvas).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  await expect(
    page.getByRole('alert').filter({
      hasText: m.pdf_annotations_failed(),
    })
  ).toHaveCount(0);
  await page.getByRole('button', { name: m.material_mode() }).click();

  await expect(
    page.getByRole('button', { exact: true, name: m.pdf_draw() })
  ).toBeDisabled();
  await toast
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
  await expect(toast).toHaveCount(0);
  await expect(toast).toHaveCount(1, { timeout: 15_000 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event('annotations-retry-enable'))
  );
  await toast
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
  await expect(toast).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: m.pdf_draw() })
  ).toBeEnabled();
  expect(await originalCanvas?.evaluate((element) => element.isConnected)).toBe(
    true
  );
});
