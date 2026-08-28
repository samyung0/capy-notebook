import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support';

const workspaceId = process.env.UAT_FIXTURE_WORKSPACE_ID!;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAutomatedAccessibilityViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  const summary = result.violations.map((violation) => ({
    description: violation.description,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
  expect(summary).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test('UAT dashboard and private workspace pass automated accessibility checks', async ({
  page,
}) => {
  await signIn(page, 'owner');
  await expect(page).not.toHaveURL(/\/sign-in(?:[/?]|$)/);
  await expect(page.locator('main')).toBeVisible();
  await expectNoAutomatedAccessibilityViolations(page);

  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.locator('main')).toBeVisible();
  await expectNoAutomatedAccessibilityViolations(page);
});

test('UAT core workspace reflows at a 320 CSS-pixel viewport', async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 320 });
  await signIn(page, 'owner');
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.locator('main')).toBeVisible();

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
