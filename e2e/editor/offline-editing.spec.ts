import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// The scenario note keeps its room and drafts across reloads (MSW stores
// mock-scenario fixtures for the tab).
const note = '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit';
const seed = 'A note for trying application errors.';
// Set to a folder to keep a screenshot of each banner state.
const shots = process.env.OFFLINE_SCREENSHOTS;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function openNote(page: Page) {
  await page.goto(note);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
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

/** The kinds of the note's stored rows. */
async function draftKinds(page: Page) {
  return page.evaluate(async () => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const rows: { kind: string }[] = await readDrafts(
      draftKey(user.id, 'material', 'mock-scenario-note')
    );
    return rows.map((row) => row.kind);
  });
}

async function storedDrafts(page: Page) {
  return (await draftKinds(page)).length;
}

/** Types and waits for the receipt that deletes the rows: the room accepted
 * this session (Q326), so the edits it stores later reopen on this device. */
async function typeSaved(page: Page, text: string) {
  await type(page, text);
  await expect.poll(() => storedDrafts(page), { timeout: 15_000 }).toBe(0);
}

type Peer = ReturnType<
  typeof import('../../src/mocks/collaboration').mockNotePeer
>;
type DraftsAnswer = 'fail' | 'store' | 'unassigned';
const DRAFTS_ANSWER = 'e2e.drafts.answer';
const DRAFTS_SENT = 'e2e.drafts.sent';

/** The service's `/drafts` for this tab (the mock token's URL is not
 * fetchable): it fails as a service that is down, or answers as
 * `answerDrafts` set. The page's sweep, which sends with the document's lock
 * held exclusively, always meets a down service, so only the editor's sends
 * get the answer and are counted (`draftSends`). */
async function serveDrafts(page: Page) {
  await page.addInitScript(
    ([answerKey, sentKey]) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith('/drafts')) return original(input, init);
        const { held = [] } = await navigator.locks.query();
        const sweep = held.some(
          (lock) =>
            lock.mode === 'exclusive' && lock.name?.startsWith('capy-drafts:')
        );
        const answer = sweep ? 'fail' : sessionStorage.getItem(answerKey);
        if (!sweep)
          sessionStorage.setItem(
            sentKey,
            String(Number(sessionStorage.getItem(sentKey) ?? 0) + 1)
          );
        if (answer === 'store') return new Response(null, { status: 200 });
        if (answer === 'unassigned')
          return Response.json({ class: 'unassigned' }, { status: 409 });
        throw new TypeError('Failed to fetch');
      };
    },
    [DRAFTS_ANSWER, DRAFTS_SENT]
  );
}

async function answerDrafts(page: Page, answer: DraftsAnswer) {
  await page.evaluate(
    ([key, value]) => sessionStorage.setItem(key, value),
    [DRAFTS_ANSWER, answer]
  );
}

const draftSends = (page: Page) =>
  page.evaluate((key) => Number(sessionStorage.getItem(key) ?? 0), DRAFTS_SENT);

/** Leaves the note with steps the room never took, as a closed session's
 * with its stored token, on the workspace page with the service down. */
async function leaveHeldSteps(page: Page) {
  await openNote(page);
  await setOnline(page, false);
  await type(page, ' Held steps.');
  await expect.poll(() => storedDrafts(page)).toBeGreaterThan(0);
  // Back online with the service down, so the room never took them, and
  // away from the note (its last whole row is written as the page goes).
  await setReachable(page, false);
  await setOnline(page, true);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
  // As a real session's rows, they carry its stored token (the mock's
  // provider takes none, so its rows would open copy-only).
  await page.evaluate(async () => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, putDrafts, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const key = draftKey(user.id, 'material', 'mock-scenario-note');
    const rows: { grants?: string[] }[] = await readDrafts(key);
    await putDrafts(rows.map((row) => ({ ...row, grants: ['stored-token'] })));
  });
}

