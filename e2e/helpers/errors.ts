import { expect, type Page } from '@playwright/test';

export async function expectErrorSurface(
  page: Page,
  variant: 'page' | 'panel',
  text?: string | RegExp,
  timeout?: number
) {
  const surface = page.locator(
    `[data-error-surface="${variant}"][role="alert"]`
  );
  await expect(surface).toBeVisible({ timeout });
  if (text) await expect(surface).toContainText(text);
  return surface;
}
