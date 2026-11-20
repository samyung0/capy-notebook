import { expect, type Locator, type Page, test } from '@playwright/test';
import { openQuestionCard } from '../helpers/quizEditor';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

/* The question card (Epo 2026-11-15, Google Forms cards): a quiz page's open
 * card edits its question in place, a note's quiz does the same in the note,
 * and the bank's question dialog is the same card in a dialog. These run on
 * qz_2's first question, a multiple choice of one part. */

const STEM = 'A cross between Aa × Aa gives what genotype ratio?';

/** The card's question text, open with its tools under it. */
async function openText(card: Locator) {
  await card.getByRole('button', { name: STEM }).click();
  await expect(
    card.getByRole('toolbar', { name: m.question_ui_formula_tools() })
  ).toBeVisible();
}

/** Insert's menu under the open text, then one of its kinds. */
async function insert(page: Page, card: Locator, kind: string) {
  await openText(card);
  await card
    .getByRole('button', { name: m.question_ui_insert_figure() })
    .click();
  await page.getByRole('button', { exact: true, name: kind }).click();
}

// A chart or graph is edited where it lives (Epo 2026-11-16, D13): added
// from Insert it is in the question at once, the dialog has Done and no Save
// or Cancel, and Done only closes it.
test('a chart added from Insert is in the question at once and Done keeps it', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  await insert(page, card, m.question_ui_chart());
  const chartEditor = page.getByRole('dialog', {
    name: m.question_ui_chart(),
  });
  await expect(chartEditor).toBeVisible();
  await expect(
    chartEditor.getByRole('button', { name: m.question_ui_save() })
  ).toHaveCount(0);
  await expect(
    chartEditor.getByRole('button', { name: m.action_cancel() })
  ).toHaveCount(0);
  await chartEditor
    .getByRole('textbox', { name: m.question_ui_title() })
    .fill('Rainfall');
  await chartEditor
    .getByRole('button', { name: m.drawing_board_done() })
    .click();
  await expect(chartEditor).toBeHidden();
  await expect(
    card.getByRole('button', {
      name: m.question_ui_edit_block({ type: m.question_ui_chart() }),
    })
  ).toHaveCount(1);
  await expect(card.getByText('Rainfall').first()).toBeVisible();
});

test('a part’s marks step and type within 1 to the marks cap', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  const marks = card.getByRole('textbox', {
    name: m.question_ui_part_marks(),
  });
  await expect(marks).toHaveValue('1');
  await marks.press('ArrowUp');
  await expect(marks).toHaveValue('2');
  // Past the cap is not marks: it goes back to them on leaving.
  await marks.fill('25');
  await expect(marks).toHaveAttribute('aria-invalid', 'true');
  await marks.blur();
  await expect(marks).toHaveValue('2');
  await marks.fill('20');
  await marks.press('ArrowUp');
  await expect(marks).toHaveValue('20');
  await marks.fill('1');
  await marks.press('ArrowDown');
  await expect(marks).toHaveValue('1');
});

// Correct answers are marked beside each option, as Canvas does (Epo
// 2026-11-15): a single choice's radio.
test('a multiple choice option is marked correct with its toggle', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  const first = card.getByRole('radio', {
    name: m.question_ui_mark_correct({ number: 1 }),
  });
  const second = card.getByRole('radio', {
    name: m.question_ui_mark_correct({ number: 2 }),
  });
  await expect(first).toHaveAttribute('aria-checked', 'true');
  await second.click();
  await expect(second).toHaveAttribute('aria-checked', 'true');
  await expect(first).toHaveAttribute('aria-checked', 'false');
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'true');
  await expect(second).toHaveAttribute('aria-checked', 'false');
});

