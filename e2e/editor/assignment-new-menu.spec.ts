import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/** Assignments' New menu (Epo 2026-11-14): Assignment opens the form, with
 * Points and no Quiz field; Graded quiz opens New graded quiz on its
 * Settings step (Epo 2026-11-16: settings first, then questions). */

async function pickNew(page: Page, item: string) {
  await page.goto('/workspaces/ws_bio?study=assignments');
  await page
    .getByRole('button', { name: m.assignment_new_menu() })
    .first()
    .click({ timeout: 60_000 });
  await page.getByRole('menuitem', { exact: true, name: item }).click();
}

test('Assignment opens the form with Points and no Quiz field', async ({
  page,
}) => {
  await pickNew(page, m.assignment_kind_assignment());
  const dialog = page.getByRole('dialog', { name: m.assignment_new() });
  await expect(dialog.getByLabel(m.assignment_field_points())).toBeVisible();
  await expect(dialog.getByText(m.assignment_field_quiz())).toHaveCount(0);
});

test('Graded quiz opens New graded quiz on its Settings step', async ({
  page,
}) => {
  await pickNew(page, m.assignment_kind_marked());
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(m.assignment_new_graded_quiz())).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: m.action_next() })
  ).toBeVisible();
  await expect(dialog.getByLabel(m.assignment_field_title())).toBeVisible();
});
