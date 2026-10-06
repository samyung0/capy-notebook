import { expect, test } from '@playwright/test';

test('quiz tabs retain both drafts and reveal name validation before saving', async ({
  page,
}) => {
  await page.goto('/quizzes/qz_2/edit?returnTo=%2Fmaterials%2Fqz_2');
  const questions = page.locator('[data-question-id]');
  const name = page.getByRole('textbox', { name: /^Quiz name/ });
  const generalTab = page.getByRole('button', { exact: true, name: 'General' });
  const questionsTab = page.getByRole('button', {
    exact: true,
    name: 'Questions',
  });
  // The page's Save; its confirm dialog, portalled after the page, has another.
  const save = page.getByRole('button', { exact: true, name: 'Save' }).first();
  const confirmSave = () =>
    page
      .getByRole('dialog', { name: 'Save your changes?' })
      .getByRole('button', { name: 'Save' })
      .click();

  await expect(questions).toHaveCount(10, { timeout: 30_000 });
  await expect(name).toHaveCount(0);
  await questions.first().getByRole('button', { name: 'Remove' }).click();
  await expect(questions).toHaveCount(9);

  await generalTab.click();
  await expect(name).toHaveValue('Genetics check-in');
  await expect(questions).toHaveCount(0);
  await name.fill('');
  await questionsTab.click();
  await save.click();
  await confirmSave();
  await expect(name).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();

  await name.fill('Genetics revision');
  await questionsTab.click();
  await expect(questions).toHaveCount(9);
  await generalTab.click();
  await expect(name).toHaveValue('Genetics revision');
  await questionsTab.click();
  await save.click();
  await confirmSave();

  await expect(page).toHaveURL('/materials/qz_2');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Genetics revision' })
  ).toBeVisible();
  await expect(questions).toHaveCount(9);
});
