import { expect, type Locator, type Page, test } from '@playwright/test';
import { OFFICE_PROTOCOL_VERSION } from '../../src/features/files/officeProtocol';
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

test("PPTX's View tab presents in the frame and has Capy open the presenter window", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = frameOf(page);
  await expect(frame.getByTestId('pptx-slide-canvas')).toBeVisible({
    timeout: 120_000,
  });
  const present = () => runRibbonCommand(page, 'view', 'present');

  await present();
  await ribbonCommand(page, 'view.present').click();
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => !!document.fullscreenElement)
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => !!document.fullscreenElement)
    )
    .toBe(false);

  await present();
  const opened = page.waitForEvent('popup');
  await ribbonCommand(page, 'view.presenterView').click();
  const notes = await opened;
  await expect(
    notes.getByRole('main', { name: 'Presenter view' })
  ).toBeVisible();
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

/** A list's box against its frame's window, and whether it scrolls inside. */
const listFit = (list: Locator) =>
  list.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      inside:
        box.top >= 0 &&
        box.left >= 0 &&
        box.bottom <= window.innerHeight &&
        box.right <= window.innerWidth,
      scrolls: node.scrollHeight > node.clientHeight,
    };
  });

test('a list fits a short frame on all sides and scrolls inside', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 600, width: 1600 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await ribbonCommand(page, 'shape').click();
  const list = frameOf(page).locator('.office-ribbon__menu');
  await expect(list).toBeVisible();
  expect(await listFit(list)).toEqual({ inside: true, scrolls: true });
  const last = list.locator('[data-command]').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test('a landscape phone keeps its Zoom list inside the frame', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 280, width: 640 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await officeTab(page, 'view').click();
  await ribbonCommand(page, 'zoom').click();
  const list = frameOf(page).locator('.office-ribbon__menu');
  await expect(list).toBeVisible();
  expect((await listFit(list)).inside).toBe(true);
});

test("a short frame keeps a toolbar box's list inside it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 400, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await officeTab(page, 'view').click();
  await frameOf(page).getByTestId('xlsx-zoom').click();
  const list = frameOf(page).locator('[role="listbox"]');
  await expect(list).toBeVisible();
  expect((await listFit(list)).inside).toBe(true);
});

test('a deck with no slides still has New slide', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const remove = ribbonCommand(page, 'slide.delete');
  await expect(remove).toBeEnabled({ timeout: 120_000 });
  for (let slides = 0; slides < 60 && (await remove.isEnabled()); slides += 1)
    await remove.click();
  await expect(remove).toBeDisabled();
  const add = ribbonCommand(page, 'slide.new');
  await expect(add).toBeVisible();
  await add.click();
  await expect(remove).toBeEnabled();
});

test('PPTX: an armed tool shows as checked and Home can disarm it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1600 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const textBox = ribbonCommand(page, 'insert.textBox');
  await expect(textBox).toBeEnabled({ timeout: 120_000 });
  await textBox.click();
  await expect(textBox).toHaveAttribute('aria-pressed', 'true');
  // Home has Select, as PowerPoint's Home tab.
  await frameOf(page).getByTestId('pptx-tool-select').click();
  await expect(textBox).toHaveAttribute('aria-pressed', 'false');
  // A shape: its row is ticked and its button says so; a second click disarms.
  const shape = ribbonCommand(page, 'shape');
  await shape.click();
  const ellipse = ribbonCommand(page, 'insert.shape:ellipse');
  await ellipse.click();
  await expect(shape).toHaveAttribute('data-checked', 'true');
  await shape.click();
  await expect(ellipse).toHaveAttribute('aria-checked', 'true');
  await ellipse.click();
  await expect(shape).not.toHaveAttribute('data-checked', 'true');
});

test('over the page, a box arrow keeps the ribbon and its list open', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await frameOf(page).getByTestId('office-ribbon-collapse').click();
  await officeTab(page, 'view').click();
  await expect(ribbonBar(page)).toHaveAttribute('data-over', 'true');
  await frameOf(page)
    .getByTestId('xlsx-zoom')
    .locator('xpath=following-sibling::button')
    .click();
  await expect(frameOf(page).locator('[role="listbox"]')).toBeVisible();
  await expect(ribbonBar(page)).toHaveAttribute('data-over', 'true');
});

test('at 360 a new contextual tab and the current tab scroll into view', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = frameOf(page);
  await expect(frame.locator('[data-page-index="0"]').first()).toBeVisible({
    timeout: 120_000,
  });
  await runRibbonCommand(page, 'insert', 'insert-table');
  await frame.getByRole('gridcell', { name: '2x2' }).click();
  await expect(officeTab(page, 'table')).toBeInViewport({ ratio: 0.9 });
  await officeTab(page, 'table').click();
  await frame
    .locator('[data-page-index="0"]')
    .first()
    .click({ position: { x: 150, y: 300 } });
  await expect(officeTab(page, 'table')).toHaveCount(0);
  await expect(officeTab(page, 'home')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(officeTab(page, 'home')).toBeInViewport({ ratio: 0.9 });
});

