import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// A note that joined with nothing of this device's to store reads Saved, as
// every format does (Epo 2026-10-20); pending edits read Syncing until the
// receipt of the store that holds them.
test('header distinguishes pending edits from durable saves', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  const status = page.getByTestId('editor-save-state');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await expect(status.locator('svg')).toBeVisible();
  const savedIcon = await status.locator('svg').innerHTML();
  await page
    .getByRole('button', { name: m.material_mode() })
    .press('Shift+Tab');
  await expect(status).toBeFocused();
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(tooltip).toBeVisible();
  await expect(
    tooltip.getByText(m.editor_status_saved(), { exact: true })
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
  expect(await status.locator('svg').innerHTML()).not.toBe(savedIcon);
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

// A note on screen whose reconnect waits on the open budget keeps its editor
// and, after 5 s, says why under the header's sync indicator; the line goes
// once the room syncs (Epo 2026-10-20).
test('a slowed reconnect says so under the sync indicator', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  const status = page.getByTestId('editor-save-state');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  const line = page
    .locator('[data-slot="tooltip-content"][data-open]')
    .getByText(m.editor_open_slowed(), { exact: true });

  const slow = (value: boolean) =>
    page.evaluate(async (slowed) => {
      const path = '/src/mocks/collaboration.ts';
      const mock = (await import(
        path
      )) as typeof import('../../src/mocks/collaboration');
      if (slowed) {
        mock.setCollaborationSlowed(true);
        // The room drops and joins again, its join slowed.
        mock.setCollaborationReachable(false);
        mock.setCollaborationReachable(true);
      } else mock.setCollaborationSlowed(false);
    }, value);
  await slow(true);
  await expect(status).toHaveAttribute('data-save-state', 'reconnecting');
  await expect(line).toHaveCount(0);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await expect(editor).toBeVisible();

  await slow(false);
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await expect(line).toHaveCount(0);
});

// Co-editors show as an avatar group in the header (Epo 2026-10-20): one
// avatar per person from the room's presence, at most three, then +N; gone
// when they leave.
test('the header lists co-editors as an avatar group', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible({ timeout: 30_000 });
  const group = page.getByTestId('room-presence');
  await expect(group).toHaveCount(0);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { mockPresencePeer } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    const leaves = ['Ann', 'Ben', 'Cy', 'Dee', 'Eve'].map((name, index) =>
      mockPresencePeer('mat_e2e_editor', {
        avatar: null,
        name,
        person: index + 1,
      })
    );
    Object.assign(window, {
      leavePeers: () => {
        for (const leave of leaves) leave();
      },
    });
  });
  await expect(group.locator('[data-presence-person]')).toHaveCount(3);
  await expect(group.locator('[data-presence-more]')).toHaveAttribute(
    'data-presence-more',
    '2'
  );
  await page.evaluate(() => {
    (window as unknown as { leavePeers: () => void }).leavePeers();
  });
  await expect(group).toHaveCount(0);
});

// The file status shows its label beside the icon from md up, every file's
// header alike; below md the icon stands alone and the label is screen-reader
// text, in the tooltip too (Epo 2026-10-22).
test('the save status shows its label beside the icon from md up', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 768 });
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );
  const label = page.getByTestId('editor-save-label');
  await expect(label).toHaveText(m.editor_status_saved());
  const width = async () => (await label.boundingBox())?.width ?? 0;
  expect(await width()).toBeGreaterThan(10);
  await page.setViewportSize({ height: 900, width: 767 });
  await expect.poll(width).toBeLessThanOrEqual(1);
});
