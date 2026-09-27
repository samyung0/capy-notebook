import { expect, test } from '@playwright/test';

test('question formula accepts physical digits and retains them after commit', async ({
  page,
}) => {
  await page.goto('/bank/mensuration/bank-quadratic?mode=edit');
  await page
    .getByRole('button', { exact: true, name: 'Edit question' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: /^A rectangle has area/ })
    .and(dialog.locator('button:not([aria-haspopup])'))
    .click();
  const editor = dialog.getByRole('textbox', { name: 'Text and formulas' });
  await editor
    .getByRole('button', { exact: true, name: 'Formula' })
    .first()
    .click();
  const formula = editor.locator('math-field');
  await expect(formula).toBeVisible();
  await formula.press('ControlOrMeta+A');
  await formula.press('5');
  await expect(formula).toHaveJSProperty('value', '5');
  await formula.press('Enter');
  await expect(formula).toHaveCount(0);
  await editor
    .getByRole('button', { exact: true, name: 'Formula' })
    .first()
    .click();
  await expect(formula).toHaveJSProperty('value', '5');
});