/** What the browser reported to POST /api/edit-incidents (the MSW store). */
async function reportedIncidents(page: Page) {
  return page.evaluate(async () => {
    const dbPath = '/src/mocks/db.ts';
    const { editIncidents } = await import(dbPath);
    return editIncidents as { fileId: string; kind: string }[];
  });
}

test('offline edits outlive a reload and save once the room is back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNote(page);
  await typeSaved(page, ' Saved first.');
  await setOnline(page, false);
  const banner = page.getByTestId('save-banner');
  const offline = page.locator(
    '[data-testid="save-banner"][data-kind="offline"]'
  );
  await expect(offline).toBeVisible();
  // The header's connection status takes the save state's place.
  await expect(
    page.locator('[data-connection-status="offline"]')
  ).toBeVisible();
  await type(page, ' Written offline.');
  // Each key is written as it is typed (the drafts worker answers this read
  // after every write posted before it): one update row per key, and the
  // whole note once for the episode.
  const kinds = await draftKinds(page);
  expect(kinds.filter((kind) => kind === 'state')).toHaveLength(1);
  expect(kinds.filter((kind) => kind === 'update').length).toBeGreaterThan(1);
  await shot(page, 'offline');
  // The workspace's offline toast goes after its 12 s; the banner stays.
  const toast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: m.connection_offline_body() });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 14_000 });
  await expect(offline).toBeVisible();

  // Back online while the service stays unreachable, then reload: the
  // edits come back from this device, not from the room.
  await setReachable(page, false);
  await setOnline(page, true);
  await page.reload();
  await expect(page.getByText(m.editor_connecting()).first()).toBeVisible({
    timeout: 30_000,
  });
  await setReachable(page, true);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText('Written offline.', { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await expect(banner).toHaveCount(0);
  // The receipt deleted what it covered.
  await expect.poll(() => storedDrafts(page)).toBe(0);

  await page.reload();
  await expect(page.locator('[contenteditable="true"]').first()).toContainText(
    'Written offline.',
    { timeout: 30_000 }
  );
});

// Q327, Q328, Q360: a closed session's never-accepted steps go through the
// draft send while the note opens view-only; not delivered 30 s on, the
// synced note takes them itself and edits on, syncing, with nothing of them
// live (a peer in the room sees none) until the send settles. An offline
// blip meanwhile shows offline, then syncing again once back.
test('a note takes the stored steps its draft send has not delivered 30 s on, and edits on', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await page.goto(note);
  await setReachable(page, true);
  const content = page.locator('[data-slate-editor]').first();
  const saveState = page.getByTestId('editor-save-state');
  await expect(content).toContainText(seed, { timeout: 30_000 });
  await expect(saveState).toHaveAttribute('data-save-state', 'syncing');
  await expect(content).toHaveAttribute('contenteditable', 'false');
  await expect(content).not.toContainText('Held steps.');
  // Another editor in the note's room, once the note joined it.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const modulePath = '/src/mocks/collaboration.ts';
        const { mockNotePeer } = (await import(
          modulePath
        )) as typeof import('../../src/mocks/collaboration');
        try {
          Object.assign(window, { peer: mockNotePeer('mock-scenario-note') });
          return true;
        } catch {
          return false;
        }
      })
    )
    .toBe(true);
  const peerText = () =>
    page.evaluate(() =>
      String((window as unknown as { peer: Peer }).peer.document.get('content'))
    );
  await expect(content).toContainText('Held steps.', { timeout: 45_000 });
  await expect(content).toHaveAttribute('contenteditable', 'true');
  await expect(saveState).toHaveAttribute('data-save-state', 'syncing');
  expect(await peerText()).not.toContain('Held steps.');
  await setOnline(page, false);
  await expect(
    page.locator('[data-connection-status="offline"]')
  ).toBeVisible();
  await setOnline(page, true);
  await expect(saveState).toHaveAttribute('data-save-state', 'syncing');
  expect(await peerText()).not.toContain('Held steps.');
  // The room takes them at the next try (the browser back online again):
  // the note joins and saves.
  await answerDrafts(page, 'store');
  await setOnline(page, false);
  await setOnline(page, true);
  await expect.poll(peerText, { timeout: 15_000 }).toContain('Held steps.');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 15_000,
  });
});

