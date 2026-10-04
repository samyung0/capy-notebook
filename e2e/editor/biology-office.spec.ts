import { expect, test } from '@playwright/test';

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
      await expect(save).toBeEnabled({ timeout: 30_000 });
      const input = frame.getByTestId('yrs-input');
      const last = frame
        .getByRole('paragraph')
        .filter({ hasText: /^人數：20人$/ })
        .getByText('人', { exact: true })
        .last();
      await expect(async () => {
        await last.hover({ force: true });
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
        await save.click();
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

for (const style of ['classroom', 'notion']) {
  test(`Office viewer keeps its iframe when the workspace layout changes (${style})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.addInitScript((selectedStyle) => {
      localStorage.setItem('capy.style', selectedStyle);
      localStorage.setItem('capy.theme', 'latte');
    }, style);
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
    for (const width of [900, 1280]) {
      await page.setViewportSize({ height: 800, width });
      await expect(
        page
          .getByRole('button', {
            exact: true,
            name: style === 'notion' ? 'Workspace tools' : 'Files',
          })
          .first()
      ).toBeVisible();
      await expect(iframe).toHaveAttribute('data-layout-probe', 'kept');
    }
    if (style === 'notion') {
      const tools = page.getByRole('button', {
        exact: true,
        name: 'Workspace tools',
      });
      await tools.click();
      await page
        .getByRole('menuitem', { name: 'Pin files to the left' })
        .click();
      await expect(iframe).toHaveAttribute('data-layout-probe', 'kept');
      await tools.click();
      await page.getByRole('menuitem', { exact: true, name: 'Files' }).click();
      await expect(iframe).toHaveAttribute('data-layout-probe', 'kept');
    }
    expect(sessions).toBe(opened);
  });
}
