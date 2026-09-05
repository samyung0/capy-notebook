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