// Q360: a note whose room first syncs only after the send's 30 s takes the
// steps then, and the hold's connect sends again at once.
test('a note whose room syncs after 30 s takes its stored steps then, and sends again at once', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await page.goto(note);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { holdRoomJoins } = await import(path);
    holdRoomJoins(true);
  });
  await setReachable(page, true);
  const content = page.locator('[data-slate-editor]').first();
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'error',
    { timeout: 60_000 }
  );
  // The send's first try and its retry 30 s on: the wait is over.
  await expect.poll(() => draftSends(page), { timeout: 30_000 }).toBe(2);
  await expect(content).not.toContainText('Held steps.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { holdRoomJoins } = await import(path);
    holdRoomJoins(false);
  });
  await setReachable(page, true);
  await expect(content).toContainText('Held steps.', { timeout: 15_000 });
  await expect(content).toHaveAttribute('contenteditable', 'true');
  // The next retry is a minute out.
  await expect.poll(() => draftSends(page), { timeout: 10_000 }).toBe(3);
});

// Q360: a send that settles before the 30 s with its group not taken (the
// room never assigned its ids) opens the steps copy-only instead of letting
// them vanish, reported once as held.
test('a note whose draft send leaves its group opens the steps copy-only', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await answerDrafts(page, 'unassigned');
  await page.goto(note);
  await setReachable(page, true);
  const recovery = page.getByTestId('note-recovery');
  await expect(recovery).toContainText('Held steps.', { timeout: 25_000 });
  await expect(recovery.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect
    .poll(() => reportedIncidents(page))
    .toContainEqual(
      expect.objectContaining({
        fileId: 'mock-scenario-note',
        kind: 'other_epoch_draft',
        reason: 'held',
      })
    );
});

test('edits from a room that moved on open read-only for copying until Reload', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openNote(page);
  const banner = page.getByTestId('save-banner');
  const recovery = page.getByTestId('note-recovery');
  const editor = page.locator('[contenteditable="true"]').first();
  // Offline edits, then the service discards unsaved room state while this
  // tab is away.
  const moveWhileOffline = async (text: string) => {
    await setOnline(page, false);
    await type(page, text);
    await expect.poll(() => storedDrafts(page)).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const path = '/src/mocks/collaboration.ts';
      const { moveMockMaterialRoom } = await import(path);
      moveMockMaterialRoom('mock-scenario-note', true);
    });
    await setOnline(page, true);
  };
  const shown = async (text: string) => {
    await expect(banner).toHaveAttribute('data-kind', 'changed', {
      timeout: 30_000,
    });
    await expect(recovery).toContainText(text);
    await expect(recovery.locator('[contenteditable="true"]')).toHaveCount(0);
    // Reload is the only way out.
    await expect(banner.getByRole('button')).toHaveCount(1);
    await expect(
      banner.getByRole('button', { name: m.error_action_reload() })
    ).toBeVisible();
  };

  // Reload straight from recovery opens the live note with no stale offline
  // banner from the editor that went before.
  await moveWhileOffline(' Copied first.');
  await shown(' Copied first.');
  // Entering recovery from another lineage is an editing incident.
  await expect
    .poll(() => reportedIncidents(page))
    .toContainEqual(
      expect.objectContaining({
        fileId: 'mock-scenario-note',
        fileKind: 'material',
        kind: 'other_epoch_draft',
        reason: 'reopen',
      })
    );
  await banner.getByRole('button', { name: m.error_action_reload() }).click();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(editor).not.toContainText('Copied first.');
  await expect(banner).toHaveCount(0);
  await expect.poll(() => storedDrafts(page)).toBe(0);

  await moveWhileOffline(' Kept for copying.');
  await shown('Kept for copying.');
  await shot(page, 'recovery');
  // Never merged: a reload shows the same recovery.
  await page.evaluate(() => localStorage.setItem('capy.theme', 'mocha'));
  await page.reload();
  await shown('Kept for copying.');
  await shot(page, 'recovery-dark');
  await page.evaluate(() => localStorage.setItem('capy.theme', 'latte'));

  await banner.getByRole('button', { name: m.error_action_reload() }).click();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(editor).not.toContainText('Kept for copying.');
  await expect(banner).toHaveCount(0);
  await expect.poll(() => storedDrafts(page)).toBe(0);
});

