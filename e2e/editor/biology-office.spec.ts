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
    if (format === 'pptx') {
      await frame.locator('aside button').nth(2).click();
      const canvas = frame.getByTestId('pptx-slide-canvas');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Missing slide canvas');
      await canvas.click({
        clickCount: 3,
        position: { x: box.width * 0.25, y: box.height * 0.265 },
      });
      const input = frame.getByTestId('pptx-text-input');
      await expect(input).toBeFocused();
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(() =>
        navigator.clipboard.writeText('Clipboard input 日本 😀')
      );
      await input.press('ControlOrMeta+V');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', {
        selectionEnd: 3,
        selectionStart: 3,
        text: '日本語',
      });
      await cdp.send('Input.insertText', { text: '日本語' });
      await cdp.detach();
      await save.click();
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
    }
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 30_000,
    });
    if (format === 'pptx') {
      await frame.getByTestId('pptx-next-slide').click();
      await frame.getByTestId('pptx-next-slide').click();
      await expect(frame.getByRole('region')).toContainText(
        'Clipboard input 日本 😀日本語'
      );
    }

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
