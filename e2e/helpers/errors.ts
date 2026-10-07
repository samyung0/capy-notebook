import { expect, type Page } from '@playwright/test';

export async function expectErrorSurface(
  page: Page,
  variant: 'page' | 'panel',
  kind?: string,
  timeout?: number
) {
  const surface = page.locator(
    `[data-error-surface="${variant}"][role="alert"]`
  );
  await expect(surface).toBeVisible({ timeout });
  if (kind) await expect(surface).toHaveAttribute('data-error-kind', kind);
  return surface;
}
