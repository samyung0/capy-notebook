import type { Page } from '@playwright/test';

export async function openWorkspaceMaterial(
  page: Page,
  workspaceId: string,
  materialId: string,
  shared = false
) {
  const base = shared
    ? `/share/workspaces/${workspaceId}`
    : `/workspaces/${workspaceId}`;
  await page.goto(`${base}?material=${encodeURIComponent(materialId)}`);
}
