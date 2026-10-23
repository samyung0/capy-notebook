import { expect, type Page, test } from '@playwright/test';

// The late path (in-place GC): a tab away past the room's collection window
// is answered late when it comes back. Its editor stays on screen paused, a
// new editor fetches the current note, the Rust merge (WASM, in a worker)
// places the tab's unsent edits onto it, and the new editor swaps in with
// every word once. The scenario note keeps its room and drafts (MSW).
const MATERIAL = 'mock-scenario-note';
const note = `/workspaces/ws_scenarios?material=${MATERIAL}&mode=edit`;
const seed = 'A note for trying application errors.';
const OFFLINE = ' Written while away.';
const PEER = 'A block from another tab.';

const MOCK = '/src/mocks/collaboration.ts';

async function setReachable(page: Page, reachable: boolean) {
  await page.evaluate(
    async ({ path, value }) => {
      const { setCollaborationReachable } = await import(path);
      setCollaborationReachable(value);
    },
    { path: MOCK, value: reachable }
  );
}

async function lateSessions(
  page: Page,
  materialId: string | null,
  every = false
) {
  await page.evaluate(
    async ({ all, path, value }) => {
      const collaboration = await import(path);
      collaboration.lateSessions(value, all);
    },
    { all: every, path: MOCK, value: materialId }
  );
}

/** Another tab in the note's room (left on `window` for later steps). */
async function joinPeer(page: Page) {
  await page.evaluate(
    async ({ path, value }) => {
      const { mockNotePeer } = await import(path);
      Object.assign(window, { latePeer: mockNotePeer(value) });
    },
    { path: MOCK, value: MATERIAL }
  );
}

async function peerAppends(page: Page, text: string) {
  await page.evaluate((value) => {
    const { latePeer } = window as unknown as {
      latePeer: { append: (blocks: unknown[]) => void };
    };
    latePeer.append([
      { children: [{ text: value }], id: 'late-peer', type: 'p' },
    ]);
  }, text);
}

/** The scenario room's text now (null while no room is open). */
function roomText(page: Page) {
  return page.evaluate(
    async ({ path, value }) => {
      const { mockNoteRoomText } = await import(path);
      return mockNoteRoomText(value) as string | null;
    },
    { path: MOCK, value: MATERIAL }
  );
}

/** Every late merge's request waits in the page until the test calls
 * `releaseLateMerge` (never, for a merge that must run out of time). */
async function holdMerges(page: Page) {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('lateMerge.worker')) return;
        const post = this.postMessage.bind(this);
        this.postMessage = (...args: Parameters<Worker['postMessage']>) => {
          Object.assign(window, { releaseLateMerge: () => post(...args) });
        };
      }
    };
  });
}

/** Once the new session joined, its room lacks the offline words: the
 * stored late rows wait for the merge, never applied raw. */
async function roomLacksOfflineWords(page: Page) {
  await expect.poll(() => roomText(page), { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(1000);
  expect(await roomText(page)).not.toContain(OFFLINE.trim());
}

function mergeHeld(page: Page) {
  return page.waitForFunction(() => 'releaseLateMerge' in window, undefined, {
    timeout: 30_000,
  });
}

async function peerLeaves(page: Page) {
  await page.evaluate(() => {
    const { latePeer } = window as unknown as {
      latePeer: { leave: () => void };
    };
    latePeer.leave();
  });
}

test('a late tab merges its unsent edits into the current note and swaps without losing or doubling text', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');

  // Another tab stays in the room while this one loses it and edits.
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);

  // The room collected past this session: its rejoin is answered late, and
  // only a new session joins.
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  const editor = live.locator('[contenteditable="true"]');
  await expect(editor).toContainText(PEER);
  await expect(editor).toContainText(OFFLINE.trim());
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  expect(workers.some((url) => url.includes('lateMerge.worker'))).toBe(true);
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(PEER).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });

  // A new session: its Undo holds nothing, so Ctrl+Z keeps the merged words.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText(OFFLINE.trim());

  // The room holds them: a reload shows both, once.
  await lateSessions(page, null);
  await peerLeaves(page);
  await page.reload();
  const reloaded = page.locator('[contenteditable="true"]').first();
  await expect(reloaded).toContainText(PEER, { timeout: 30_000 });
  const after = await reloaded.innerText();
  expect(after.split(OFFLINE.trim()).length - 1).toBe(1);
});

test('a late merge that cannot finish keeps the edits read-only for copying, never dropping them', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  // The new session is answered late too: the merge cannot run.
  await lateSessions(page, MATERIAL, true);
  await setReachable(page, true);
  const recovery = page.getByTestId('note-recovery');
  await expect(recovery).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(
    page.locator('[data-testid="save-banner"][data-kind="refused"]')
  ).toBeVisible();
  // Kept on this device across a reload, still for copying.
  await page.reload();
  await expect(page.getByTestId('note-recovery')).toContainText(
    OFFLINE.trim(),
    { timeout: 30_000 }
  );
  await lateSessions(page, null);
});

test('a reload during the merge keeps the edits: the reloaded editor merges its stored late row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  // Another tab changes the note meanwhile and leaves, so the room stores
  // it (the mock room keeps its document across a reload only once stored);
  // the new session's first sync changes the value.
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);
  await peerLeaves(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await roomLacksOfflineWords(page);
  await mergeHeld(page);
  // A peer edits while the merge waits; past the checkpoint debounce no
  // receipt may have dropped the row.
  await joinPeer(page);
  await peerAppends(page, 'A block typed during the merge.');
  await page.waitForTimeout(2500);

  // The reloaded page joins (a new session); only the stored late row holds
  // the words, and it is merged, never applied raw: the room lacks them
  // while the merge waits.
  await page.reload();
  await roomLacksOfflineWords(page);
  await mergeHeld(page);
  await page.evaluate(() =>
    (window as unknown as { releaseLateMerge: () => void }).releaseLateMerge()
  );
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(editor).toContainText(PEER);
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
});

test('a merge past its deadline keeps the edits read-only for copying', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  // The merge never answers: 10 s after it started the tab stops it.
  await mergeHeld(page);
  await expect(page.getByTestId('note-recovery')).toContainText(
    OFFLINE.trim(),
    { timeout: 30_000 }
  );
  await expect(
    page.locator('[data-testid="save-banner"][data-kind="refused"]')
  ).toBeVisible();
  await lateSessions(page, null);
});
