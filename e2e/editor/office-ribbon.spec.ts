import { expect, type Page, test } from '@playwright/test';
import {
  officeEditMenu,
  officeMenuBar,
  officeTab,
  ribbonCommand,
  runRibbonCommand,
  saveOffice,
} from '../helpers/office';
import { m } from '../i18n';

const frameOf = (page: Page) =>
  page.frameLocator('iframe[src*="office-runtime"]');
const tabLine = (page: Page) =>
  page.getByRole('tablist', { name: m.files_office_ribbon_tabs() });
const ribbonBar = (page: Page) => frameOf(page).locator('.office-ribbon__bar');
const history = (page: Page) => [
  page.getByRole('button', { name: /^Undo/ }),
  page.getByRole('button', { name: /^Redo/ }),
];

for (const format of ['docx', 'xlsx', 'pptx'] as const) {
  test(`${format}: a viewer sees no ribbon, and Edit always opens on Home with Undo and Redo on the tab line`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto(`/workspaces/ws_bio?file=bio-office-${format}&mode=view`);
    const mode = page.getByRole('button', { name: m.material_mode() });
    await expect(mode).toBeEnabled({ timeout: 120_000 });

    await expect(officeMenuBar(page)).toBeVisible();
    await expect(
      officeMenuBar(page).getByRole('menuitem').first()
    ).toBeVisible();
    await expect(tabLine(page)).toHaveCount(0);
    await expect(frameOf(page).locator('.office-ribbon')).toHaveCount(0);

    await mode.click();
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
    await expect(officeTab(page, 'home')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'home');
    // File stays a menu; the others are tabs.
    await expect(officeMenuBar(page).getByRole('menuitem')).toHaveCount(1);
    for (const button of history(page)) await expect(button).toBeVisible();

    await officeTab(page, 'insert').click();
    await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'insert');
    for (const button of history(page)) await expect(button).toBeVisible();

    // Back through View: Home again.
    await mode.click();
    await expect(tabLine(page)).toHaveCount(0, { timeout: 120_000 });
    await mode.click();
    await expect(officeTab(page, 'home')).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 120_000 }
    );
  });
}

test('collapsed, a tab opens the ribbon over the page until a click elsewhere, a command or its pin', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = frameOf(page);
  const paper = frame.locator('[data-page-index="0"]').first();
  await expect(paper).toBeVisible({ timeout: 120_000 });

  await frame.getByTestId('office-ribbon-collapse').click();
  await expect(ribbonBar(page)).toHaveCount(0);
  await expect(page.getByTestId('office-ribbon-expand')).toBeVisible();
  await expect(tabLine(page).getByRole('tab', { selected: true })).toHaveCount(
    0
  );

  await officeTab(page, 'view').click();
  await expect(ribbonBar(page)).toHaveAttribute('data-over', 'true');
  await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'view');
  await paper.click();
  await expect(ribbonBar(page)).toHaveCount(0);

  // So does a click in Capy, outside the frame.
  await officeTab(page, 'view').click();
  await expect(ribbonBar(page)).toBeVisible();
  await page.getByRole('heading', { name: m.workspace_tab_files() }).click();
  await expect(ribbonBar(page)).toHaveCount(0);

  // A command closes it; a dropdown stays open to be picked from.
  await officeTab(page, 'insert').click();
  await ribbonCommand(page, 'insert-table').click();
  await expect(frame.getByRole('gridcell', { name: '2x2' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(ribbonBar(page)).toHaveCount(0);

  await officeTab(page, 'view').click();
  await ribbonCommand(page, 'show-ruler').click();
  await expect(ribbonBar(page)).toHaveCount(0);
  await expect(frame.locator('.docx-horizontal-ruler')).toHaveCount(1);

  // The open tab again closes it, and the pin keeps the ribbon.
  await officeTab(page, 'view').click();
  await expect(ribbonBar(page)).toBeVisible();
  await officeTab(page, 'view').click();
  await expect(ribbonBar(page)).toHaveCount(0);
  await officeTab(page, 'view').click();
  await frame.getByTestId('office-ribbon-collapse').click();
  await expect(ribbonBar(page)).toBeVisible();
  await expect(ribbonBar(page)).not.toHaveAttribute('data-over');
  await paper.click();
  await expect(ribbonBar(page)).toBeVisible();
});

test('a phone keeps one row under the tabs, Undo and Redo in the tab strip', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  for (const button of history(page)) await expect(button).toBeVisible();
  await expect(officeMenuBar(page)).toBeVisible();
  await expect(frameOf(page).locator('.office-ribbon')).toHaveAttribute(
    'data-phone',
    'true'
  );
  await expect(frameOf(page).getByTestId('office-ribbon-collapse')).toHaveCount(
    0
  );
  await expect(ribbonCommand(page, 'new-slide-layout')).toBeVisible();
  // A dropdown in the scrolling row shows.
  await officeTab(page, 'view').click();
  await ribbonCommand(page, 'zoom').click();
  await ribbonCommand(page, 'view.zoom:1').click();
  await expect(ribbonCommand(page, 'zoom')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  // No sideways page scroll from the header.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("a table's contextual tab comes with the caret and goes with it, back to Home", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = frameOf(page);
  await expect(frame.locator('[data-page-index="0"]').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeTab(page, 'table')).toHaveCount(0);

  await runRibbonCommand(page, 'insert', 'insert-table');
  await frame.getByRole('gridcell', { name: '2x2' }).click();
  await officeTab(page, 'table').click();
  await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'table');
  await expect(ribbonCommand(page, 'table-header-row')).toBeEnabled();

  // In the text under the table: the tab leaves.
  await frame
    .locator('[data-page-index="0"]')
    .first()
    .click({ position: { x: 400, y: 300 } });
  await expect(officeTab(page, 'table')).toHaveCount(0);
  await expect(officeTab(page, 'home')).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

test('the strip under the ribbon: a paused source says so, in the frame', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  // Its close button reaches Capy's strip, which the frame only draws.
  const strip = frameOf(page).locator('.office-ribbon .office-banner');
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: m.action_close() }).click();
  await expect(strip).toHaveCount(0);

  await saveOffice(page, 'xlsx');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { announceSourcePaused } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    announceSourcePaused('bio-office-xlsx');
  });
  await expect(strip).toContainText(m.source_edit_paused());
  await expect(page.getByText(m.source_edit_paused())).toHaveCount(0);
});
