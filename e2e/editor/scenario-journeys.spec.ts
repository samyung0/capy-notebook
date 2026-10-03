import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { officeEditMenu, saveOffice } from '../helpers/office';

const marker = 'My unsaved scenario edit.';
const savedMarker = 'My saved scenario edit.';
async function launch(page: Page, id: string) {
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.evaluate((node: HTMLDetailsElement) => {
    node.open = true;
  });
  await panel.locator(`[data-scenario="${id}"]`).click();
  await expect(panel).toHaveAttribute('data-scenario-status', 'ready', {
    timeout: 40_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/workspaces/ws_bio');
  await expect(page.getByTestId('mock-scenario-panel')).toBeVisible({
    timeout: 30_000,
  });
});

test('one click fails a real source save and retry preserves the mounted editor', async ({
  page,
}) => {
  await launch(page, 'source-save-failed');
  const current = await page
    .locator('textarea')
    .evaluateAll((nodes) =>
      nodes
        .find((node) => node.value.includes('My unsaved scenario edit.'))
        ?.getAttribute('aria-label')
    );
  expect(current).toBeTruthy();
  const input = page.getByRole('textbox', { exact: true, name: current! });
  await expect(input).toHaveValue(new RegExp(marker));
  // A failed save toasts and marks the header; the editor keeps its edits.
  await expect(page.locator('[data-sonner-toast]')).toContainText(
    'Failed to save'
  );
  await expect(page.getByTestId('editor-save-state')).toHaveText(
    'Not saved. Retrying…'
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const mounted = await input.elementHandle();
  const currentURL = page.url();
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-pdf"]')
    .click();
  await expect(page).toHaveURL(currentURL);
  await expect(input).toHaveValue(new RegExp(marker));
  await page.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(page.getByTestId('editor-save-state')).toHaveText('Saved');
  await expect(input).toHaveValue(new RegExp(marker));
  expect(await mounted!.evaluate((node) => node.isConnected)).toBe(true);
  await launch(page, 'source-save-failed');
  await expect(input).toHaveValue(
    new RegExp(`^[\\s\\S]*${marker.replaceAll('.', '\\.')}\\s*$`)
  );
  expect((await input.inputValue()).split(marker)).toHaveLength(2);
});

for (const id of ['source-replaced', 'source-draft-recovery']) {
  test(`${id} downloads, persists across reload, and discards through the app`, async ({
    page,
  }) => {
    await launch(page, id);
    const draft = page.locator('textarea[readonly]');
    await expect(draft).toHaveValue(new RegExp(marker));
    const downloadReady = page.waitForEvent('download');
    await page
      .getByRole('button', { exact: true, name: 'Download draft' })
      .click();
    const download = await downloadReady;
    expect(await readFile((await download.path())!, 'utf8')).toContain(marker);
    await expect(page).toHaveURL(/mode=edit/);
    await page.reload();
    // A full dev-server reload takes about 5 s before the mode button renders.
    await expect(
      page.getByRole('button', { name: 'Material mode' })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });

    await expect(draft).toHaveValue(new RegExp(marker), { timeout: 30_000 });
    await expect(page.getByTestId('mock-scenario-panel')).toHaveAttribute(
      'data-scenario-status',
      'idle'
    );
    await page
      .getByRole('button', { exact: true, name: 'Discard this draft' })
      .click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.locator('textarea[aria-label]').filter({ visible: true }).first()
    ).not.toHaveValue(new RegExp(marker));
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const modulePath = '/src/features/files/sourceDraft.ts';
          const dbPath = '/src/mocks/db.ts';
          const { readSourceDrafts } = await import(modulePath);
          const { user } = await import(dbPath);
          return (await readSourceDrafts(`${user.id}:mock-scenario-text`))
            .length;
        })
      )
      .toBe(0);
  });
}

