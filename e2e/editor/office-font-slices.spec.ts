import { expect, test } from '@playwright/test';
import { FILES_VIEW_ONLY } from '../helpers/filesViewOnly';
import { officeEditMenu, officeMenu } from '../helpers/office';
import { m } from '../i18n';

// Q752 B: a CJK font slice that fails while a DOCX is edited (offline) keeps
// the editor open with a notice, and the slice is asked for again once the
// browser is back online. Print and the list-card capture wait for every
// outline their page draws, so meanwhile Print fails through its usual toast
// and the capture's cycle ends with nothing to send.
test('a DOCX font slice failing offline is a notice, fails Print and the capture, and loads back online', async ({
  context,
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(240_000);
  // An outline chunk of a sliced CJK face, from any realm (page or worker).
  const chunk = /fonts-cjk\/assets\/[\w-]+\/c\d+\.zst/;
  const failed = new Set<string>();
  const loaded = new Set<string>();
  context.on('requestfailed', (request) => {
    if (chunk.test(request.url())) failed.add(request.url());
  });
  context.on('requestfinished', async (request) => {
    if (chunk.test(request.url()) && (await request.response())?.ok())
      loaded.add(request.url());
  });
  const captures: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/thumbnail'))
      captures.push(request.url());
  });
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  // Leaving uploads a capture already drawn, as the page hiding does.
  const hide = () =>
    page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({
    timeout: 30_000,
  });

  await context.setOffline(true);
  // A Traditional Chinese character exchange-plan.docx never draws: its
  // chunk of the document's face has not loaded.
  await frame.getByTestId('yrs-input').pressSequentially('齉');
  await expect(
    page.getByText(m.files_office_font_slice_unavailable())
  ).toBeVisible({ timeout: 30_000 });
  await expect(officeEditMenu(page)).toBeVisible();
  // Edit draws the host's error strip in the frame (`set-banner`).
  await expect(frame.getByText(m.error_file_body())).toHaveCount(0);

  await officeMenu(page, 'docx', 'File').click();
  await page.getByRole('menuitem', { exact: true, name: 'Print' }).click();
  await expect(page.getByText(m.files_office_print_failed())).toBeVisible({
    timeout: 60_000,
  });
  await expect(officeEditMenu(page)).toBeVisible();
  expect(failed.size).toBeGreaterThan(0);
  const missing = [...failed];
  // Page 1's capture, drawn 5 s after the key, failed the same way: its
  // cycle ends, so leaving has nothing to send.
  await expect
    .poll(
      () => warnings.some((text) => text.includes('Thumbnail capture failed')),
      { timeout: 30_000 }
    )
    .toBe(true);
  await hide();
  await page.waitForTimeout(1000);
  expect(captures).toEqual([]);

  // Back online, every chunk that failed loads.
  await context.setOffline(false);
  await expect
    .poll(() => missing.filter((url) => !loaded.has(url)), {
      timeout: 30_000,
    })
    .toEqual([]);
  // The next edit starts a new capture cycle, which draws and sends.
  await frame.getByTestId('yrs-input').pressSequentially('X');
  await expect
    .poll(
      async () => {
        await hide();
        return captures.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBe(1);
});

// A sliced CJK face's file (index, skeleton, core or chunk), from any realm.
const face = /fonts-cjk\/assets\/[\w-]+\/[\w.-]+$/;

// Q755 B, Q763 A: a CJK face first needed while a DOCX is edited whose index,
// skeleton or core cannot load (offline) is the same notice, its characters
// keeping the missing-glyph box, and the face opens once back online.
test('a DOCX CJK face failing to open while editing is the notice and opens back online', async ({
  context,
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(240_000);
  const failed = new Set<string>();
  const loaded = new Set<string>();
  context.on('requestfailed', (request) => {
    if (face.test(request.url())) failed.add(request.url());
  });
  context.on('requestfinished', async (request) => {
    if (face.test(request.url()) && (await request.response())?.ok())
      loaded.add(request.url());
  });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({
    timeout: 30_000,
  });

  await context.setOffline(true);
  // exchange-plan.docx has no Hangul: its Korean script fallback never opened.
  await frame.getByTestId('yrs-input').pressSequentially('한');
  await expect(
    page.getByText(m.files_office_font_slice_unavailable())
  ).toBeVisible({ timeout: 30_000 });
  await expect(officeEditMenu(page)).toBeVisible();
  await expect(frame.getByText(m.error_file_body())).toHaveCount(0);
  const missing = [...failed];
  expect(
    missing.some((url) => /\/(slices\.json|skeleton\.zst)$/.test(url))
  ).toBe(true);

  // Back online, the face opens: every file that failed loads.
  await context.setOffline(false);
  await expect
    .poll(() => missing.filter((url) => !loaded.has(url)), {
      timeout: 30_000,
    })
    .toEqual([]);
  await expect(officeEditMenu(page)).toBeVisible();
});

// The Q752 B scoping: a face that fails while the DOCX opens fails the open,
// View with the file error, Edit with the error strip it draws in its frame.
for (const mode of ['view', 'edit'] as const) {
  test(`a DOCX CJK face failing to load as the file opens in ${mode} shows the file error`, async ({
    context,
    page,
  }) => {
    // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
    test.skip(mode === 'edit', FILES_VIEW_ONLY);
    test.setTimeout(180_000);
    await context.route(face, (route) => route.abort());
    await page.goto(
      `/workspaces/ws_bio?file=bio-office-docx${mode === 'edit' ? '&mode=edit' : ''}`
    );
    const shown =
      mode === 'view'
        ? page
        : page.frameLocator('iframe[src*="office-runtime"]');
    await expect(shown.getByText(m.error_file_body())).toBeVisible({
      timeout: 120_000,
    });
  });
}

// Q781 A: the error of an Edit open that failed before the editor reported
// ready (a CJK face failing as the file opens) stays when the room reports
// Saved later: here the room drains after the failure and its tab rejoins,
// the save receipt held until the status has left Saved. Fails with every
// editing error cleared on Saved.
test('a DOCX CJK face failing as the file opens in edit keeps the error after the room saves again', async ({
  context,
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(180_000);
  await context.route(face, (route) => route.abort());
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  // The strip is drawn in the frame once its ribbon is up, by Capy before.
  const shown = async () =>
    (await page.getByText(m.error_file_body()).isVisible()) ||
    (await page
      .frameLocator('iframe[src*="office-runtime"]')
      .getByText(m.error_file_body())
      .isVisible());
  await expect.poll(shown, { timeout: 120_000 }).toBe(true);
  const room = (held: boolean) =>
    page.evaluate(async (hold) => {
      const path = '/src/mocks/collaboration.ts';
      const { drainSourceRooms, holdSourceSaveReceipts } = await import(path);
      holdSourceSaveReceipts(hold);
      if (hold) drainSourceRooms('bio-office-docx');
    }, held);
  const saved = page.locator('[data-save-state="saved"]');
  await room(true);
  await expect(saved).toHaveCount(0);
  await room(false);
  await expect(saved).toBeVisible({ timeout: 30_000 });
  // The strip goes after a render (in the frame, a message): give it a moment.
  await page.waitForTimeout(2000);
  expect(await shown()).toBe(true);
});
