import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Make a quiz on the mock (boards X0a, X0b, X1, X2): the mock reads a paper at
// about a question a second and saves the quiz hidden from members.
const dialog = (page: Page) => page.getByRole('dialog');
const pageSheet = (page: Page, number: number) =>
  page.locator(`[data-page-sheet="${number}"]`);

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
    .click();
  await page.getByRole('option', { name: /mark scheme/ }).click();
  await dialog(page).getByRole('button', { name: m.action_continue() }).click();

  await expect(
    page.getByRole('heading', { name: m.make_quiz_pages_title() })
  ).toBeVisible();
  await expect(page.getByText(m.make_quiz_with_one_file())).toBeVisible();
  await pickPages(page, 2, 3, 4);
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 3, max: 40 }))
  ).toBeVisible();
  await expect(
    page.getByText(m.make_quiz_credits({ count: 30 }))
  ).toBeVisible();
  // A second click skips the page again.
  await pickPages(page, 4);
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 2, max: 40 }))
  ).toBeVisible();

  await extract(page);
  await expect(
    page.getByRole('heading', { name: m.make_quiz_reading_title() })
  ).toBeVisible();

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

test('an edit on the page reaches the question list', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_2025');
  await pageSheet(page, 2).click({ timeout: 30_000 });
  await extract(page);
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

test('a failed run says so and goes back to the pages', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_fails');
  await pageSheet(page, 1).click({ timeout: 30_000 });
  await extract(page);
  await expect(
    page.getByRole('heading', { name: m.make_quiz_failed_title() })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: m.make_quiz_back_to_pages() }).click();
  await expect(pageSheet(page, 1)).toBeVisible({ timeout: 30_000 });
});

test('a run takes at most 40 pages', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?make=pages&paper=f_paper_long');
  await expect(pageSheet(page, 60)).toBeAttached({ timeout: 30_000 });
  await pickPages(page, ...Array.from({ length: 40 }, (_, i) => i + 1));
  await expect(page.getByText(m.make_quiz_at_cap({ max: 40 }))).toBeVisible();
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
