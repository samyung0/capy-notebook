import type { Page } from '@playwright/test';
import { m } from '../i18n';

/** A class member opens one of ws_bio's assignments by its link. Set the
 * member scenario first. */
export async function openAssignmentAsMember(page: Page, assignmentId: string) {
  await page.goto(`/workspaces/ws_bio/assignments?assignment=${assignmentId}`);
}

/** Presses the assignment page's Start (Epo 2026-11-25: the page waits for
 * it). One answered online only starts; one open to both asks how in a
 * dialog. */
export async function pressStart(page: Page) {
  await page
    .getByRole('button', { exact: true, name: m.assignment_start() })
    .click({ timeout: 30_000 });
}

/** Opens a paper answered online as above and starts it. */
export async function startAssignmentAsMember(
  page: Page,
  assignmentId: string
) {
  await openAssignmentAsMember(page, assignmentId);
  await pressStart(page);
}
