import { expect, test } from '@playwright/test';
import { officeEditMenu } from '../helpers/office';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// A press in an Office document with no edit is no pending input: the header
// stays Saved and the View/Edit switch stays enabled while it is held.
for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['xlsx', 'course-guide.xlsx'],
  ['pptx', 'lecture.pptx'],
] as const) {
  test(`a ${format} press with no edit leaves the save state and the mode switch alone`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/workspaces/ws_bio');
    await showPanelView(page, m.workspace_tab_files());
    await page
      .locator(
        `[data-workspace-file-tree] a[href*="file=bio-office-${format}"]`
      )
      .click();
    await expect(
      page.getByRole('heading', { exact: true, name })
    ).toBeVisible();
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    const mode = page.getByRole('button', { name: m.material_mode() });
    await mode.click();
    await expect(officeEditMenu(page, format)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    await expect(mode).toBeEnabled();

    // Every save state and mode-switch state the header shows from here on.
    await mode.evaluate((button) =>
      button.setAttribute('data-press-probe', '')
    );
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { pressSeen: string[] }).pressSeen = seen;
      const status = document.querySelector(
        '[data-testid="editor-save-state"]'
      )!;
      const toggle =
        document.querySelector<HTMLButtonElement>('[data-press-probe]')!;
      const record = () =>
        seen.push(
          `${status.getAttribute('data-save-state')}|${toggle.disabled ? 'disabled' : 'enabled'}`
        );
      const observer = new MutationObserver(record);
      observer.observe(status, {
        attributeFilter: ['data-save-state'],
        attributes: true,
      });
      observer.observe(toggle, {
        attributeFilter: ['disabled'],
        attributes: true,
      });
    });
    const box = await frame.locator('canvas').first().boundingBox();
    if (!box) throw new Error('Missing document canvas');
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + Math.min(box.height / 3, 200)
    );
    await page.mouse.down();
    // Long enough for the runtime's report to reach the header.
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(
        () => (window as unknown as { pressSeen: string[] }).pressSeen
      )
    ).toEqual([]);
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    await expect(mode).toBeEnabled();
  });
}
