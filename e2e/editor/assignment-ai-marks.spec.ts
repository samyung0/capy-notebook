import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// Epo 2026-11-03: what the AI has not marked reads Not marked until the owner
// runs it; its marks wait for approval, and Approve all takes a question's.
test('Mark with AI fills the waiting marks, and Approve all takes them', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_paper&tab=approve'
  );
  const list = page.locator('li button');
  await expect(list.first()).toContainText(m.assignment_not_marked(), {
    timeout: 60_000,
  });
  const approveAll = page.getByRole('button', {
    exact: true,
    name: m.assignment_approve_all(),
  });
  await expect(approveAll).toBeDisabled();

  await page
    .getByRole('button', { exact: true, name: m.assignment_mark_with_ai() })
    .click();
  await expect(list.first()).toContainText(m.assignment_col_ai(), {
    timeout: 15_000,
  });
  await expect(approveAll).toBeEnabled();

  await approveAll.click();
  await expect(list.first()).not.toContainText(m.assignment_col_ai(), {
    timeout: 15_000,
  });
  await expect(list.filter({ hasText: m.assignment_not_marked() })).toHaveCount(
    0
  );
});
