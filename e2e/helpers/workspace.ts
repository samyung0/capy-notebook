import type { Page } from '@playwright/test';
import { sharePath } from '../../src/lib/shareLink';
import { m } from '../i18n';

export async function openWorkspaceMaterial(
  page: Page,
  workspaceId: string,
  materialId: string,
  _shared = false
) {
  // Editor tests request Edit explicitly; shared roles still enforce permissions.
  const base = `/workspaces/${workspaceId}`;
  await page.goto(
    `${base}?material=${encodeURIComponent(materialId)}&mode=edit`
  );
}

/** Sharing controls moved into the workspace settings dialog's Sharing tab. */
export async function openWorkspaceSharing(page: Page) {
  await page
    .getByRole('button', { name: m.workspace_settings() })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('tab', { exact: true, name: m.workspace_sharing() })
    .click();
}

/** Signed /w/ summary path, using the secret playwright.config.ts generated. */
export function summaryPath(workspaceId: string) {
  return sharePath(process.env.SHARE_LINK_SECRET!, workspaceId);
}