test('an editor refused as outdated stays read-only with its edits kept, which the reloaded page saves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNote(page);
  await typeSaved(page, ' Saved first.');
  // The deploy: the service goes away while this tab types (nothing is
  // saved), then refuses this build when the tab joins again.
  await setReachable(page, false);
  await type(page, ' Typed before the update.');
  await expect.poll(() => storedDrafts(page)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseThisBuild } = await import(path);
    refuseThisBuild();
  });
  await setReachable(page, true);
  const banner = page.locator(
    '[data-testid="save-banner"][data-kind="outdated"]'
  );
  await expect(banner).toContainText(m.editor_outdated());
  const content = page.locator('[data-slate-editor]').first();
  await expect(content).toHaveAttribute('contenteditable', 'false');
  await expect(content).toContainText('Typed before the update.');
  const stored = await storedDrafts(page);
  expect(stored).toBeGreaterThan(0);
  // The next page change loads the new app.
  expect(
    await page.evaluate(async () => {
      const path = '/src/lib/appRelease.ts';
      const { takeUpdateLoad } = await import(path);
      return takeUpdateLoad();
    })
  ).toBe(true);
  await shot(page, 'outdated');
  await page.setViewportSize({ height: 740, width: 360 });
  await shot(page, 'outdated-360');
  await page.setViewportSize({ height: 720, width: 1280 });
  // The same app is still served (the new one is being published): Reload
  // waits, and nothing was sent or deleted meanwhile.
  await banner.getByRole('button', { name: m.error_action_reload() }).click();
  await expect(banner).toContainText(m.editor_outdated_publishing());
  expect(await storedDrafts(page)).toBe(stored);

  // The reloaded page (the new build) applies the edits and saves them.
  await page.reload();
  await expect(page.locator('[contenteditable="true"]').first()).toContainText(
    'Typed before the update.',
    { timeout: 30_000 }
  );
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await expect.poll(() => storedDrafts(page)).toBe(0);
});

test('a source refused as outdated keeps its stored edits and leaves without a prompt', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios?file=mock-scenario-text&mode=edit');
  const input = page.getByRole('textbox', { name: m.source_edit_raw() });
  await expect(input).not.toHaveValue('', { timeout: 30_000 });
  // Unsaved: the room holds the receipts back, as a busy store does.
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { holdSourceSaveReceipts } = await import(path);
    holdSourceSaveReceipts(true);
  });
  await input.fill(`${await input.inputValue()}\nTyped before the update.`);
  const fileRows = () =>
    page.evaluate(async () => {
      const draftsPath = '/src/lib/editDrafts.ts';
      const dbPath = '/src/mocks/db.ts';
      const { draftKey, readDrafts } = await import(draftsPath);
      const { user } = await import(dbPath);
      return (await readDrafts(draftKey(user.id, 'file', 'mock-scenario-text')))
        .length;
    });
  await expect.poll(fileRows).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseThisBuild } = await import(path);
    refuseThisBuild();
  });
  await expect(
    page.locator('[data-testid="save-banner"][data-kind="outdated"]')
  ).toContainText(m.editor_outdated());
  expect(await fileRows()).toBeGreaterThan(0);
  // The edits are on this device for the reloaded page: leaving asks nothing.
  const prompted = await page.evaluate(() => {
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    return leaving.defaultPrevented;
  });
  expect(prompted).toBe(false);
  // The next page change loads the new app.
  expect(
    await page.evaluate(async () => {
      const path = '/src/lib/appRelease.ts';
      const { takeUpdateLoad } = await import(path);
      return takeUpdateLoad();
    })
  ).toBe(true);
});