for (const [format, cell] of [
  ['docx', 'insert-comment'],
  ['xlsx', 'wrapping'],
] as const)
  test(`a phone's ${format} Home is one row of the commands`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ height: 740, width: 360 });
    await page.goto(`/workspaces/ws_bio?file=bio-office-${format}&mode=edit`);
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
    await expect(frameOf(page).locator('.office-ribbon')).toHaveAttribute(
      'data-phone',
      'true'
    );
    const row = frameOf(page).locator('.office-ribbon__scroll');
    await expect(ribbonCommand(page, cell)).toBeAttached();
    const box = await row.boundingBox();
    expect(box?.height).toBeLessThan(60);
    await ribbonCommand(page, cell).scrollIntoViewIfNeeded();
    await expect(ribbonCommand(page, cell)).toBeInViewport();
  });

test.describe('in Chinese at 360', () => {
  test.use({ locale: 'zh-CN' });
  for (const format of ['docx', 'xlsx', 'pptx'] as const)
    test(`${format}: the tab line and its row are translated and fit`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ height: 740, width: 360 });
      await page.goto(`/workspaces/ws_bio?file=bio-office-${format}&mode=edit`);
      await expect(officeTab(page, 'home')).toHaveText(
        m.files_office_tab_home({}, { locale: 'zh' }),
        { timeout: 120_000 }
      );
      await expect(
        page.getByRole('tablist', {
          name: m.files_office_ribbon_tabs({}, { locale: 'zh' }),
        })
      ).toBeVisible();
      await expect(frameOf(page).locator('.office-ribbon')).toHaveAttribute(
        'data-phone',
        'true'
      );
      await expect(
        frameOf(page).locator('.office-ribbon__scroll').first()
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
    });
});

test('a render error in the editor: the strip and Download draft reach the host', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await expect(
    frameOf(page).locator('[data-page-index="0"]').first()
  ).toBeVisible({ timeout: 120_000 });
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');
  await runtime.evaluate(() =>
    window.dispatchEvent(new Event('capy-scenario-ribbon-failure'))
  );
  const draft = page.getByRole('button', {
    name: m.source_edit_download_draft(),
  });
  await expect(draft).toBeVisible();
  await expect(frameOf(page).locator('.office-ribbon')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await draft.click();
  const saved = await (await download).createReadStream();
  const first = await new Promise<Buffer>((resolve) =>
    saved.once('data', (chunk) => resolve(Buffer.from(chunk)))
  );
  expect(first.subarray(0, 2).toString()).toBe('PK');
});

test('PPTX chips stay out of the ribbon: the header draws who is in the room', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { mockOwnAwareness, mockPresencePeer } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    mockPresencePeer(
      'bio-office-pptx',
      { avatar: null, name: 'Ann', person: 3 },
      mockOwnAwareness('bio-office-pptx') as Record<string, unknown>
    );
  });
  await expect(page.getByTestId('room-presence')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(
    frameOf(page).getByRole('list', { name: 'Collaborators' })
  ).toHaveCount(0);
});

test('a room swap keeps the tab and the collapse; entering Edit opens on Home', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await saveOffice(page, 'docx');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await officeTab(page, 'insert').click();
  const barOf = (view: string) =>
    page
      .frameLocator(`[data-office-view="${view}"] iframe`)
      .locator('.office-ribbon__bar');
  await expect(barOf('live')).toHaveAttribute('data-tab', 'insert');
  const swap = async () => {
    await page.evaluate(async (id) => {
      const collaboration = '/src/mocks/collaboration.ts';
      const fixtures = '/src/mocks/scenarioFixtures.ts';
      const { announceSourceEpoch } = await import(collaboration);
      const { advanceScenarioSource } = await import(fixtures);
      announceSourceEpoch(id, advanceScenarioSource(id));
    }, 'bio-office-docx');
    await expect(page.locator('[data-office-view="replaced"]')).toBeVisible();
    await expect(page.locator('[data-office-view="replaced"]')).toHaveCount(0, {
      timeout: 120_000,
    });
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  };
  await swap();
  await expect(officeTab(page, 'insert')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(barOf('live')).toHaveAttribute('data-tab', 'insert');
  // Collapsed stays collapsed.
  await page
    .frameLocator('[data-office-view="live"] iframe')
    .getByTestId('office-ribbon-collapse')
    .click();
  await expect(barOf('live')).toHaveCount(0);
  await swap();
  await expect(page.getByTestId('office-ribbon-expand')).toBeVisible();
  await expect(barOf('live')).toHaveCount(0);
  // The tab it had comes back with the ribbon.
  await page.getByTestId('office-ribbon-expand').click();
  await expect(barOf('live')).toHaveAttribute('data-tab', 'insert');
});

