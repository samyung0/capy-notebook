import { expect, type Page, test } from '@playwright/test';
import { officeEditMenu } from '../helpers/office';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

declare global {
  interface Window {
    openGeometry?: () => void;
  }
}

const TITLE = '交流學習團活動計劃書';

/*
 * A click right after a DOCX opens, and typing straight after it, as in Google
 * Docs: the click takes the caret and the typing lands there. The editor gets
 * the page geometry from its layout module, a moment after the pages paint, and
 * this holds that module back until the typing is done, so the click always
 * lands in that moment.
 */
async function openInEditWithoutGeometry(page: Page) {
  await page.addInitScript(() => {
    const gate = new Promise<void>((open) => {
      window.openGeometry = open;
    });
    const instantiate = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (source, imports) => {
      const response = await source;
      if (response.url.includes('docx_layout')) await gate;
      return instantiate.call(WebAssembly, response, imports);
    };
  });
  await page.goto('/workspaces/ws_bio');
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-docx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 60_000 });
  await expect(frame.locator('canvas[data-page-index]').first()).toBeVisible({
    timeout: 60_000,
  });
  return frame;
}

for (const scrolled of [false, true]) {
  test(`a DOCX click right after opening takes the caret, and typing lands there${scrolled ? ', the page scrolled meanwhile' : ''}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const frame = await openInEditWithoutGeometry(page);
    const input = frame.getByTestId('yrs-input');
    const box = await frame
      .locator('canvas[data-page-index]')
      .first()
      .boundingBox();
    if (!box) throw new Error('The first page is not drawn');
    // The title line of the fixture's first page.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.3);
    await expect(input).toHaveAttribute('data-pointer-placement', 'pending');
    await expect(input).toBeFocused();
    await input.press('End');
    await page.keyboard.type('QFIRST', { delay: 20 });
    if (scrolled) await page.mouse.wheel(0, 400);
    const typed = frame.getByRole('paragraph').filter({ hasText: 'QFIRST' });
    await expect(typed).toHaveCount(0);

    await input.evaluate(() => window.openGeometry?.());
    await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
      timeout: 30_000,
    });
    await expect
      .poll(async () =>
        (await typed.allInnerTexts()).map((text) => text.replaceAll('\n', ''))
      )
      .toEqual([`${TITLE}QFIRST`]);
  });
}
