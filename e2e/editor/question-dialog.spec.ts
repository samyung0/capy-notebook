import { expect, type Locator, test } from '@playwright/test';
import { m } from '../i18n';

/** A part's answer row in the question: the answer key under the waves
 * shares its name. A click selects the row and a double click edits it. */
const partAnswers = (dialog: Locator) =>
  dialog
    .getByRole('button', { name: m.question_ui_select_answer() })
    .and(dialog.locator('[data-row-key^="part:"]'));

test('undoing the add of a chart still open in its editor goes back to the question', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: m.question_ui_add_block_or_part() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.question_ui_chart() })
    .click();
  const chartEditor = dialog.getByRole('heading', {
    exact: true,
    name: m.question_ui_chart(),
  });
  await expect(chartEditor).toBeVisible();
  // The chart's edits stay staged until Done, so Undo takes back its add.
  await dialog.getByRole('button', { name: m.editor_undo() }).click();
  await expect(chartEditor).toBeHidden();
  await expect(partAnswers(dialog)).toBeVisible();
});

test('a quiz embedded in a note keeps its question dialog open through an edit', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=mat_note_1&mode=edit');
  await page
    .getByRole('heading', { name: 'Self-check' })
    .scrollIntoViewIfNeeded({ timeout: 30_000 });
  const stem = page
    .getByText('Which organelle produces most of the ATP')
    .first();
  await expect(stem).toBeVisible({ timeout: 30_000 });
  await page
    .locator('[data-question-id]')
    .filter({ has: stem })
    .locator('xpath=..')
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: m.question_ui_add_block_or_part() })
    .click();
  // The edit reprojects the quiz and invalidates its read, which the note's
  // footer also observes: the refetch must reach the network and the embed
  // (with its dialog) stay mounted.
  const refetch = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/quizzes/mat_embed_bio_note_quiz') &&
      response.ok()
  );
  await page
    .getByRole('button', { exact: true, name: m.question_ui_text() })
    .click();
  await page.keyboard.type('Extra');
  await refetch;
  await expect(
    dialog.getByRole('heading', { exact: true, name: m.question_ui_text() })
  ).toBeVisible();
});

test('closing an open answer editor goes back to the question', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  const answer = partAnswers(dialog);
  await answer.dblclick();
  const answerEditor = dialog.getByRole('heading', {
    exact: true,
    name: 'Answer and marks',
  });
  await expect(answerEditor).toBeVisible();
  await dialog
    .getByRole('button', { exact: true, name: m.action_close() })
    .click();
  await expect(answerEditor).toBeHidden();
  await expect(answer).toBeVisible();
});

test('a part’s marks step and type within 1 to the marks cap', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  await partAnswers(dialog).dblclick();
  const marks = dialog.getByRole('textbox', {
    name: m.question_ui_part_marks(),
  });
  const more = dialog.getByRole('button', {
    name: m.question_ui_marks_increase(),
  });
  await expect(marks).toHaveValue('1');
  await more.click();
  await expect(marks).toHaveValue('2');
  await marks.fill('25');
  await expect(marks).toHaveValue('20');
  await expect(more).toBeDisabled();
});

test('a multiple choice option is marked correct with its toggle', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  await partAnswers(dialog).dblclick();
  const first = dialog.getByRole('button', {
    name: m.question_ui_mark_correct({ number: 1 }),
  });
  const second = dialog.getByRole('button', {
    name: m.question_ui_mark_correct({ number: 2 }),
  });
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await second.click();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'false');
});

test('a table adds a column and removes a row from its own controls', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: m.question_ui_add_block_or_part() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.question_ui_table() })
    .click();
  const cell = (row: number, column: number) =>
    dialog.getByRole('button', {
      name: m.question_ui_edit_cell({ column, row }),
    });
  await dialog
    .getByRole('button', { name: m.question_ui_add_column() })
    .click();
  await expect(cell(1, 3)).toBeVisible();
  await dialog
    .getByRole('button', {
      name: m.question_ui_remove_row_number({ number: 2 }),
    })
    .click();
  await expect(cell(2, 1)).toHaveCount(0);
});

test('adding a part shows it in the question instead of opening its answer', async ({
  page,
}) => {
  await page.goto('/materials/qz_2?mode=edit');
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: m.question_ui_add_block_or_part() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.question_ui_part() })
    .click();
  await expect(partAnswers(dialog)).toHaveCount(2);
});
