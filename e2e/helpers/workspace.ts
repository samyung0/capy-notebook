import type { Page } from '@playwright/test';
import { sharePath } from '../../src/lib/shareLink';
import { m } from '../i18n';

export async function openWorkspaceMaterial(
  page: Page,
  workspaceId: string,
  materialId: string,
  _shared = false
) {
  // Each reader gets the highest mode they may have.
  const base = `/workspaces/${workspaceId}`;
  await page.goto(`${base}?material=${encodeURIComponent(materialId)}`);
}

/** Workspace settings from the workspace rail's avatar menu, at lg. */
export async function openWorkspaceSettings(page: Page) {
  await page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { name: m.workspace_account_menu() })
    .click();
  await page
    .getByRole('menuitem', { exact: true, name: m.workspace_settings() })
    .click();
}

/** Sharing and invitations are on the workspace's Members page, from the rail
 * at lg. A class's owner and teaching assistants find them on its Manage tab
 * (`manage`). */
export async function openWorkspaceSharing(page: Page, manage = false) {
  await page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { exact: true, name: m.study_panel_members() })
    .click();
  if (manage)
    await page
      .getByRole('tab', { exact: true, name: m.members_tab_manage() })
      .click();
}

/** Signed /w/ summary path, using the secret playwright.config.ts generated. */
export function summaryPath(workspaceId: string) {
  return sharePath(process.env.SHARE_LINK_SECRET!, workspaceId);
}