// Security regression (ribbon review: banner-action gesture): a compromised
// frame can't fire a strip's action by itself; the host needs the user's gesture.
test('a banner-action with no user gesture does nothing', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'menus')
        (window as unknown as { lastRevision: number }).lastRevision =
          event.data.revision;
    });
  });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const strip = frameOf(page).locator('.office-ribbon .office-banner');
  await expect(strip).toBeVisible();
  const revision = await page.evaluate(
    () => (window as unknown as { lastRevision: number }).lastRevision
  );
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');
  // From a timer, past the activation window of Playwright's own evaluate.
  await runtime.evaluate(
    ([at, version]) => {
      setTimeout(() => {
        window.parent.postMessage(
          { action: 'close', revision: at, type: 'banner-action', version },
          '*'
        );
      }, 6500);
    },
    [revision, OFFICE_PROTOCOL_VERSION]
  );
  await page.waitForTimeout(7500);
  await expect(strip).toBeVisible();
});

test('entering Edit opens on Home after a tab was picked', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await officeTab(page, 'insert').click();
  await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'insert');
  await saveOffice(page, 'docx');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const mode = page.getByRole('button', { name: m.material_mode() });
  await mode.click();
  await expect(officeTab(page, 'home')).toHaveCount(0, { timeout: 60_000 });
  await mode.click();
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'home');
});

test('the collapse is remembered on this device, not its tab', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  const open = async (format: string) => {
    await page.goto(`/workspaces/ws_bio?file=bio-office-${format}&mode=edit`);
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  };
  // First use: expanded (Q564).
  await open('xlsx');
  await expect(ribbonBar(page)).toBeVisible();
  await frameOf(page).getByTestId('office-ribbon-collapse').click();
  await expect(ribbonBar(page)).toHaveCount(0);
  // Another file on this device, and the next visit.
  await open('pptx');
  await expect(page.getByTestId('office-ribbon-expand')).toBeVisible();
  await expect(ribbonBar(page)).toHaveCount(0);
  await page.getByTestId('office-ribbon-expand').click();
  await expect(ribbonBar(page)).toBeVisible();
  await open('xlsx');
  await expect(ribbonBar(page)).toBeVisible();
});

test('a selected image brings the Picture tab, and its commands', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = frameOf(page);
  const input = frame.getByLabel('Document input');
  await input.focus();
  await input.press('ControlOrMeta+End');
  await expect(officeTab(page, 'picture')).toHaveCount(0);
  await officeTab(page, 'insert').click();
  const chooser = page.waitForEvent('filechooser');
  await ribbonCommand(page, 'insert-image').click();
  await (await chooser).setFiles({
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    ),
    mimeType: 'image/png',
    name: 'dot.png',
  });
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled();
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.press('Shift+ArrowLeft');
  const picture = officeTab(page, 'picture');
  await expect(picture).toBeVisible();
  await picture.click();
  await expect(ribbonBar(page)).toHaveAttribute('data-tab', 'picture');
  await expect(
    ribbonBar(page).getByRole('button', { name: /wrap/i }).first()
  ).toBeEnabled();
  // Off the image: the tab leaves, for Home.
  await input.press('ControlOrMeta+Home');
  await expect(picture).toHaveCount(0);
  await expect(officeTab(page, 'home')).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

test('a strip is posted to the frame once, however often the header renders', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    if (window === window.top) return;
    const seen = { banners: 0 };
    (window as unknown as { bannersSeen: typeof seen }).bannersSeen = seen;
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'set-banner' && event.data.banner)
        seen.banners += 1;
    });
  });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const strip = frameOf(page).locator('.office-ribbon .office-banner');
  await expect(strip).toBeVisible();
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');
  const seen = () =>
    runtime.evaluate(
      () =>
        (window as unknown as { bannersSeen: { banners: number } }).bannersSeen
          .banners
    );
  const before = await seen();
  // Tab moves and typing render the header again and again.
  for (const tab of ['edit', 'view', 'home'])
    await officeTab(page, tab).click();
  await page.waitForTimeout(500);
  expect(await seen()).toBe(before);
});

/** A frame's width, the Files panel open or not. */
const frameWidth = (page: Page) =>
  page
    .locator('iframe[src*="office-runtime"]')
    .evaluate((node) => node.getBoundingClientRect().width);

