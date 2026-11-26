import { expect, test } from '@playwright/test';
import { openAssignmentAsMember, pressStart } from '../helpers/assignments';
import { m } from '../i18n';

const PAGE = 'e2e/fixtures/files/images/flat.png';

// Epo 2026-11-08 (S4, S5; S2 and the list 2026-11-19): an assignment that takes
// uploads asks how when Start is pressed; Upload shows every question read only
// beside Your answers, whose files can be removed.
test('a member hands in a paper: two files, one removed, submitted', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await openAssignmentAsMember(page, 'as_upload');
  await pressStart(page);
  const before = page.getByRole('dialog');
  await before
    .getByRole('radio', { name: m.assignment_mode_upload() })
    .click({ timeout: 30_000 });
  await before
    .getByRole('button', { exact: true, name: m.assignment_start() })
    .click();
  await expect(
    page.getByRole('button', { name: m.assignment_paper_add() })
  ).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file]').first().setInputFiles([PAGE, PAGE]);
  // The desktop panel: the phone's copy is hidden.
  const files = page
    .getByRole('region', { name: m.assignment_your_answers() })
    .getByRole('listitem');
  await expect(files).toHaveCount(2, { timeout: 15_000 });
  await files.first().getByRole('button', { name: m.a11y_open_menu() }).click();
  await page
    .getByRole('menuitem', { name: m.assignment_hand_in_remove() })
    .click();
  await expect(files).toHaveCount(1);
  // Every question reads on its own, with nowhere to type.
  await expect(page.getByPlaceholder(m.question_ui_type_answer())).toHaveCount(
    0
  );
  await page
    .getByRole('button', { exact: true, name: m.assignment_submit() })
    .first()
    .click();
  await expect(page.getByText(m.assignment_submit_paper_one())).toBeVisible();
});

// T1: Grading shows the pages a part was found on, under the paper's file by
// name, which opens its signed link (Epo 2026-11-19).
test("staff read a part's pages of the paper in Grading", async ({ page }) => {
  await page.goto(
    '/workspaces/ws_bio/assignments?assignment=as_upload&tab=grading'
  );
  await expect(
    page.getByRole('button', { exact: true, name: 'Mock exam scan.jpg' })
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-paper-page="1"] img')).toBeVisible();
});
