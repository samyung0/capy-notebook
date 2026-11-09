import { expect, test } from '@playwright/test';
import { m } from '../i18n';

const PAGE = 'e2e/fixtures/files/images/flat.png';

// Epo 2026-11-08 (S3): an unmarked assignment that takes files collects the
// member's work under Your work, and Hand in replaces Mark as done.
test('a member adds their work and hands it in', async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_lab');
  await page
    .getByRole('button', { name: m.sharing_notice_ok() })
    .click({ timeout: 30_000 });
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
  await expect(
    page.getByRole('button', { name: m.assignment_undo_hand_in() })
  ).toBeVisible();
});

// T2: the Members tab says who handed in what, and a file opens in the viewer.
test('staff open what a member handed in', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_lab');
  await expect(
    page.getByText(m.assignment_handed_in_of({ done: 4, total: 6 }))
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Lab write-up.pdf' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Lab write-up.pdf' })
  ).toBeVisible();
});
