import { expect, test } from '@playwright/test';
import { m } from '../i18n';

const PAGE = 'e2e/fixtures/files/images/flat.png';

// Epo 2026-11-08 (S3): an unmarked assignment that takes files collects the
// member's work under Your work, and Hand in replaces Mark as done. Hand in
// asks first and is final (Epo 2026-11-25): no Undo, no Add files after.
test('a member adds their work and hands it in', async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await page.goto('/workspaces/ws_bio/assignments?assignment=as_lab');
  await expect(
    page.getByRole('button', { name: m.assignment_paper_add() })
  ).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file]').setInputFiles(PAGE);
  await expect(page.getByRole('button', { name: 'flat.png' })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', { exact: true, name: m.assignment_hand_in() })
    .click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText(m.assignment_hand_in_confirm_one());
  await confirm
    .getByRole('button', { exact: true, name: m.assignment_hand_in() })
    .click();
  await expect(
    page.getByRole('button', { exact: true, name: m.assignment_hand_in() })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: m.assignment_paper_add() })
  ).toHaveCount(0);
});

// T2: Grading (Responses and Grading in one since Epo 2026-11-25) says who
// handed in what, and a file opens in a new tab.
test('staff open what a member handed in', async ({ page }) => {
  await page.goto(
    '/workspaces/ws_bio/assignments?assignment=as_lab&tab=grading'
  );
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_grading() })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_responses() })
  ).toHaveCount(0);
  // A PDF opens its signed link in a new tab (Epo 2026-11-19).
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: m.media_open_new_tab() }).click();
  await (await opened).close();
});
