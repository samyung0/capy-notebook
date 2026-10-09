import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('workspace creation and editing share icon and description fields', async ({
  page,
}) => {
  await page.goto('/workspaces');
  await page
    .getByRole('button', { exact: true, name: m.action_new_workspace() })
    .click();
  const create = page.getByRole('dialog', {
    exact: true,
    name: m.workspace_create_title(),
  });
  await expect(
    create.getByPlaceholder(m.workspace_name_placeholder())
  ).toBeFocused();
  await create
    .getByPlaceholder(m.workspace_name_placeholder())
    .fill('Metadata workspace');
  // Not exact: near the limit the label also carries the count ("501/500").
  const description = create.getByRole('textbox', {
    name: m.summary_description_label(),
  });
  const submit = create.getByRole('button', {
    exact: true,
    name: m.action_create(),
  });
  // The 500-character limit is soft: an overlong description is kept but
  // marked, and Create waits until it fits.
  await description.fill('a'.repeat(501));
  await expect(description).toHaveValue('a'.repeat(501));
  await expect(description).toHaveAttribute('aria-invalid', 'true');
  await expect(submit).toBeDisabled();
  await description.fill('Study with a chosen icon');
  await expect(description).toHaveAttribute('aria-invalid', 'false');
  await expect(submit).toBeEnabled();
  await create
    .getByRole('button', { exact: true, name: m.icon_choose() })
    .click();
  const picker = page.getByRole('dialog', {
    exact: true,
    name: m.icon_choose(),
  });
  // The section link also shows the icon count.
  await picker.getByRole('button', { name: /^Waves/ }).click();
  await picker.getByRole('button', { exact: true, name: 'waves-03' }).click();
  await picker.getByRole('button', { exact: true, name: m.icon_use() }).click();
  await expect(create.locator('img').first()).toHaveAttribute(
    'src',
    '/icons/waves-03.svg'
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    path: test.info().outputPath('workspace-create-mobile.png'),
  });
  await submit.click();
  await expect(create).toHaveCount(0);
  const card = page
    .getByRole('link', { name: /Metadata workspace/ })
    .locator('..');
  await card.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: m.workspace_settings() }).click();
  const edit = page.getByRole('dialog', {
    exact: true,
    name: m.workspace_settings(),
  });
  await expect(
    edit.getByRole('textbox', {
      exact: true,
      name: m.summary_description_label(),
    })
  ).toHaveValue('Study with a chosen icon');
  await expect(edit.locator('img').first()).toHaveAttribute(
    'src',
    '/icons/waves-03.svg'
  );
  await edit
    .getByRole('textbox', { exact: true, name: m.summary_description_label() })
    .fill('Updated study description');
  await edit
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await expect(edit).toHaveCount(0);
  await card.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: m.workspace_settings() }).click();
  await expect(
    edit.getByRole('textbox', {
      exact: true,
      name: m.summary_description_label(),
    })
  ).toHaveValue('Updated study description');
});

test('signup resend has a cooldown and a failed resend remains retryable', async ({
  page,
}) => {
  await page.goto('/sign-up');
  await page
    .getByLabel(m.auth_email(), { exact: true })
    .fill('student@example.com');
  await page.getByLabel(m.auth_password()).fill('BiologyStudy!123');
  await page
    .getByRole('button', { exact: true, name: m.auth_signup_submit() })
    .click();
  await expect(
    page.getByRole('heading', { name: m.auth_code_title() })
  ).toBeVisible();
  const resend = page.locator('button[data-resend]');
  await expect(resend).toHaveAttribute('data-resend', /^(sent|cooldown)$/);
  await expect(resend).toBeDisabled();
  await page.clock.install();
  await page.clock.fastForward(62_000);
  await expect(resend).toHaveAttribute('data-resend', 'resend');
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(resend).toHaveAttribute('data-resend', 'sent');
  await expect(resend).toBeDisabled();
  await page.clock.runFor(1600);
  await expect(resend).toHaveAttribute('data-resend', 'cooldown');
  await expect(resend).toHaveAttribute('data-seconds', '60');
  await page.clock.fastForward(60_000);
  await expect(resend).toBeEnabled();

  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const scenarioPath = '/src/mocks/scenarios.ts';
    const { worker } = await import(browserPath);
    const { getMockScenarioHandlers } = await import(scenarioPath);
    worker.use(...getMockScenarioHandlers('auth-send-code'));
  });
  await resend.click();
  await expect(page.getByRole('alert')).toContainText(
    'Unable to send a verification code'
  );
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveAttribute('data-resend', 'resend');
});

