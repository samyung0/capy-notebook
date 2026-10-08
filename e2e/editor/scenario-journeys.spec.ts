import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { officeEditMenu, saveOffice } from '../helpers/office';
import { m } from '../i18n';

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
  // A slow save failure shows the save banner and marks the header; the
  // editor keeps its edits.
  const banner = page.getByTestId('save-banner');
  await expect(banner.getByText(m.editor_save_delayed())).toBeVisible();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'unsaved'
  );
  // Closing hides it for this episode only.
  await banner
    .getByRole('button', { exact: true, name: m.action_close() })
    .click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const mounted = await input.elementHandle();
  const currentURL = page.url();
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-pdf"]')
    .click();
  await expect(page).toHaveURL(currentURL);
  await expect(input).toHaveValue(new RegExp(marker));
  await page
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await expect(input).toHaveValue(new RegExp(marker));
  expect(await mounted!.evaluate((node) => node.isConnected)).toBe(true);
  // The next failure is a new episode: the banner shows again.
  await launch(page, 'source-save-failed');
  await expect(banner.getByText(m.editor_save_delayed())).toBeVisible();
  await expect(input).toHaveValue(
    new RegExp(`^[\\s\\S]*${marker.replaceAll('.', '\\.')}\\s*$`)
  );
  expect((await input.inputValue()).split(marker)).toHaveLength(2);
});

// Every recovery path (a save refused for good, a replaced session, a draft
// from another version) leaves the edits on screen read-only for copying,
// with no download or discard; a page reload keeps them until Reload.
for (const [id, kind] of [
  ['source-replaced', 'changed'],
  ['source-draft-recovery', 'changed'],
  ['source-save-refused', 'refused'],
] as const) {
  test(`${id} shows the edits for copying until Reload`, async ({ page }) => {
    await launch(page, id);
    const draft = page.locator('textarea[readonly]');
    const banner = page.getByTestId('save-banner');
    const shown = async () => {
      await expect(draft).toHaveValue(new RegExp(marker), { timeout: 30_000 });
      await expect(banner).toHaveAttribute('data-kind', kind);
      // Reload replaces the close button: recovery cannot be dismissed.
      await expect(banner.getByRole('button')).toHaveCount(1);
      await expect(
        banner.getByRole('button', {
          exact: true,
          name: m.error_action_reload(),
        })
      ).toBeVisible();
      // 'Discard this draft' is a removed control, kept as a negative check.
      for (const name of [m.source_edit_download_draft(), 'Discard this draft'])
        await expect(
          page.getByRole('button', { exact: true, name })
        ).toHaveCount(0);
      await draft.selectText();
      expect(
        await draft.evaluate(
          (node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart
        )
      ).toBeGreaterThan(marker.length);
    };
    await shown();
    await expect(page).toHaveURL(/mode=edit/);
    await page.reload();
    // A full dev-server reload takes about 5 s before the mode button renders.
    await expect(
      page.getByRole('button', { name: m.material_mode() })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await shown();
    await expect(page.getByTestId('mock-scenario-panel')).toHaveAttribute(
      'data-scenario-status',
      'idle'
    );
    await banner
      .getByRole('button', { exact: true, name: m.error_action_reload() })
      .click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.locator('textarea[aria-label]').filter({ visible: true }).first()
    ).not.toHaveValue(new RegExp(marker));
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const modulePath = '/src/lib/editDrafts.ts';
          const dbPath = '/src/mocks/db.ts';
          const { draftKey, readDrafts } = await import(modulePath);
          const { user } = await import(dbPath);
          return (
            await readDrafts(draftKey(user.id, 'file', 'mock-scenario-text'))
          ).length;
        })
      )
      .toBe(0);
  });
}

// Office recovery hands the engine its read-only mode instead of an inert
// editor: the refused DOCX edit can be selected and copied.
test('a refused DOCX save keeps the edit copyable until Reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await launch(page, 'office-docx-save');
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { refuseNextSourceSave } = await import(modulePath);
    refuseNextSourceSave('mock-scenario-docx');
  });
  await saveOffice(page);
  const banner = page.getByTestId('save-banner');
  await expect(banner).toHaveAttribute('data-kind', 'refused');
  await expect(
    page.getByRole('button', {
      exact: true,
      name: m.source_edit_download_draft(),
    })
  ).toHaveCount(0);
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect
    .poll(() =>
      frame
        .locator('.office-editor-host')
        .first()
        .evaluate((node: HTMLElement) => node.inert)
    )
    .toBe(false);
  await expect(frame.locator('[aria-label="Document input"]')).toHaveAttribute(
    'readonly',
    ''
  );
  // Read after the engine's own copy handler, while the data is readable.
  const copied = frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<string>((resolve) =>
          window.addEventListener(
            'copy',
            (event) =>
              resolve(event.clipboardData?.getData('text/plain') ?? ''),
            { once: true }
          )
        )
    );
  await frame
    .locator('canvas')
    .first()
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  expect(await copied).toContain(marker);
  await page.reload();
  await expect(banner).toHaveAttribute('data-kind', 'refused', {
    timeout: 60_000,
  });
  await banner
    .getByRole('button', { exact: true, name: m.error_action_reload() })
    .click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
});

