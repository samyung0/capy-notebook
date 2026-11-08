import { expect, test } from '@playwright/test';
import { m } from '../i18n';

const PAGE = 'e2e/fixtures/files/images/flat.png';

// Epo 2026-11-08 (S4, S5): an assignment that takes uploads asks how in Before
// you start; Upload file shows the questions read only and Your paper, whose
// files number their pages across the paper and can be removed.
test('a member hands in a paper: pages in order, one removed, submitted', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_upload');
  await page
    .getByRole('button', { exact: true, name: m.assignment_upload_file() })
    .click({ timeout: 30_000 });
  await page.getByRole('button', { name: m.sharing_notice_ok() }).click();
  await expect(
    page.getByRole('button', { name: m.assignment_paper_add() })
  ).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file]').first().setInputFiles([PAGE, PAGE]);
  await expect(page.locator('[data-paper-page="2"]')).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', {
      name: m.assignment_paper_remove_file({ name: 'flat.png' }),
    })
    .first()
    .click();
  await expect(page.locator('[data-paper-page]')).toHaveCount(1);
  // A question reads on its own, with nowhere to type.
  await page.locator('[data-question-row]').nth(1).click();
  await expect(page.getByText(m.assignment_paper_on_paper())).toBeVisible();
  await expect(page.getByPlaceholder(m.question_ui_type_answer())).toHaveCount(
    0
  );
  await page
    .getByRole('button', { exact: true, name: m.assignment_submit() })
    .first()
    .click();
  await expect(page.getByText(m.assignment_submit_paper_one())).toBeVisible();
});

// T1: Approve shows the pages a part was found on, the whole paper a click away.
test("staff read a part's pages of the paper in Approve", async ({ page }) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_upload&tab=approve'
  );
  await expect(
    page.getByText(m.assignment_paper_page({ page: 1 }))
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-paper-page="1"] img')).toBeVisible();
});
