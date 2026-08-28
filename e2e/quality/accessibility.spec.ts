import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';

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

test.describe('representative accessibility surfaces', () => {
  test('owner dashboard passes automated WCAG A/AA checks', async ({
    ownerPage,
  }) => {
    await ownerPage.goto('/');
    await expect(ownerPage.locator('main')).toBeVisible();
    await expectNoAutomatedAccessibilityViolations(ownerPage);
  });

  test('private workspace and sharing dialog pass automated checks', async ({
    ownerPage,
    seed,
  }) => {
    await ownerPage.goto(`/workspaces/${seed.privateWorkspace.id}`);
    await expect(
      ownerPage.getByRole('heading', { name: seed.privateWorkspace.name })
    ).toBeVisible();
    await expectNoAutomatedAccessibilityViolations(ownerPage);

    await ownerPage.getByRole('button', { name: 'Share' }).click();
    await expect(ownerPage.getByRole('dialog')).toBeVisible();
    await expectNoAutomatedAccessibilityViolations(ownerPage);
  });

  test('public shared workspace passes automated checks', async ({
    anonymousPage,
    seed,
  }) => {
    await anonymousPage.goto(`/share/workspaces/${seed.publicWorkspace.id}`);
    await expect(
      anonymousPage.getByRole('heading', { name: seed.publicWorkspace.name })
    ).toBeVisible();
    await expectNoAutomatedAccessibilityViolations(anonymousPage);
  });

  test('core workspace reflows at a 320 CSS-pixel viewport', async ({
    ownerPage,
    seed,
  }) => {
    await ownerPage.setViewportSize({ height: 800, width: 320 });
    await ownerPage.goto(`/workspaces/${seed.privateWorkspace.id}`);
    await expect(ownerPage.locator('main')).toBeVisible();

    const overflow = await ownerPage.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