for (const format of ['docx', 'xlsx', 'pptx']) {
  test(`${format} opens valid bytes, edits, fails save, and retries without replacing the iframe`, async ({
    page,
  }) => {
    // Native initialization and a full Vite reload share this workflow budget.
    test.setTimeout(120_000);
    await launch(page, `office-${format}-save`);
    const frame = page.locator('iframe[src*="office-runtime"]');
    const mounted = await frame.elementHandle();
    await expect(page.locator('[data-sonner-toast]')).toContainText(
      'Failed to save'
    );
    await expect(page.getByTestId('editor-save-state')).toHaveText(
      'Not saved. Retrying…'
    );
    await saveOffice(page);
    await expect(page.getByTestId('editor-save-state')).toHaveText('Saved');
    expect(await mounted!.evaluate((node) => node.isConnected)).toBe(true);
    const mode = page.getByRole('button', { name: 'Material mode' });
    await expect(page).toHaveURL(/mode=edit/);
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/mode=view/);
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/mode=edit/);
    await page.reload();
    await expect(mode).toHaveAttribute('aria-pressed', 'true', {
      timeout: 30_000,
    });
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });

    const panel = page.getByTestId('mock-scenario-panel');
    await panel.evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
    await panel.getByRole('button', { exact: true, name: 'Reset' }).click();
    await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
    await expect(frame).toHaveCount(0);
  });
}

test('permission loss follows the note page guard', async ({ page }) => {
  await launch(page, 'note-permission-lost');
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    page.getByText('A note for trying application errors.', { exact: true })
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  // A full dev-server reload takes about 5 s before the note renders.
  await expect(
    page.getByText('A note for trying application errors.', { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
});

test('page retry and form retry remain usable after the one-click fault retires', async ({
  page,
}) => {
  await launch(page, 'file-list-network');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(
    page.getByRole('heading', { exact: true, name: 'Files' })
  ).toBeVisible();
  await launch(page, 'file-save');
  const rename = page.getByRole('dialog', { exact: true, name: 'Rename' });
  await expect(rename).toBeVisible();
  await expect(rename.locator('input')).toHaveValue('Renamed scenario item');
  await rename.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole('heading', { exact: true, name: 'Renamed scenario item' })
  ).toBeVisible();
  await launch(page, 'import-inspect');
  await expect(
    page.getByRole('dialog', { exact: true, name: 'Add file' })
  ).toBeVisible();
  await expect(page.locator('[data-sonner-toast]')).toContainText('Import');
});

test('a new scenario cancels a pending auth request', async ({ page }) => {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/__mock/auth/sign-in'))
        init?.signal?.addEventListener('abort', () =>
          performance.mark('scenario-auth-aborted')
        );
      return fetch(input, init);
    };
  });
  await launch(page, 'auth-busy');
  await launch(page, 'workspace-500');
  expect(
    await page.evaluate(
      () => performance.getEntriesByName('scenario-auth-aborted').length
    )
  ).toBe(1);
  await expect(page).toHaveURL(/\/workspaces\/ws_scenarios$/);
});

test('Office export failure retains the editable iframe and draft download works', async ({
  page,
}) => {
  await launch(page, 'office-runtime-error');
  const frame = page.locator('iframe[src*="office-runtime"]');
  const mounted = await frame.elementHandle();
  // The iframe's own error text never renders; the host shows its copy.
  await expect(page.getByRole('alert')).toContainText(
    'Changes could not be saved. Your draft is still here.'
  );
  const downloadReady = page.waitForEvent('download');
  await page
    .getByRole('button', { exact: true, name: 'Download draft' })
    .click();
  const download = await downloadReady;
  expect(
    (await readFile((await download.path())!)).subarray(0, 2).toString()
  ).toBe('PK');
  expect(await mounted!.evaluate((node) => node.isConnected)).toBe(true);
});