/** What a tab's row and its More list reach: each command by its id or name. */
const reachable = async (page: Page) => {
  const names = () =>
    ribbonBar(page).evaluate((bar) => [
      ...new Set(
        [
          ...bar.querySelectorAll<HTMLElement>(
            '.office-ribbon__scroll button, .office-ribbon__scroll input'
          ),
        ]
          .filter(
            (node) => !node.dataset.testid?.startsWith('office-ribbon-more')
          )
          .map(
            (node) =>
              node.dataset.command ??
              node.getAttribute('aria-label') ??
              node.title
          )
      ),
    ]);
  const more = frameOf(page).getByTestId('office-ribbon-more');
  if (await more.count()) await more.click();
  const seen = await names();
  if (await more.count()) await page.keyboard.press('Escape');
  return seen.sort();
};

const tabsOf = (page: Page) =>
  page
    .getByRole('tablist', { name: m.files_office_ribbon_tabs() })
    .getByRole('tab')
    .evaluateAll((tabs) =>
      tabs.map((tab) => (tab as HTMLElement).dataset.tab ?? '')
    );

for (const format of ['docx', 'xlsx', 'pptx'] as const)
  test(`${format}: every command stays reachable at 1280 with the Files panel open`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const url = `/workspaces/ws_bio?file=bio-office-${format}&mode=edit`;
    // Wide, with no panel: everything fits, nothing in More.
    await page.setViewportSize({ height: 800, width: 2400 });
    await page.goto(url);
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
    await expect(frameOf(page).locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    const wide: Record<string, string[]> = {};
    for (const tab of await tabsOf(page)) {
      await officeTab(page, tab).click();
      await expect(ribbonBar(page)).toHaveAttribute('data-tab', tab);
      await expect(frameOf(page).getByTestId('office-ribbon-more')).toHaveCount(
        0
      );
      wide[tab] = await reachable(page);
    }
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto(`${url}&panel=files`);
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
    await expect(frameOf(page).locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    expect(await frameWidth(page)).toBeGreaterThanOrEqual(768);
    await expect(frameOf(page).locator('.office-ribbon')).not.toHaveAttribute(
      'data-phone',
      'true'
    );
    const moved: string[] = [];
    for (const tab of await tabsOf(page)) {
      await officeTab(page, tab).click();
      await expect(ribbonBar(page)).toHaveAttribute('data-tab', tab);
      if (await frameOf(page).getByTestId('office-ribbon-more').count())
        moved.push(tab);
      expect(await reachable(page), tab).toEqual(wide[tab]);
      // The row holds; the chevron and the last control both show whole.
      const row = frameOf(page).locator('.office-ribbon__scroll');
      expect(
        await row.evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await expect(
        frameOf(page).getByTestId('office-ribbon-collapse')
      ).toBeInViewport({
        ratio: 1,
      });
    }
    expect(moved.length).toBeGreaterThan(0);
    // A command in More runs, and closes it.
    const tab = moved[0];
    await officeTab(page, tab).click();
    const more = frameOf(page).getByTestId('office-ribbon-more');
    await more.click();
    const list = frameOf(page).getByTestId('office-ribbon-more-list');
    expect((await listFit(list)).inside).toBe(true);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    // Growing the window brings the groups back.
    await page.setViewportSize({ height: 800, width: 2400 });
    await expect(more).toHaveCount(0);
  });

test('the row follows the frame: under 768 px it is one row, whatever the window', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const ribbon = frameOf(page).locator('.office-ribbon');
  const chevron = frameOf(page).getByTestId('office-ribbon-collapse');
  const undoFirst = async () => {
    for (const button of history(page)) await expect(button).toBeInViewport();
    const undo = await history(page)[0].boundingBox();
    const home = await officeTab(page, 'home').boundingBox();
    expect(undo && home && undo.x < home.x).toBe(true);
  };
  // A window over 768 px, its frame under: the row is the frame's.
  await page.setViewportSize({ height: 800, width: 780 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await expect(frameOf(page).locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  expect(await frameWidth(page)).toBeLessThan(768);
  await expect(ribbon).toHaveAttribute('data-phone', 'true');
  await expect(chevron).toHaveCount(0);
  await expect(frameOf(page).getByTestId('office-ribbon-more')).toHaveCount(0);
  await expect(ribbonCommand(page, 'insert-comment')).toBeAttached();
  await undoFirst();
  // The Files panel docked (1260 px up) and made wider: same, with no reload.
  await page.setViewportSize({ height: 800, width: 1280 });
  await expect.poll(() => frameWidth(page)).toBeGreaterThanOrEqual(768);
  await expect(ribbon).not.toHaveAttribute('data-phone', 'true');
  await expect(chevron).toBeVisible();
  await undoFirst();
  await page.getByRole('separator').first().focus();
  for (let step = 0; step < 8; step += 1)
    await page.keyboard.press('ArrowRight');
  await expect.poll(() => frameWidth(page)).toBeLessThan(768);
  await expect(ribbon).toHaveAttribute('data-phone', 'true');
  await expect(chevron).toHaveCount(0);
  await undoFirst();
});
