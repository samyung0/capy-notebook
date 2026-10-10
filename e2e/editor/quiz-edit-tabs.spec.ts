import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('quiz tabs retain both drafts and reveal name validation before saving', async ({
  page,
}) => {
  await page.goto('/quizzes/qz_2/edit?returnTo=%2Fmaterials%2Fqz_2');
  const questions = page.locator('[data-question-id]');
  const name = page.getByRole('textbox', { name: m.quiz_name() });
  const generalTab = page.getByRole('tab', {
    exact: true,
    name: m.settings_tab_general(),
  });
  const questionsTab = page.getByRole('tab', {
    exact: true,
    name: m.quiz_questions(),
  });
  // The page's Save; its confirm dialog, portalled after the page, has another.
  const save = page
    .getByRole('button', { exact: true, name: m.action_save() })
    .first();
  const confirmSave = () =>
    page
      .getByRole('dialog', { name: m.edit_save_confirm_title() })
      .getByRole('button', { name: m.action_save() })
      .click();

  await expect(questions).toHaveCount(10, { timeout: 30_000 });
  await expect(name).toHaveCount(0);
  await questions
    .first()
    .getByRole('button', { name: m.action_remove() })
    .click();
  await page
    .getByRole('dialog', { name: m.quiz_remove_question_confirm_title() })
    .getByRole('button', { name: m.action_remove() })
    .click();
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

test('quiz tabs follow the WAI-ARIA tabs keyboard pattern', async ({
  page,
}) => {
  await page.goto('/quizzes/qz_2/edit?returnTo=%2Fmaterials%2Fqz_2');
  const tabs = page.getByRole('tablist').getByRole('tab');
  const questionsTab = tabs.filter({ hasText: m.quiz_questions() });
  const generalTab = tabs.filter({ hasText: m.settings_tab_general() });
  const name = page.getByRole('textbox', { name: m.quiz_name() });

  await expect(questionsTab).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000,
  });
  await expect(questionsTab).toHaveAttribute('tabindex', '0');
  await expect(generalTab).toHaveAttribute('tabindex', '-1');

  await questionsTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(generalTab).toBeFocused();
  await expect(generalTab).toHaveAttribute('aria-selected', 'true');
  await expect(name).toBeVisible();
  // Arrows wrap; Home and End jump to the ends.
  await page.keyboard.press('ArrowRight');
  await expect(questionsTab).toBeFocused();
  await page.keyboard.press('End');
  await expect(generalTab).toBeFocused();
  await page.keyboard.press('Home');
  await expect(questionsTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(generalTab).toBeFocused();
});
