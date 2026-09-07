import type { Page } from '@playwright/test';

export async function openWorkspaceMaterial(
  page: Page,
  workspaceId: string,
  materialId: string,
  _shared = false
) {
  // Shared roles still open authenticated app content.
  const base = `/workspaces/${workspaceId}`;
  await page.goto(`${base}?material=${encodeURIComponent(materialId)}`);
}

/** Sharing controls moved into the workspace settings dialog's Sharing tab. */
export async function openWorkspaceSharing(page: Page) {
  await page.getByRole('button', { name: 'Workspace settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { exact: true, name: 'Sharing' }).click();
}
