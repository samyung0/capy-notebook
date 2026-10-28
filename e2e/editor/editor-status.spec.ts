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

// Co-editors' carets, pointers and block selections come from their compact
// presence, named from the room's presence (mocks P1 and B3). The show-others
// switch in Settings > Customizations > Editor, a device setting, hides them
// while the avatar group stays (Epo 2026-10-28, Q542).
test("co-editors' carets, pointers and block selections show until the show-others switch hides them", async ({
  page,
}) => {
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  const marks = [
    editor.locator('[data-remote-caret="Ann"]'),
    page.locator('[data-remote-pointer="Ben"]'),
    page.locator('[data-remote-run="Ben"]'),
  ];
  const openWithPeers = async () => {
    await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async () => {
      const path = '/src/mocks/collaboration.ts';
      const { mockPeerCaret, mockPresencePeer } = (await import(
        path
      )) as typeof import('../../src/mocks/collaboration');
      mockPeerCaret(
        'mat_e2e_editor',
        { avatar: null, name: 'Ann', person: 3 },
        2
      );
      mockPresencePeer(
        'mat_e2e_editor',
        { avatar: null, name: 'Ben', person: 5 },
        {
          b: [['mat_e2e_editor:first', 'mat_e2e_editor:second']],
          p: ['mat_e2e_editor:third', 400, 500],
        }
      );
    });
    await expect(page.getByTestId('room-presence')).toBeVisible();
  };
  await openWithPeers();
  for (const mark of marks) await expect(mark).toHaveCount(1);
  await page.goto('/settings?tab=customizations');
  const shown = page.getByRole('switch', { name: m.settings_show_others() });
  await expect(shown).toBeChecked();
  await shown.click();
  await expect(shown).not.toBeChecked();
  await openWithPeers();
  for (const mark of marks) await expect(mark).toHaveCount(0);
});

// This tab's pointer and block selection reach its co-editors (review T2):
// the pointer over a block as that block's id until it leaves the note, and
// a block selected by right-clicking it as a one-block run.
test("this tab's pointer and block selection reach co-editors", async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor&mode=edit');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    const { awareness } = mockNotePeer('mat_e2e_editor');
    Object.assign(window, {
      seenByPeer: () => {
        const states = [...awareness.getStates()].filter(
          ([client]) => client !== awareness.clientID
        );
        return states.map(([, state]) => ({ b: state.b, p: state.p }));
      },
    });
  });
  const seen = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          seenByPeer: () => { b?: string[][]; p?: [string] | null }[];
        }
      ).seenByPeer()
    );
  const second = await page
    .locator('[data-block-id="mat_e2e_editor:second"]')
    .boundingBox();
  if (!second) throw new Error('The second block is not on screen');
  await page.mouse.move(
    second.x + second.width / 2,
    second.y + second.height / 2
  );
  await expect
    .poll(async () => (await seen()).map(({ p }) => p?.[0] ?? null))
    .toEqual(['mat_e2e_editor:second']);
  await page.mouse.move(1, 1);
  await expect
    .poll(async () => (await seen()).map(({ p }) => p ?? null))
    .toEqual([null]);
  await page
    .locator('[data-block-id="mat_e2e_editor:first"]')
    .click({ button: 'right' });
  await expect
    .poll(async () => (await seen()).map(({ b }) => b ?? null))
    .toEqual([[['mat_e2e_editor:first', 'mat_e2e_editor:first']]]);
});