// PPTX recovery copies too: the engine's read-only mode still selects and
// copies slide text.
test('a refused PPTX save keeps the slide text copyable until Reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await launch(page, 'office-pptx-save');
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { refuseNextSourceSave } = await import(modulePath);
    refuseNextSourceSave('mock-scenario-pptx');
  });
  await saveOffice(page);
  const banner = page.getByTestId('save-banner');
  await expect(banner).toHaveAttribute('data-kind', 'refused');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  const input = frame.getByTestId('pptx-text-input');
  await expect(input).toHaveAttribute('readonly', '');
  const copied = frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<string>((resolve) =>
          window.addEventListener(
            'copy',
            (event) =>
              resolve(event.clipboardData?.getData('text/plain') ?? ''),
            { once: true }
          )
        )
    );
  // The edit opens the first text box (lesson.pptx: 10%–90% across, its
  // first line at about 16% down the slide); drag across that line.
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = (await canvas.boundingBox())!;
  const y = box.y + box.height * 0.16;
  await page.mouse.move(box.x + box.width * 0.11, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.89, y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+C');
  expect(await copied).toContain(marker);
  await banner
    .getByRole('button', { exact: true, name: m.error_action_reload() })
    .click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
});

for (const format of ['docx', 'xlsx', 'pptx']) {
  test(`${format} opens valid bytes, edits, fails save, and retries without replacing the iframe`, async ({
    page,
  }) => {
    // Native initialization and a full Vite reload share this workflow budget.
    test.setTimeout(120_000);
    await launch(page, `office-${format}-save`);
    const frame = page.locator('iframe[src*="office-runtime"]');
    const mounted = await frame.elementHandle();
    await expect(page.getByTestId('save-banner')).toHaveAttribute(
      'data-kind',
      'delayed'
    );
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'unsaved'
    );
    await saveOffice(page);
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved'
    );
    await expect(page.getByTestId('save-banner')).toHaveCount(0);
    expect(await mounted!.evaluate((node) => node.isConnected)).toBe(true);
    const mode = page.getByRole('button', { name: m.material_mode() });
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
  await page
    .getByRole('button', { exact: true, name: m.error_action_retry() })
    .click();
  await expect(
    page.getByRole('heading', { exact: true, name: m.nav_files() })
  ).toBeVisible();
  await launch(page, 'file-save');
  const rename = page.getByRole('dialog', {
    exact: true,
    name: m.action_rename(),
  });
  await expect(rename).toBeVisible();
  await expect(rename.locator('input')).toHaveValue('Renamed scenario item');
  await rename
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole('heading', { exact: true, name: 'Renamed scenario item' })
  ).toBeVisible();
  await launch(page, 'import-inspect');
  await expect(
    page.getByRole('dialog', { exact: true, name: m.action_add_file() })
  ).toBeVisible();
  await expect(
    page
      .locator('[data-sonner-toast]')
      .getByText(m.source_import_failed(), { exact: true })
  ).toBeVisible();
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

