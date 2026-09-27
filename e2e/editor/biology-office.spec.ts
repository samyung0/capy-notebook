import { expect, test } from '@playwright/test';

for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['xlsx', 'course-guide.xlsx'],
  ['pptx', 'lecture.pptx'],
]) {
  test(`Biology ${format} fixture opens in View/Edit and survives scenario reset`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fileId = `bio-office-${format}`;
    await page.goto('/workspaces/ws_bio');
    await page.getByRole('button', { exact: true, name: 'Files' }).click();
    await page
      .locator(`[data-workspace-file-tree] a[href*="file=${fileId}"]`)
      .click();
    await expect(
      page.getByRole('heading', { exact: true, name })
    ).toBeVisible();
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 30_000,
    });
    if (format === 'xlsx')
      await expect(frame.getByRole('tab', { name: 'Summary' })).toBeVisible();
    if (format === 'pptx')
      await expect(frame.getByRole('region')).toContainText(
        'Rich deck fixture'
      );

    const mode = page.getByRole('button', { name: 'Material mode' });
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    const save = page.getByRole('button', { exact: true, name: 'Save' });
    await expect(save).toBeEnabled({ timeout: 30_000 });
    await save.click();
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved$/ })
    ).toBeVisible();
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 30_000,
    });

    const panel = page.getByTestId('mock-scenario-panel');
    await panel.evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
    await panel.getByRole('button', { exact: true, name: 'Reset' }).click();
    await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
    const fixture = await page.evaluate(async (id) => {
      const links = await fetch(`/api/files/${id}/links`);
      const session = await fetch(`/api/files/${id}/source-session`);
      return {
        sourceURL: (await links.json()).url,
        workspaceId: (await session.json()).workspaceId,
      };
    }, fileId);
    expect(fixture.sourceURL).toContain(`/rich-content/${name}`);
    expect(fixture.workspaceId).toBe('ws_bio');
  });
}