test('permanent account state survives reload until Reset without replaying the journey', async ({
  page,
}) => {
  await launch(page, 'account-suspended');
  const blocked = page.getByRole('heading', {
    exact: true,
    name: 'Account suspended',
  });
  await expect(blocked).toBeVisible();
  await page.reload();
  await expect(blocked).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/me')).status)).toBe(
    403
  );
  const panel = page.getByTestId('mock-scenario-panel');
  await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
  await panel.evaluate((node: HTMLDetailsElement) => {
    node.open = true;
  });
  await panel.getByRole('button', { exact: true, name: 'Reset' }).click();
  await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
  await expect(blocked).toHaveCount(0);
});

test('storage status: amber near the limit, full view-only and frozen read-only fall back to view', async ({
  page,
}) => {
  await launch(page, 'account-storage-near');
  const status = page.locator('[data-storage-status="near"]');
  await expect(status).toHaveAccessibleName('Your storage is almost full');
  await status.click();
  await expect(page.getByRole('dialog')).toContainText(
    "You've used over 95% of your storage."
  );
  await page.keyboard.press('Escape');
  await page.goto('/');
  await expect(page.getByTestId('storage-usage-meter')).toBeVisible();
  await expect(
    page.getByText('Storage almost full', { exact: true })
  ).toBeVisible();

  // Full storage: the note is view-only while organizing stays in its menu.
  await launch(page, 'account-storage-full');
  await page.goto(
    '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit'
  );
  await expect(
    page.getByText('A note for trying application errors.')
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Material mode' })).toHaveCount(
    0
  );
  await page
    .getByTestId('content-header')
    .getByRole('button', { name: 'Open menu' })
    .click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');

  await launch(page, 'account-over-quota');
  await page.goto(
    '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit'
  );
  await expect(page.locator('[data-storage-status="frozen-self"]')).toBeVisible(
    { timeout: 30_000 }
  );
  await expect(
    page.getByText('A note for trying application errors.')
  ).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Material mode' })).toHaveCount(
    0
  );
});

test('storage status journeys reach the dashboard, own and shared workspaces', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Dashboard cards for the viewer's own account.
  for (const [id, title] of [
    ['account-storage-near-dashboard', 'Storage almost full'],
    ['account-storage-full-dashboard', 'Storage full'],
    ['account-grace', 'Storage over free limit'],
    ['account-over-quota', 'Account frozen'],
  ]) {
    await launch(page, id);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  // The workspace header triangle: own workspace, then the member wording.
  for (const [id, status, name] of [
    ['account-storage-near', 'near', 'Your storage is almost full'],
    ['account-storage-full', 'full', 'Your storage is full'],
    ['account-grace-workspace', 'full', 'Your storage is full'],
    ['account-frozen-workspace', 'frozen-self', 'Account frozen'],
    ['account-frozen-member', 'frozen-self', 'Account frozen'],
    [
      'workspace-owner-near',
      'near',
      'Workspace owner is almost out of storage',
    ],
    ['workspace-owner-full', 'full', "Workspace owner's storage is full"],
    ['workspace-owner-grace', 'full', "Workspace owner's storage is full"],
    [
      'workspace-owner-frozen',
      'frozen-owner',
      "Workspace owner's account is frozen",
    ],
  ]) {
    await launch(page, id);
    await expect(
      page.locator(`[data-storage-status="${status}"]`)
    ).toHaveAccessibleName(name);
  }
  // The frozen owner's workspace is read-only for its members too.
  await page.goto(
    '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit'
  );
  await expect(
    page.getByText('A note for trying application errors.')
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);

  await launch(page, 'account-frozen-create');
  await expect(
    page.getByRole('button', { exact: true, name: 'New workspace' })
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await expect(
    page.getByRole('menuitem', { name: 'Clone workspace' })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('[data-storage-status="frozen-self"]').click();
  await expect(page.getByRole('dialog')).toContainText('Account frozen');

  // The invitation page speaks about the recipient's own frozen account.
  await launch(page, 'invite-frozen');
  await expect(page.getByTestId('invite-accept-error')).toContainText(
    'Account frozen'
  );
});

test('a frozen account or full storage mid-edit drops open editors to view and discards unsaved edits', async ({
  page,
}) => {
  const strip = page.getByText(
    'This file is read-only now. Viewing, downloading and deleting still work.'
  );
  for (const id of [
    'note-frozen-while-editing',
    'note-storage-full-while-editing',
  ]) {
    await launch(page, id);
    await expect(strip).toBeVisible();
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    // The refreshed note offers no Edit, and the refused edit is gone.
    await expect(
      page.getByRole('button', { name: 'Material mode' })
    ).toHaveCount(0);
    await expect(
      page.getByText('A note for trying application errors.')
    ).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);
    await expect(
      page.getByRole('button', { exact: true, name: 'Download draft' })
    ).toHaveCount(0);
  }

  // Unsaved source text is discarded too, with no recovery path and no Saved
  // state, while the view shows the saved but unpublished edit.
  await launch(page, 'source-frozen-while-editing');
  await expect(strip).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Edit source text' })
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(savedMarker)).toBeVisible();
  await expect(page.getByText(marker)).toHaveCount(0);
  await expect(page.locator('[data-source-status]')).not.toHaveAttribute(
    'data-source-status',
    'saved'
  );
});

