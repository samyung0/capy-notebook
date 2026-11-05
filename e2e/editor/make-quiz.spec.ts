import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Make a quiz on the mock (one dialog from the files to the questions found, then the
// upload panel): the mock reads a paper at about a question a second and saves the quiz
// hidden from members.
const dialog = (page: Page) => page.getByRole('dialog');
const pageSheet = (page: Page, number: number) =>
  page.locator(`[role=group]:not([hidden]) [data-page-sheet="${number}"]`);

/** A two-page PDF with nothing on its pages. */
function emptyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function pickPages(page: Page, ...numbers: number[]) {
  for (const number of numbers) await pageSheet(page, number).click();
}

// The MSW User scenarios panel floats over the footer's corner.
async function extract(page: Page) {
  await page.addStyleTag({
    content: '[data-testid=mock-scenario-panel] { display: none }',
  });
  await page.getByRole('button', { name: m.make_quiz_extract() }).click();
}

/** The questions found, confirmed: the dialog goes and the panel follows the run. */
async function confirmQuestions(page: Page) {
  await dialog(page)
    .getByRole('button', { name: m.make_quiz_make() })
    .click({ timeout: 30_000 });
  await expect(page.getByTestId('source-transfer-panel')).toBeVisible();
}

test('a paper and its mark scheme become a hidden quiz, open in its editor', async ({
  page,
}) => {
  // The whole flow over the mock's latency, and its run.
  test.slow();
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { name: m.dashboard_make_quiz() })
    .click({ timeout: 30_000 });
  await expect(
    dialog(page).getByRole('button', { name: m.action_continue() })
  ).toBeDisabled();

  await dialog(page)
    .getByRole('button', { name: m.make_quiz_choose_file() })
    .click();
  await page.getByRole('option', { name: /Past paper 2025 P1\.pdf/ }).click();
  await dialog(page)
    .getByRole('button', { name: m.make_quiz_add_file() })
    .last()
    .click();
  await page.getByRole('option', { name: /mark scheme/ }).click();
  await dialog(page).getByRole('button', { name: m.action_continue() }).click();

  await expect(
    page.getByRole('heading', { name: m.make_quiz_pages_title() })
  ).toBeVisible();
  await pickPages(page, 2, 3, 4);
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 3, max: 40 }))
  ).toBeVisible();
  // A second click skips the page again.
  await pickPages(page, 4);
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 2, max: 40 }))
  ).toBeVisible();
  // An answer file holds the run until a page of it is picked, and counts.
  await expect(
    page.getByRole('button', { name: m.make_quiz_extract() })
  ).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /mark scheme/ })
    .click();
  await expect(
    page.getByRole('heading', { name: m.make_quiz_answers_title() })
  ).toBeVisible();
  await pickPages(page, 1);
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 3, max: 40 }))
  ).toBeVisible();
  await expect(
    page.getByText(m.make_quiz_question_price({ price: 4 }))
  ).toBeVisible();

  await extract(page);
  await expect(
    page.getByRole('heading', { name: m.make_quiz_reading_title() })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: m.make_quiz_found_title({ count: 12 }) })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dialog(page).getByText(m.make_quiz_price_total({ count: 48 }))
  ).toBeVisible();
  await confirmQuestions(page);
  await page
    .getByRole('button', { name: m.make_quiz_open_quiz() })
    .click({ timeout: 60_000 });

  await expect(page).toHaveURL(/material=/, { timeout: 30_000 });
  await expect(page.getByTestId('hidden-chip')).toBeVisible();
  await expect(page.locator('[data-question-row]')).toHaveCount(12, {
    timeout: 30_000,
  });
  // Question 7 waits for its image, as a normal quiz issue.
  await page.locator('[data-question-row]').nth(6).click();
  await expect(page.getByRole('status').getByText(/Image/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: m.quiz_editor_choose_image() })
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: m.question_ui_correct_answer() })
  ).toHaveValue('Metaphase');
});

test("the browser's Back walks the dialog's steps", async ({ page }) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { name: m.dashboard_make_quiz() })
    .click({ timeout: 30_000 });
  await dialog(page)
    .getByRole('button', { name: m.make_quiz_choose_file() })
    .click();
  await page.getByRole('option', { name: /Past paper 2025 P1\.pdf/ }).click();
  await dialog(page).getByRole('button', { name: m.action_continue() }).click();
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await expect(page).toHaveURL(/make=pages/);
  await page.goBack();
  await expect(page).toHaveURL(/make=files/);
  await expect(
    dialog(page).getByRole('button', { name: m.make_quiz_change() })
  ).toBeVisible();
  await page.goForward();
  await expect(pageSheet(page, 2)).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await page.goBack();
  await expect(dialog(page)).toHaveCount(0);
});

