import { expect, test } from '@playwright/test';
import { startAssignmentAsMember } from '../helpers/assignments';
import { m } from '../i18n';

// Epo 2026-11-05: staff closing an assignment ends the attempt open on a member's
// page, which submits what it holds and shows its results.
test('closing an assignment ends the attempt open on the page, keeping its answers', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await startAssignmentAsMember(page, 'as_paper');
  await expect(page.locator('[data-assignment-take]')).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator('[data-assignment-take]')
    .getByText('Mitochondria', { exact: true })
    .click();
  // Inside the wait before answers save: only the page holds this one.
  await page.evaluate(() =>
    fetch('/api/assignments/as_paper/closed', {
      body: JSON.stringify({ closed: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    })
  );
  await expect(page.locator('[data-assignment-take]')).toHaveCount(0, {
    timeout: 30_000,
  });
  // Its one mark (of the paper's 77) is the answer only the page held.
  await expect(page.getByText('1 / 77')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: m.assignment_submitted() })
  ).toHaveCount(0);
  await expect(page.getByText(m.assignment_auto_submitted())).toHaveCount(0);
});
