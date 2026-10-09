import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('a broken diagram marks its line in Edit, and Save fixes it for View', async ({
  page,
}) => {
  // Nothing drew, so nothing opens full screen.
  await page.goto('/materials/mock-material-diagram?mode=view');
  await expect(page.getByText(m.mermaid_syntax_error({ line: 2 }))).toBeVisible(
    { timeout: 30_000 }
  );
  await expect(page.locator('.cursor-zoom-in')).toHaveCount(0);

  await page.goto('/materials/mock-material-diagram?mode=edit');
  const source = page.getByRole('textbox', {
    name: m.editor_mermaid_source(),
  });
  await expect(source).toBeVisible({ timeout: 30_000 });
  // Edit marks the line in the source instead of printing the message.
  await expect(page.locator('.cm-error-line')).toHaveText('  A[Unclosed node');
  await expect(page.getByText(m.mermaid_syntax_error({ line: 2 }))).toHaveCount(
    0
  );
  await expect(page.locator('.cursor-zoom-in')).toHaveCount(0);
  const save = page.getByRole('button', { exact: true, name: m.action_save() });
  await expect(save).toBeDisabled();

  await source.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(']');
  await expect(page.locator('.cm-error-line')).toHaveCount(0);
  await expect(page.locator('.mermaid-render')).toContainText('Unclosed node');
  await save.click();
  await expect(save).toBeDisabled();

  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(page).toHaveURL(/mode=view/);
  await expect(page.locator('.mermaid-render')).toContainText('Unclosed node');
  await expect(page.getByText(m.mermaid_syntax_error({ line: 2 }))).toHaveCount(
    0
  );
  await page.locator('.cursor-zoom-in').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
