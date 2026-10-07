import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('header distinguishes initial sync, pending edits and durable saves', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  const status = page.getByTestId('editor-save-state');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute('data-save-state', 'synced');
  await expect(status.locator('svg')).toBeVisible();
  const syncedIcon = await status.locator('svg').innerHTML();
  await page
    .getByRole('button', { name: m.material_mode() })
    .press('Shift+Tab');
  await expect(status).toBeFocused();
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(tooltip).toBeVisible();
  await expect(
    tooltip.getByText(m.editor_status_synced(), { exact: true })
  ).toBeVisible();
  await status.press('Tab');

  // Hold real mock receipts to exercise a late acknowledgment after a new edit.
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { rooms } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    const room = [...rooms.values()].find(
      (candidate) => candidate.target.id === 'mat_e2e_editor'
    );
    if (!room) throw new Error('Editor room did not connect');
    const provider = [...room.participants][0].origin as {
      connect: () => void;
      disconnect: () => void;
      options: { onStateless: (event: { payload: string }) => void };
    };
    const deliver = provider.options.onStateless;
    const receipts: Array<() => void> = [];
    provider.options.onStateless = (event) => {
      if (JSON.parse(event.payload).type === 'checkpoint-persisted') {
        receipts.push(() => deliver(event));
      } else deliver(event);
    };
    Object.assign(window, {
      connectEditor: () => provider.connect(),
      disconnectEditor: () => provider.disconnect(),
      releaseCheckpoint: () => {
        const receipt = receipts.shift();
        if (!receipt) throw new Error('No checkpoint receipt to release');
        receipt();
      },
    });
  });
  const releaseCheckpoint = () =>
    page.evaluate(() => {
      (
        window as unknown as { releaseCheckpoint: () => void }
      ).releaseCheckpoint();
    });

  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText(' first pending edit');
  await expect(status).toHaveAttribute('data-save-state', 'syncing');
  expect(await status.locator('svg').innerHTML()).not.toBe(syncedIcon);
  await page.clock.runFor(1000);
  await expect(status).toHaveAttribute('data-save-state', 'syncing');

  await page.keyboard.insertText(' newer pending edit');
  await releaseCheckpoint();
  await expect(status).toHaveAttribute('data-save-state', 'syncing');
  await page.clock.runFor(1000);
  await releaseCheckpoint();
  await expect(status).toHaveAttribute('data-save-state', 'saved');

  await page.keyboard.insertText(' awaiting acknowledgment');
  await page.clock.runFor(1000);
  await page.evaluate(() => {
    (window as unknown as { disconnectEditor: () => void }).disconnectEditor();
  });
  // The browser is online, so a dropped room reads as reconnecting.
  await expect(status).toHaveAttribute('data-save-state', 'reconnecting');
  await releaseCheckpoint();
  await expect(status).toHaveAttribute('data-save-state', 'reconnecting');
  await page.keyboard.insertText(' offline edit');
  await page.clock.runFor(1000);
  await expect(status).toHaveAttribute('data-save-state', 'reconnecting');
  await page.evaluate(() => {
    (window as unknown as { connectEditor: () => void }).connectEditor();
  });
  await expect(status).toHaveAttribute('data-save-state', 'syncing');
  await releaseCheckpoint();
  await expect(status).toHaveAttribute('data-save-state', 'saved');

  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(status).toHaveCount(0);
});