// A question's table edits as a note's table does (Epo 2026-11-15): the + bar
// past the last column adds one, a row's pill opens its menu.
test('a table adds a column and removes a row from its own controls', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  await insert(page, card, m.question_ui_table());
  const dialog = page.getByRole('dialog', { name: m.question_ui_table() });
  const cell = (row: number, column: number) =>
    dialog.getByRole('button', {
      name: m.question_ui_edit_cell({ column, row }),
    });
  // A new table is two rows of two.
  await expect(cell(2, 2)).toBeVisible();
  await dialog
    .getByRole('button', { exact: true, name: m.editor_insert_col_after() })
    .click();
  await expect(cell(1, 3)).toBeVisible();
  await dialog
    .getByRole('button', { exact: true, name: m.editor_row() })
    .nth(1)
    .click();
  await page
    .getByRole('menuitem', { exact: true, name: m.editor_delete_row() })
    .click();
  await expect(cell(2, 1)).toHaveCount(0);
  await expect(cell(1, 3)).toBeVisible();
});

// A note's quiz block in Edit shows the quiz page's cards in place of the
// question dialog (Epo 2026-11-15): an edit in its open card keeps the embed,
// and the card with it, mounted.
test('a quiz embedded in a note keeps its open card through an edit', async ({
  page,
}) => {
  // A note of many blocks and embeds, opened live.
  test.slow();
  const note = await openEditorNote(page, 'mat_note_1', 'Self-check');
  // The block's quiz opens as it nears the screen.
  await note
    .getByRole('heading', { name: 'Self-check' })
    .scrollIntoViewIfNeeded();
  const quiz = page.locator('[data-note-quiz]').first();
  await quiz
    .getByRole('button', {
      exact: true,
      name: m.question_ui_edit_question_number({ number: 1 }),
    })
    .click({ timeout: 30_000 });
  const card = quiz.locator('[data-question-open]');
  await expect(card).toBeVisible();
  await card.getByText('Cellular respiration transfers energy').first().click();
  const text = card
    .getByRole('textbox', { name: m.question_ui_text_and_formulas() })
    .first();
  await expect(text).toBeVisible();
  // The edit reprojects the quiz and refetches its read, which the note's
  // footer also observes: the embed, and its open card, stay mounted.
  const refetch = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/quizzes/mat_embed_bio_note_quiz') &&
      response.ok()
  );
  await page.keyboard.type(' Extra');
  await refetch;
  await expect(card).toBeVisible();
  await expect(text).toContainText('Extra');
});

/** Add part on a question of one part: in the card's ⋮, as the footer's
 * button is only once it has parts. */
async function addPart(page: Page, card: Locator) {
  await card
    .getByRole('button', {
      name: m.quiz_editor_question_actions({ number: 1 }),
    })
    .click();
  await menuItem(page, m.question_ui_add_part()).click();
}

/** A row of the ⋮ menu open over the card. */
function menuItem(page: Page, name: string) {
  return page.getByRole('dialog').getByRole('button', { exact: true, name });
}

// Add part only adds a part (Epo 2026-11-16): the new part shows in the
// question, open in place.
test('adding a part shows it in the question, open in place', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  await addPart(page, card);
  await expect(card.locator('[data-part-id]')).toHaveCount(2);
  await expect(
    card.getByRole('button', { name: m.question_ui_actions({ label: '(b)' }) })
  ).toBeVisible();
});

// Sub-parts (Epo 2026-11-16): a part's ⋮ has Add sub-part, which keeps it as
// (i) and opens (ii); the group's ⋮ adds more and Ungroup keeps its parts.
test('a part takes sub-parts, and its group ungroups keeping them', async ({
  page,
}) => {
  const card = await openQuestionCard(page, '/materials/qz_2');
  const parts = card.locator('[data-part-id]');
  await addPart(page, card);
  await card
    .getByRole('button', { name: m.question_ui_actions({ label: '(b)' }) })
    .click();
  await menuItem(page, m.question_ui_add_sub_part()).click();
  await expect(card.locator('[data-group-id]')).toHaveCount(1);
  await expect(parts).toHaveCount(3);
  await expect(card.locator('[data-group-id]')).toContainText('(ii)');
  const groupMenu = card.getByRole('button', {
    name: m.question_ui_actions({ label: '(b)' }),
  });
  await groupMenu.first().click();
  await menuItem(page, m.question_ui_add_sub_part()).click();
  await expect(parts).toHaveCount(4);
  await groupMenu.first().click();
  await menuItem(page, m.question_ui_ungroup()).click();
  await expect(card.locator('[data-group-id]')).toHaveCount(0);
  await expect(parts).toHaveCount(4);
});
