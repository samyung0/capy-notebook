import { expect, test } from '@playwright/test';

test('workspace creation and editing share icon and description fields', async ({
  page,
}) => {
  await page.goto('/workspaces');
  await page
    .getByRole('button', { exact: true, name: 'New workspace' })
    .click();
  const create = page.getByRole('dialog', {
    exact: true,
    name: 'Create workspace',
  });
  await expect(create.getByPlaceholder('Workspace name')).toBeFocused();
  await create.getByPlaceholder('Workspace name').fill('Metadata workspace');
  await create
    .getByRole('textbox', { exact: true, name: 'Description' })
    .fill('Study with a chosen icon');
  await expect(
    create.getByRole('textbox', { exact: true, name: 'Description' })
  ).toHaveAttribute('maxlength', '500');
  await create
    .getByRole('button', { exact: true, name: 'Choose icon' })
    .click();
  const picker = page.getByRole('dialog', { exact: true, name: 'Choose icon' });
  await picker.getByRole('button', { exact: true, name: 'Waves' }).click();
  await picker.getByRole('button', { exact: true, name: 'waves-03' }).click();
  await picker.getByRole('button', { exact: true, name: 'Use icon' }).click();
  await expect(create.locator('img').first()).toHaveAttribute(
    'src',
    '/icons/waves-03.svg'
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    path: test.info().outputPath('workspace-create-mobile.png'),
  });
  await create.getByRole('button', { exact: true, name: 'Create' }).click();
  await expect(create).toHaveCount(0);
  const card = page
    .getByRole('link', { name: /Metadata workspace/ })
    .locator('..');
  await card.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  const edit = page.getByRole('dialog', {
    exact: true,
    name: 'Workspace settings',
  });
  await expect(
    edit.getByRole('textbox', { exact: true, name: 'Description' })
  ).toHaveValue('Study with a chosen icon');
  await expect(edit.locator('img').first()).toHaveAttribute(
    'src',
    '/icons/waves-03.svg'
  );
  await edit
    .getByRole('textbox', { exact: true, name: 'Description' })
    .fill('Updated study description');
  await edit.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(
    edit.getByRole('button', { exact: true, name: 'Save' })
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
  await card.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await expect(
    edit.getByRole('textbox', { exact: true, name: 'Description' })
  ).toHaveValue('Updated study description');
});

test('signup resend has a cooldown and a failed resend remains retryable', async ({
  page,
}) => {
  await page.goto('/sign-up');
  await page.getByLabel('Email', { exact: true }).fill('student@example.com');
  await page.getByLabel(/Password$/).fill('BiologyStudy!123');
  await page
    .getByRole('button', { exact: true, name: 'Create account' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Check your inbox' })
  ).toBeVisible();
  const resend = page.getByRole('button', { name: /Code sent|Resend code/ });
  await expect(resend).toBeDisabled();
  await page.clock.install();
  await page.clock.fastForward(62_000);
  await expect(resend).toHaveAccessibleName('Resend code');
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(resend).toHaveAccessibleName('Code sent');
  await expect(resend).toBeDisabled();
  await page.clock.runFor(1600);
  await expect(resend).toHaveAccessibleName('Resend code (60s)');
  await page.clock.fastForward(60_000);
  await expect(resend).toBeEnabled();

  await page.getByText('User scenarios', { exact: true }).click();
  await page
    .getByRole('combobox', { exact: true, name: 'Scenario' })
    .selectOption('auth-send-code');
  await page
    .getByRole('button', { exact: true, name: 'Apply scenario' })
    .click();
  await page.getByText('User scenarios', { exact: false }).first().click();
  await resend.click();
  await expect(page.getByRole('alert')).toContainText(
    'Unable to send a verification code'
  );
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveAccessibleName('Resend code');
});

test('workspace cards open settings and statistics without entering the workspace', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const card = page.getByRole('link', { name: /Biology 101/ }).locator('..');
  await card.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces$/);
  await settings
    .getByRole('button', { exact: true, name: 'Workspace statistics' })
    .click();
  await expect(
    settings.getByText('Average score', { exact: true })
  ).toBeVisible();
  await expect(settings.locator('.tabular-nums')).toHaveCount(5);
  const digit = settings.locator('.tabular-nums [aria-hidden] > span').first();
  await expect(digit).toHaveCSS('animation-name', 'motion-number-pop');
  await page.screenshot({
    path: test.info().outputPath('statistics-desktop.png'),
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(digit).toHaveCSS('animation-name', 'none');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    path: test.info().outputPath('statistics-mobile.png'),
  });
  await settings.getByRole('button', { exact: true, name: 'General' }).click();
  await expect(settings.getByText('Color', { exact: true })).toHaveCount(0);
});

test('Biology file fixtures reach the shared PDF error and empty preview', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?file=mock-preview-pdf');
  await expect(
    page.getByRole('alert').getByText('Something went wrong', { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { exact: true, name: 'Retry' })
  ).toBeVisible();
  await expect(
    page.getByText('Private annotations could not be loaded.', { exact: true })
  ).toHaveCount(0);
  await page.goto('/workspaces/ws_bio?file=mock-preview-empty');
  await expect(
    page
      .getByRole('alert')
      .getByText("This file can't be previewed", { exact: true })
  ).toBeVisible();
});

test('invitations are standalone and transfer previews open only one dialog', async ({
  page,
}) => {
  await page.goto('/workspace-invites/mock-token');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Workspace invitation' })
  ).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(
    page.getByRole('link', { exact: true, name: 'Workspaces' })
  ).toHaveCount(0);
  await page.getByText('User scenarios', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Transfer ownership confirmation' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const transfer = page.getByRole('dialog', {
    name: 'Transfer workspace ownership?',
  });
  await expect(transfer).toBeVisible();
  await transfer.getByRole('button', { exact: true, name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
