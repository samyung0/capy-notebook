import { expect, type Page, test } from '@playwright/test';

// The scenario note keeps its room and drafts across reloads (MSW stores
// mock-scenario fixtures for the tab).
const note = '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit';
const seed = 'A note for trying application errors.';
const offlineCopy =
  "Can't connect to Capy. Your edits are saved on this device and will sync when you reconnect. They may be rejected or lost.";
// Set to a folder to keep a screenshot of each banner state.
const shots = process.env.OFFLINE_SCREENSHOTS;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function openNote(page: Page) {
  await page.goto(note);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveText(
    /Synced|Saved/
  );
  return editor;
}

async function type(page: Page, text: string) {
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

// Chromium's offline emulation does not reliably fire the window events.
async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

/** The collaboration mock as a server that is down (kept across reloads). */
async function setReachable(page: Page, reachable: boolean) {
  await page.evaluate(async (value) => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(value);
  }, reachable);
}

async function storedDrafts(page: Page) {
  return page.evaluate(async () => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    return (
      await readDrafts(draftKey(user.id, 'material', 'mock-scenario-note'))
    ).length;
  });
}

test('offline edits outlive a reload and save once the room is back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNote(page);
  await setOnline(page, false);
  const banner = page.getByTestId('save-banner');
  await expect(banner).toHaveText(offlineCopy);
  // The header's connection status takes the save state's place.
  await expect(
    page.locator('[data-connection-status="offline"]')
  ).toBeVisible();
  await type(page, ' Written offline.');
  await expect.poll(() => storedDrafts(page)).toBeGreaterThan(0);
  await shot(page, 'offline');

  // Back online while the service stays unreachable, then reload: the
  // edits come back from this device, not from the room.
  await setReachable(page, false);
  await setOnline(page, true);
  await page.reload();
  await expect(page.getByText('Connecting…').first()).toBeVisible({
    timeout: 30_000,
  });
  await setReachable(page, true);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText('Written offline.', { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveText('Saved');
  await expect(banner).toHaveCount(0);
  // The receipt deleted what it covered.
  await expect.poll(() => storedDrafts(page)).toBe(0);

  await page.reload();
  await expect(page.locator('[contenteditable="true"]').first()).toContainText(
    'Written offline.',
    { timeout: 30_000 }
  );
});

test('edits from a room that moved on open read-only for copying until Reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNote(page);
  await setOnline(page, false);
  await type(page, ' Kept for copying.');
  await expect.poll(() => storedDrafts(page)).toBeGreaterThan(0);
  // The service discarded unsaved room state while this tab was away.
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { moveMockMaterialRoom } = await import(path);
    moveMockMaterialRoom('mock-scenario-note', true);
  });
  await setOnline(page, true);

  const banner = page.getByTestId('save-banner');
  const recovery = page.getByTestId('note-recovery');
  const shown = async () => {
    await expect(banner).toContainText(
      'This file changed while your edits were waiting to sync. Copy anything you need, then reload.',
      { timeout: 30_000 }
    );
    await expect(recovery).toContainText('Kept for copying.');
    await expect(recovery.locator('[contenteditable="true"]')).toHaveCount(0);
    // Reload is the only way out.
    await expect(banner.getByRole('button')).toHaveText(['Reload']);
  };
  await shown();
  await shot(page, 'recovery');
  // Never merged: a reload shows the same recovery.
  await page.evaluate(() => localStorage.setItem('capy.theme', 'mocha'));
  await page.reload();
  await shown();
  await shot(page, 'recovery-dark');
  await page.evaluate(() => localStorage.setItem('capy.theme', 'latte'));

  await banner.getByRole('button', { name: 'Reload' }).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(editor).not.toContainText('Kept for copying.');
  await expect(banner).toHaveCount(0);
  await expect.poll(() => storedDrafts(page)).toBe(0);
});
