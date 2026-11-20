import type { Page } from '@playwright/test';
import { m } from '../i18n';

/** A class member opens one of ws_bio's assignments by its link, the class's
 * sharing notice (told once) dismissed first on the list: on the assignment
 * itself the notice and Before you start are two dialogs that open in either
 * order, the later one over the other. Set the member scenario first. */
export async function openAssignmentAsMember(page: Page, assignmentId: string) {
  const list = '/workspaces/ws_bio/assignments';
  await page.goto(list);
  await page
    .getByRole('button', { name: m.sharing_notice_ok() })
    .click({ timeout: 30_000 });
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `${list}?assignment=${assignmentId}`);
}

/** Opens a timed paper as above and presses Start in Before you start, which
 * opens by itself. The page behind it has a Start of its own, for a start that
 * failed, so the press is the dialog's. */
export async function startAssignmentAsMember(
  page: Page,
  assignmentId: string
) {
  await openAssignmentAsMember(page, assignmentId);
  await page
    .getByRole('dialog')
    .getByRole('button', { exact: true, name: m.assignment_start() })
    .click({ timeout: 30_000 });
}
