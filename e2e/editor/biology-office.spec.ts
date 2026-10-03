import { expect, test } from '@playwright/test';
import { officeEditMenu, officeMenu, saveOffice } from '../helpers/office';

declare global {
  interface Window {
    officeInputProbe: { hold: boolean; held: (() => void)[]; flushed: boolean };
  }
}

for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['xlsx', 'course-guide.xlsx'],
  ['pptx', 'lecture.pptx'],
]) {
  test(`Biology ${format} fixture opens in View/Edit and survives scenario reset`, async ({
    page,
  }) => {
    test.setTimeout(format === 'docx' ? 180_000 : 120_000);
    const fileId = `bio-office-${format}`;
    if (format === 'docx') {
      await page.addInitScript(() => {
        window.officeInputProbe = { flushed: false, held: [], hold: false };
        const send = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (
          message: { type?: string },
          options?: StructuredSerializeOptions | Transferable[]
        ) {
          const release = () => {
            const post = send.bind(this);
            if (Array.isArray(options)) post(message, options);
            else post(message, options);
          };
          if (
            window.officeInputProbe.hold &&
            (message?.type === 'applyInput' || message?.type === 'applyDelete')
          )
            window.officeInputProbe.held.push(release);
          else release();
        };
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'flush')
            window.officeInputProbe.flushed = true;
        });
      });
    }
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
      timeout: 60_000,
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
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
    // File › Save is a menuitem, a ticked row a menuitemcheckbox.
    await saveOffice(page);
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved$/ })
    ).toBeVisible();
    if (format === 'docx') {
      await officeMenu(page, 'View').click();
      await expect(
        page.getByRole('menuitemcheckbox', { name: 'Show comments' })
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }
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
      await saveOffice(page);
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
    }
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
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
    // MSW also closes its client on beforeunload; probe after all API checks.
    if (format === 'docx') {
      await page.goto(`/workspaces/ws_bio?file=${fileId}`);
      await expect(frame.locator('canvas').first()).toBeVisible({
        timeout: 60_000,
      });
      await mode.click();
      await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
      const input = frame.getByTestId('yrs-input');
      const paragraph = frame
        .getByRole('paragraph')
        .filter({ hasText: /^人數：20人$/ });
      // Mirror pages away from the viewport hold only plain text: bring the
      // paragraph's page into view, then point at its positioned glyph.
      const last = frame
        .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
        .getByRole('paragraph')
        .filter({ hasText: /^人數：20人$/ })
        .getByText('人', { exact: true })
        .last();
      await expect(async () => {
        await frame
          .locator('.layout-page-mirror')
          .filter({ has: paragraph })
          .scrollIntoViewIfNeeded({ timeout: 1000 });
        await last.hover({ force: true, timeout: 1000 });
        await expect(frame.locator('.canvas-pages')).toHaveCSS(
          'cursor',
          'text',
          { timeout: 1000 }
        );
        await last.click({ force: true });
        await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
          timeout: 1000,
        });
      }).toPass({ timeout: 30_000 });
      await input.press('End');
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
      const runtime = page
        .frames()
        .find((candidate) => candidate.url().includes('office-runtime'));
      if (!runtime) throw new Error('Missing Office runtime');
      await runtime.evaluate(() => {
        window.officeInputProbe.hold = true;
        window.officeInputProbe.flushed = false;
      });
      try {
        await input.pressSequentially('7');
        await expect
          .poll(() =>
            runtime.evaluate(() => window.officeInputProbe.held.length)
          )
          .toBeGreaterThan(0);
        await expect(
          page.getByRole('status').filter({ hasText: /^Syncing/ })
        ).toBeVisible();
        const blocksUnload = () =>
          page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          });
        expect(await blocksUnload()).toBe(true);
        await saveOffice(page);
        await expect
          .poll(() => runtime.evaluate(() => window.officeInputProbe.flushed))
          .toBe(true);
        await expect(
          page.getByRole('status').filter({ hasText: /^Saved$/ })
        ).toHaveCount(0);
        expect(await blocksUnload()).toBe(true);
      } finally {
        await runtime.evaluate(() => {
          window.officeInputProbe.hold = false;
          for (const release of window.officeInputProbe.held.splice(0))
            release();
        });
      }
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
    }
  });
}

test('Office viewer keeps its iframe when the workspace layout changes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let sessions = 0;
  page.on('request', (request) => {
    if (request.url().includes('/source-session')) sessions++;
  });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const iframe = page.locator('iframe[src*="office-runtime"]');
  await iframe.evaluate((element) => {
    element.dataset.layoutProbe = 'kept';
  });
  const opened = sessions;

  // One column below lg, two columns at lg: both switch the surrounding layout.
  // Below lg an open Office file folds the workspace tools into one button.
  for (const [width, tools] of [
    [900, 'Workspace tools'],
    [1280, 'Files'],
  ] as const) {
    await page.setViewportSize({ height: 800, width });
    await expect(
      page.getByRole('button', { name: tools }).first()
    ).toBeVisible();
    await expect(iframe).toHaveAttribute('data-layout-probe', 'kept');
  }
  expect(sessions).toBe(opened);
});

