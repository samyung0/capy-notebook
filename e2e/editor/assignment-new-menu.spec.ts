import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/** Assignments' New menu (Epo 2026-11-14): Assignment opens the form, with
 * Points and no Quiz field; Graded quiz opens New graded quiz on its ways as
 * cards (Epo 2026-11-20, board B), Existing file first, Settings coming after
 * the pick (Epo 2026-11-20). */

async function pickNew(page: Page, item: string) {
  await page.goto('/workspaces/ws_bio/assignments');
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

test('Graded quiz opens New graded quiz on its ways, Settings after the pick', async ({
  page,
}) => {
  await pickNew(page, m.assignment_kind_marked());
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(m.assignment_new_graded_quiz())).toBeVisible();
  await dialog
    .getByRole('button', { name: m.assignment_tab_existing() })
    .click();
  // The way's step is under its name.
  await expect(
    dialog.getByRole('heading', { name: m.assignment_tab_existing() })
  ).toBeVisible();
  await dialog.getByRole('radio', { name: /lecture\.pptx/ }).click();
  await dialog.getByRole('button', { name: m.action_next() }).click();
  // Settings starts on the file's name, its Points beside Marking.
  await expect(dialog.getByLabel(m.assignment_field_title())).toHaveValue(
    'lecture'
  );
  await expect(dialog.getByLabel(m.assignment_field_points())).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: m.assignment_create() })
  ).toBeVisible();
});