test('Change files keeps the picks of files left in', async ({ page }) => {
  await page.goto(
    '/workspaces/ws_bio?make=pages&paper=f_paper_2025&answers=f_paper_scheme'
  );
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await page.getByRole('button', { name: m.make_quiz_change_files() }).click();
  await dialog(page)
    .getByRole('button', {
      name: m.make_quiz_remove_file({
        name: 'Past paper 2025 P1 mark scheme.pdf',
      }),
    })
    .click();
  await dialog(page).getByRole('button', { name: m.action_continue() }).click();
  await expect(pageSheet(page, 2)).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: m.make_quiz_extract() })
  ).toBeEnabled();
});

test('cancelling the questions found goes back to the picks', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_2025');
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await extract(page);
  await dialog(page)
    .getByRole('button', { name: m.action_cancel() })
    .click({ timeout: 30_000 });
  await expect(pageSheet(page, 2)).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
});

test('credits short of the questions found offer the ones they afford', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('capy:mock-quiz-credits', '21')
  );
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_2025');
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await extract(page);
  await expect(
    dialog(page).getByText(m.make_quiz_enough({ count: 5 }))
  ).toBeVisible({ timeout: 30_000 });
  await dialog(page)
    .getByRole('button', { name: m.make_quiz_make_count({ count: 5 }) })
    .click();
  await expect(page.getByTestId('source-transfer-panel')).toBeVisible();
});

test('an answer file that failed to read is named, and the run goes on', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?make=pages&paper=f_paper_2025&answers=f_scheme_unread'
  );
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await extract(page);
  await expect(
    dialog(page).getByText(
      m.make_quiz_found_unread({ names: 'Unreadable mark scheme.pdf' })
    )
  ).toBeVisible({ timeout: 30_000 });
});

test('an edit on the page reaches the question list', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_2025');
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await extract(page);
  await confirmQuestions(page);
  await page
    .getByRole('button', { name: m.make_quiz_open_quiz() })
    .click({ timeout: 60_000 });
  await expect(page.locator('[data-question-row]')).toHaveCount(12, {
    timeout: 40_000,
  });
  await page.locator('[data-question-row]').nth(1).click();
  await page
    .getByRole('region', { name: m.quiz_editor_question({ number: 2 }) })
    .getByRole('button', { name: /State the function/ })
    .click();
  await page.keyboard.type(' Name it.');
  await expect(page.locator('[data-question-row]').nth(1)).toContainText(
    'Name it.'
  );
});

test('a failed run says so in the panel and goes back to the pages', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_fails');
  await pageSheet(page, 1).click({ timeout: 30_000 });
  await extract(page);
  await confirmQuestions(page);
  await page
    .getByRole('button', { name: m.make_quiz_try_again() })
    .click({ timeout: 30_000 });
  await expect(pageSheet(page, 1)).toBeVisible({ timeout: 30_000 });
});

test('a run takes at most 40 pages', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_long');
  await expect(pageSheet(page, 60)).toBeAttached({ timeout: 30_000 });
  await pickPages(page, ...Array.from({ length: 40 }, (_, i) => i + 1));
  await expect(page.getByText(m.make_quiz_at_cap())).toBeVisible();
  await pageSheet(page, 41).click({ force: true });
  await expect(pageSheet(page, 41)).toHaveAttribute('aria-pressed', 'false');
});

test('an uploaded paper is read first, and saved to Files hidden from members', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { name: m.dashboard_make_quiz() })
    .click({ timeout: 30_000 });
  await dialog(page)
    .getByRole('button', { name: m.make_quiz_choose_file() })
    .click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: m.make_quiz_upload_file() }).click();
  await (await chooser).setFiles({
    buffer: emptyPdf(),
    mimeType: 'application/pdf',
    name: 'new paper.pdf',
  });
  const next = dialog(page).getByRole('button', {
    name: m.action_continue(),
  });
  await expect(next).toBeDisabled();
  await expect(next).toBeEnabled({ timeout: 30_000 });
  const saved = await page.evaluate(async () => {
    const files = await (await fetch('/api/workspaces/ws_bio/files')).json();
    return files.find((row: { name: string }) => row.name === 'new paper.pdf');
  });
  expect(saved).toMatchObject({ hidden: true, topicId: null });
});

test('several question files share the 40 pages, and the list divides them from the answers', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?make=pages&paper=f_paper_2025%2Cf_paper_2024&answers=f_paper_scheme'
  );
  const list = dialog(page).getByRole('navigation');
  await expect(list.getByText(m.make_quiz_section_questions())).toBeVisible({
    timeout: 30_000,
  });
  await expect(list.getByText(m.make_quiz_section_answers())).toBeVisible();
  await pageSheet(page, 1).click();
  await list.getByRole('button', { name: /Past paper 2024/ }).click();
  await pageSheet(page, 1).click();
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 2, max: 40 }))
  ).toBeVisible();
});