test('Office export failure keeps the editable iframe in Edit and draft download works', async ({
  page,
}) => {
  await launch(page, 'office-runtime-error');
  const frame = page.locator('iframe[src*="office-runtime"]');
  const mounted = await frame.elementHandle();
  // The iframe's own error text never renders; the host shows its copy.
  await expect(
    page.getByRole('alert').getByText(m.source_edit_save_failed())
  ).toBeVisible();
  await expect(page).toHaveURL(/mode=edit/);
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate(() =>
      localStorage.getItem('capy.document.mode.file.mock-scenario-xlsx')
    )
  ).toBe('edit');
  const downloadReady = page.waitForEvent('download');
  await page
    .getByRole('button', { exact: true, name: m.source_edit_download_draft() })
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
    name: m.account_blocked_suspended_title(),
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

test('storage status reaches the dashboard, own and shared workspaces, and full or frozen storage falls back to view', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await test.step('amber near the limit, full view-only and frozen read-only fall back to view', async () => {
    await launch(page, 'account-storage-near');
    const status = page.getByRole('button', {
      exact: true,
      name: m.workspace_storage_near_self_title(),
    });
    await expect(status).toHaveAttribute('data-storage-status', 'near');
    await status.click();
    await expect(
      page.getByRole('dialog', { name: m.workspace_storage_near_self_title() })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.getByTestId('storage-usage-meter')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(m.account_banner_near_title(), { exact: true })
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
    await expect(
      page.getByRole('button', { name: m.material_mode() })
    ).toHaveCount(0);
    await page
      .getByTestId('content-header')
      .getByRole('button', { name: m.a11y_open_menu() })
      .click();
    await expect(
      page.getByRole('menuitem', { name: m.action_rename() })
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await launch(page, 'account-over-quota');
    await page.goto(
      '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit'
    );
    await expect(
      page.locator('[data-storage-status="frozen-self"]')
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('A note for trying application errors.')
    ).toBeVisible();
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: m.material_mode() })
    ).toHaveCount(0);
  });

  await test.step('journeys reach the dashboard, own and shared workspaces', async () => {
    // Dashboard cards for the viewer's own account.
    for (const [id, title] of [
      ['account-storage-near-dashboard', m.account_banner_near_title()],
      ['account-storage-full-dashboard', m.account_banner_full_title()],
      ['account-grace', m.account_banner_grace_title()],
      ['account-over-quota', m.account_banner_frozen_title()],
    ]) {
      await launch(page, id);
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
    // The workspace header triangle: own workspace, then the member wording.
    for (const [id, status, name] of [
      ['account-storage-near', 'near', m.workspace_storage_near_self_title()],
      ['account-storage-full', 'full', m.workspace_storage_owner_self_title()],
      [
        'account-grace-workspace',
        'full',
        m.workspace_storage_owner_self_title(),
      ],
      [
        'account-frozen-workspace',
        'frozen-self',
        m.account_banner_frozen_title(),
      ],
      ['account-frozen-member', 'frozen-self', m.account_banner_frozen_title()],
      ['workspace-owner-near', 'near', m.workspace_storage_owner_near_title()],
      ['workspace-owner-full', 'full', m.workspace_storage_owner_full_title()],
      ['workspace-owner-grace', 'full', m.workspace_storage_owner_full_title()],
      [
        'workspace-owner-frozen',
        'frozen-owner',
        m.workspace_storage_owner_frozen_title(),
      ],
    ]) {
      await launch(page, id);
      await expect(
        page.getByRole('button', { exact: true, name })
      ).toHaveAttribute('data-storage-status', status);
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
      page.getByRole('button', { exact: true, name: m.action_new_workspace() })
    ).toBeDisabled();
    await page
      .getByRole('button', { name: m.a11y_open_menu() })
      .first()
      .click();
    await expect(
      page.getByRole('menuitem', { name: m.action_clone_workspace() })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('[data-storage-status="frozen-self"]').click();
    await expect(
      page.getByRole('dialog', { name: m.account_banner_frozen_title() })
    ).toBeVisible();

    // The invitation page speaks about the recipient's own frozen account.
    await launch(page, 'invite-frozen');
    await expect(
      page
        .getByTestId('invite-accept-error')
        .getByText(m.account_banner_frozen_title(), { exact: true })
    ).toBeVisible();
  });
});

test('a frozen account or full storage mid-edit drops open editors to view and discards unsaved edits', async ({
  page,
}) => {
  const strip = page.getByText(m.editor_read_only_strip());
  for (const id of [
    'note-frozen-while-editing',
    'note-storage-full-while-editing',
  ]) {
    await launch(page, id);
    await expect(strip).toBeVisible();
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    // The refreshed note offers no Edit, and the refused edit is gone.
    await expect(
      page.getByRole('button', { name: m.material_mode() })
    ).toHaveCount(0);
    await expect(
      page.getByText('A note for trying application errors.')
    ).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        exact: true,
        name: m.source_edit_download_draft(),
      })
    ).toHaveCount(0);
  }

  // Unsaved source text is discarded too, with no recovery path and no Saved
  // state, while the view shows the saved but unpublished edit.
  await launch(page, 'source-frozen-while-editing');
  await expect(strip).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: m.source_edit_raw() })
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
  const input = page.getByRole('textbox', { name: m.source_edit_raw() });
  await expect(input).not.toHaveValue('', { timeout: 30_000 });
  await input.fill(`${await input.inputValue()}\n${savedMarker}`);
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(input).toHaveCount(0);
  await expect(page.getByText(savedMarker)).toBeVisible();
  // A fresh open in view mode reads the viewer session: saving did not
  // publish, yet the edit shows.
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-pdf"]')
    .click();
  await expect(page.getByText(savedMarker)).toHaveCount(0);
  await page
    .locator('[data-workspace-file-tree] a[href*="file=mock-scenario-text"]')
    .click();
  await expect(page.getByText(savedMarker)).toBeVisible();
});

test('a failed annotation save shows its strip on the PDF', async ({
  page,
}) => {
  await launch(page, 'annotations-save');
  const strip = page.getByRole('alert').filter({
    hasText: m.pdf_annotations_write_failed(),
  });
  await expect(strip).toBeInViewport();
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
  await expect(
    transfers.getByText(m.source_transfer_importing(), { exact: true })
  ).toBeVisible();
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