test('workspace cards open settings and statistics without entering the workspace', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const card = page.getByRole('link', { name: /Biology 101/ }).locator('..');
  await card.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: m.workspace_settings() }).click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces$/);
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_stats_title() })
    .click();
  await expect(
    settings.getByText(m.stats_average_score(), { exact: true })
  ).toBeVisible();
  await expect(settings.locator('.tabular-nums')).toHaveCount(5);
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_general() })
    .click();
  await expect(
    settings.getByText(m.common_color(), { exact: true })
  ).toHaveCount(0);
});

test('Biology file fixtures reach the shared PDF error and empty preview', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?file=mock-preview-pdf');
  await expect(
    page.getByRole('alert').getByText(m.error_file_title(), { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { exact: true, name: m.error_action_retry() })
  ).toBeVisible();
  await expect(
    page.getByText(m.pdf_annotations_failed(), { exact: true })
  ).toHaveCount(0);
  // A second full workspace load, with the same allowance as the first.
  await page.goto('/workspaces/ws_bio?file=mock-preview-empty');
  await expect(
    page
      .getByRole('alert')
      .getByText(m.error_file_empty_title(), { exact: true })
  ).toBeVisible({ timeout: 30_000 });
});

test('invitations are standalone and transfer previews open only one dialog', async ({
  page,
}) => {
  await page.goto('/workspace-invites/mock-token');
  await expect(
    page.getByRole('heading', { exact: true, name: m.invite_title() })
  ).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(
    page.getByRole('link', { exact: true, name: m.nav_workspaces() })
  ).toHaveCount(0);
  await page.getByText('User scenarios', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Transfer ownership confirmation' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const transfer = page.getByRole('dialog', {
    name: m.workspace_transfer_title(),
  });
  await expect(transfer).toBeVisible();
  await transfer
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('workspace sorting picks an order and reverses it from the active option', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const trigger = page.locator('button[data-sort]');
  await expect(trigger).toHaveAttribute('data-sort', 'created', {
    timeout: 30_000,
  });
  await expect(trigger).toHaveAttribute('data-order', 'descending');
  const cards = page.locator('a[href^="/workspaces/"]');
  await expect(cards.first()).toBeVisible();
  const order = () =>
    cards.evaluateAll((links) =>
      links.map((link) => link.getAttribute('href'))
    );
  const menu = page.getByRole('menu');
  // Closing hands focus back to the trigger; a click before that is lost.
  const closed = async () => {
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  };
  // Each option names its default order; choosing closes the menu.
  const choose = async (label: string) => {
    await trigger.click();
    await menu.getByRole('menuitem', { exact: true, name: label }).click();
    await closed();
  };
  // Created is the default (2026-09-21), so it needs no click first.
  for (const [sort, label] of [
    ['created', m.workspaces_sort_created()],
    ['accessed', m.workspaces_sort_accessed()],
    ['chapters', m.workspaces_sort_chapters()],
    ['files', m.workspaces_sort_files()],
  ] as const) {
    if (sort !== 'created') await choose(label);
    await expect(trigger).toHaveAttribute('data-sort', sort);
    await expect(trigger).toHaveAttribute('data-order', 'descending');
    await expect(cards.first()).toBeVisible();
    const original = await order();
    expect(original.length).toBeGreaterThan(1);
    // The active option reverses its order, by mouse and by keyboard.
    await choose(label);
    await expect(trigger).toHaveAttribute('data-order', 'ascending');
    await expect.poll(order).toEqual(original.slice().reverse());
    await trigger.click();
    await menu.getByRole('menuitem', { exact: true, name: label }).focus();
    await page.keyboard.press('Enter');
    await closed();
    await expect(trigger).toHaveAttribute('data-sort', sort);
    await expect(trigger).toHaveAttribute('data-order', 'descending');
    await expect.poll(order).toEqual(original);
  }
});
