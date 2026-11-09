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

/** Sharing controls moved into the workspace settings dialog's Sharing tab. */
export async function openWorkspaceSharing(page: Page) {
  await openWorkspaceSettings(page);
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('tab', { exact: true, name: m.workspace_sharing() })
    .click();
}

/** Signed /w/ summary path, using the secret playwright.config.ts generated. */
export function summaryPath(workspaceId: string) {
  return sharePath(process.env.SHARE_LINK_SECRET!, workspaceId);
}