test("Office runtime keeps Capy's theme after reloading and asks for a page reload on a protocol mismatch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('capy.theme', 'mocha'));
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'mocha');
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');

  // The runtime document reloads by itself; the host sends the theme again.
  const reloaded = page.waitForEvent(
    'framenavigated',
    (navigated) => navigated === runtime
  );
  await runtime.evaluate(() => setTimeout(() => location.reload()));
  await reloaded;
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'mocha');

  // A runtime from another deploy starts under another protocol version.
  await runtime.evaluate(() =>
    parent.postMessage({ type: 'initialized', version: 0 }, '*')
  );
  await expect(page.getByText('An update is ready')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});

test('Office runtime that reloads while editing is paused stays inert', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  // The runtime's own host; the editor's hosts nest inside it.
  const host = frame.locator('.office-editor-host').first();
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  await saveOffice(page);
  await expect(
    page.getByRole('status').filter({ hasText: /^Saved$/ })
  ).toBeVisible();
  await expect(host).toHaveJSProperty('inert', false);

  // A newer version is published while the saved editor is open: the session
  // is replaced and the runtime pauses under the reload banner.
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { announceSourceEpoch } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    announceSourceEpoch('bio-office-docx', 2);
  });
  await expect(page.getByText('A newer version of this file')).toBeVisible();
  await expect(host).toHaveJSProperty('inert', true);

  // Paused, the menus keep editing items listed but disabled (File › Save
  // too), Download stays usable, and the runtime ignores editing commands.
  await officeMenu(page, 'File').click();
  await expect(page.getByRole('menuitem', { name: /^Save/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  await expect(
    page.getByRole('menuitem', { name: 'Download' })
  ).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await officeMenu(page, 'Insert').click();
  await expect(page.getByRole('menuitem', { name: 'Break' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  await page.keyboard.press('Escape');
  const updates = await page.evaluate(async () => {
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="office-runtime"]'
    );
    if (!iframe?.contentWindow) throw new Error('Missing Office runtime');
    let count = 0;
    const counter = (event: MessageEvent) => {
      if (event.data?.type === 'update') count += 1;
    };
    window.addEventListener('message', counter);
    const origin = new URL(iframe.src).origin;
    for (let click = 0; click < 3; click += 1)
      iframe.contentWindow.postMessage(
        { id: 'insert-page-break', type: 'menu-command', version: 7 },
        origin
      );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    window.removeEventListener('message', counter);
    return count;
  });
  expect(updates).toBe(0);

  // The runtime document reloads by itself; its new load still pauses it.
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');
  const reloaded = page.waitForEvent(
    'framenavigated',
    (navigated) => navigated === runtime
  );
  await runtime.evaluate(() => setTimeout(() => location.reload()));
  await reloaded;
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(host).toHaveJSProperty('inert', true);
});

test('PPTX speaker notes start hidden, and one remembered toggle serves view and edit', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const viewNotes = frame.getByRole('note');
  const notesButton = frame.getByTestId('pptx-notes-toggle');
  const showNotes = page.getByRole('menuitemcheckbox', {
    name: 'Show speaker notes',
  });
  const openView = async () => {
    await officeMenu(page, 'View').click();
    await expect(showNotes).toBeVisible();
  };

  // View mode: the Notes button and View › Show speaker notes flip one state.
  await expect(notesButton).toBeVisible();
  await expect(viewNotes).toHaveCount(0);
  await notesButton.click();
  await expect(viewNotes).toBeVisible();
  await openView();
  await expect(showNotes).toHaveAttribute('aria-checked', 'true');
  await showNotes.click();
  await expect(viewNotes).toHaveCount(0);
  await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
  await openView();
  await expect(showNotes).toHaveAttribute('aria-checked', 'false');
  await showNotes.click();
  await expect(viewNotes).toBeVisible();

  // Below lg the floating tools button sits above the open notes box.
  await page.setViewportSize({ height: 800, width: 390 });
  const tools = page.getByRole('button', { name: 'Workspace tools' });
  await expect(tools).toBeVisible();
  await expect(async () => {
    const toolsBox = await tools.boundingBox();
    const notesBox = await viewNotes.boundingBox();
    expect(toolsBox && notesBox).toBeTruthy();
    if (toolsBox && notesBox)
      expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(notesBox.y);
  }).toPass();
  await page.setViewportSize({ height: 800, width: 1280 });

  // Edit mode opens with the same choice, and hiding it there carries back.
  const mode = page.getByRole('button', { name: 'Material mode' });
  await mode.click();
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  const editNotes = frame.getByTestId('pptx-notes-textarea');
  await expect(editNotes).toBeVisible();
  await notesButton.click();
  await expect(editNotes).toHaveCount(0);
  await mode.click();
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
  await expect(viewNotes).toHaveCount(0);
});