test('a text source in view mode shows its latest saved state, not only the published bytes', async ({
  page,
}) => {
  // Leaving Edit: the saved edit stays in view.
  await page.goto('/workspaces/ws_scenarios?file=mock-scenario-text&mode=edit');
  const input = page.getByRole('textbox', { name: 'Edit source text' });
  await expect(input).not.toHaveValue('', { timeout: 30_000 });
  await input.fill(`${await input.inputValue()}\n${savedMarker}`);
  await page.getByRole('button', { name: 'Material mode' }).click();
  await expect(input).toHaveCount(0);
  await expect(page.getByText(savedMarker)).toBeVisible();
  // A fresh open in view mode reads the viewer session: saving did not
  // publish, yet the edit shows.
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-pdf"]')
    .click();
  await expect(page.getByText(savedMarker)).toHaveCount(0);
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-text"]')
    .click();
  await expect(page.getByText(savedMarker)).toBeVisible();
});

test('a failed annotation save shows its strip under the PDF toolbar', async ({
  page,
}) => {
  await launch(page, 'annotations-save');
  const strip = page.getByRole('alert').filter({
    hasText: 'Your last annotation change could not be saved.',
  });
  await expect(strip).toBeInViewport();
  const stripBox = await strip.boundingBox();
  const toolbarBox = await page
    .getByRole('toolbar', { name: 'Private annotations' })
    .boundingBox();
  const pageBox = await page.locator('[data-page="1"]').boundingBox();
  expect(stripBox!.y).toBeGreaterThan(toolbarBox!.y);
  expect(stripBox!.y).toBeLessThan(pageBox!.y);
});

test('pending import keeps polling in the transfer panel until Reset', async ({
  page,
}) => {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (
        String(input).includes('/sources/imports/') &&
        (!init?.method || init.method === 'GET')
      )
        performance.mark('scenario-import-poll');
      return fetch(input, init);
    };
  });
  await launch(page, 'import-job-pending');
  await expect
    .poll(
      () =>
        page.evaluate(
          () => performance.getEntriesByName('scenario-import-poll').length
        ),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const transfers = page.getByTestId('source-transfer-panel');
  await expect(transfers).toContainText('Importing');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.evaluate((node: HTMLDetailsElement) => {
    node.open = true;
  });
  await panel
    .locator('button')
    .filter({ hasText: /^Reset$/ })
    .click();
  await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
  await expect(transfers).toHaveCount(0);
});

test('failed Office export keeps the editor and URL in Edit', async ({
  page,
}) => {
  await launch(page, 'office-runtime-error');
  await expect(page).toHaveURL(/mode=edit/);
  await expect(
    page.getByRole('button', { name: 'Material mode' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('iframe[src*="office-runtime"]')).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem('capy.document.mode.file.mock-scenario-xlsx')
    )
  ).toBe('edit');
});
